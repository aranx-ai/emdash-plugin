import { afterEach, describe, expect, it } from 'vitest';
import {
    createPluginRuntimeTestHost,
    type PluginRuntimeTestHost
} from '@emdash-cms/plugin-test';
import type { PluginContext } from 'emdash/plugin';
import {
    ARANX_APPROVE_URL,
    ARANX_CONNECT_API,
    PLUGIN_VERSION,
    handleConnectCallback,
    pkceChallenge,
    runConfirmTask,
    runRotateTask,
    startConnect
} from '../src/connect';
import { handleAdmin } from '../src/admin';
import { readConfig } from '../src/config';
import { sign } from '../src/signature';
import { runTermsTask } from '../src/sync';
import { handleWebhook } from '../src/webhook';
import pkg from '../package.json' with { type: 'json' };

const SITE = 'https://site.example';
const OLD = { apiKey: 'arx_sk_old', webhookSecret: 'arx_whsec_old' };
const NEW = { apiKey: 'arx_sk_new', webhookSecret: 'arx_whsec_new' };
const GRANT = {
    api_key: NEW.apiKey,
    webhook_secret: NEW.webhookSecret,
    website_id: 'website-1',
    confirmation_id: 'confirmation-1'
};
const ENCRYPTION_ERROR = 'Plugin secret settings require EMDASH_ENCRYPTION_KEY';
/** The one setting that the connection flow writes. */
const stored = (pair: typeof NEW) => ({ credentials: JSON.stringify(pair) });

interface FakeOptions {
    /** The site has no EMDASH_ENCRYPTION_KEY. */
    noEncryptionKey?: boolean;
    settings?: Record<string, string>;
    kv?: Record<string, unknown>;
    /** Answers by path, in order. The last one repeats. */
    exchange?: Array<Response | Error>;
    confirm?: Array<Response | Error>;
}

const ok = (body: unknown) => () =>
    new Response(JSON.stringify(body), {
        status: 200,
        headers: { 'content-type': 'application/json' }
    });
const refused = (status: number, error: string) =>
    new Response(JSON.stringify({ error }), { status });

/**
 * A context that counts every call the sandbox would count as a
 * subrequest: each `ctx.*` bridge call and each `ctx.http.fetch`.
 */
function fakeContext(options: FakeOptions = {}) {
    const settings = new Map(Object.entries(options.settings ?? {}));
    const kv = new Map(Object.entries(options.kv ?? {}));
    const requests: Array<{ url: string; init: RequestInit }> = [];
    const tasks: Array<{ name: string; data: unknown }> = [];
    const kvReads: string[] = [];
    const settingWrites: string[] = [];
    const answers = {
        exchange: [...(options.exchange ?? [ok(GRANT)()])],
        confirm: [...(options.confirm ?? [ok({ status: 'confirmed' })()])]
    };
    let calls = 0;
    const count = <T>(run: () => T | Promise<T>): Promise<T> => {
        calls += 1;
        return Promise.resolve().then(run);
    };

    const ctx = {
        plugin: { id: 'aranx' },
        site: { name: 'Site', url: SITE },
        url: (path: string) => `${SITE}${path}`,
        settings: {
            list: () =>
                count(() =>
                    [...settings].map(([key, value]) => ({ key, value }))
                ),
            get: (key: string) => count(() => settings.get(key) ?? null),
            set: (key: string, value: string) =>
                count(() => {
                    settingWrites.push(key);
                    if (options.noEncryptionKey)
                        throw new Error(ENCRYPTION_ERROR);
                    settings.set(key, value);
                }),
            delete: (key: string) => count(() => settings.delete(key))
        },
        kv: {
            get: (key: string) =>
                count(() => {
                    kvReads.push(key);
                    return kv.get(key) ?? null;
                }),
            set: (key: string, value: unknown) =>
                count(() => {
                    kv.set(key, structuredClone(value));
                }),
            delete: (key: string) => count(() => kv.delete(key)),
            list: () =>
                count(() =>
                    [...kv].map(([key, value]) => ({
                        key,
                        value: structuredClone(value)
                    }))
                )
        },
        storage: {
            articles: {
                count: () => count(() => 0),
                query: () => count(() => ({ items: [], hasMore: false }))
            }
        },
        cron: {
            schedule: (name: string, input: { data?: unknown }) =>
                count(() => {
                    tasks.push({ name, data: input.data });
                })
        },
        http: {
            fetch: (url: string, init: RequestInit) =>
                count(() => {
                    requests.push({ url, init });
                    const queue = url.endsWith('/exchange')
                        ? answers.exchange
                        : answers.confirm;
                    const answer =
                        queue.length > 1 ? queue.shift()! : queue[0]!;
                    if (answer instanceof Error) throw answer;
                    return answer.clone();
                })
        },
        log: { warn: () => count(() => undefined) }
    } as unknown as PluginContext;

    return {
        ctx,
        settings,
        kv,
        requests,
        tasks,
        kvReads,
        settingWrites,
        calls: () => calls,
        resetCalls: () => {
            calls = 0;
        },
        body: (index: number) =>
            JSON.parse(String(requests[index]!.init.body)) as Record<
                string,
                unknown
            >,
        auth: (index: number) =>
            (requests[index]!.init.headers as Record<string, string>)
                .Authorization
    };
}

/** Clicks "Connect to Aranx" and returns the query Aranx would send back. */
async function start(fake: ReturnType<typeof fakeContext>) {
    const url = new URL(await startConnect(fake.ctx));
    fake.resetCalls();
    return {
        url,
        callback: { code: 'code-1', state: url.searchParams.get('state')! }
    };
}

describe('connect start', () => {
    it('opens the fixed Aranx page with a PKCE challenge and this site as the return address', async () => {
        const fake = fakeContext();
        const { url } = await start(fake);

        expect(`${url.origin}${url.pathname}`).toBe(ARANX_APPROVE_URL);
        expect(url.searchParams.get('site_url')).toBe(SITE);
        expect(url.searchParams.get('redirect_uri')).toBe(
            `${SITE}/_emdash/api/plugins/aranx/connect`
        );
        const stored = fake.kv.get('connect') as Record<string, string>;
        expect(stored.status).toBe('started');
        expect(url.searchParams.get('code_challenge')).toBe(
            await pkceChallenge(stored.verifier)
        );
        // The verifier never leaves the site.
        expect(url.toString()).not.toContain(stored.verifier);
    });

    it('reports the version in package.json', () => {
        expect(PLUGIN_VERSION).toBe(pkg.version);
    });
});

describe('connect callback', () => {
    it('stores the keys encrypted, confirms with the new key, and stays under the subrequest limit', async () => {
        const fake = fakeContext({ settings: OLD });
        const { callback } = await start(fake);
        const verifier = (fake.kv.get('connect') as { verifier: string })
            .verifier;

        const response = await handleConnectCallback(fake.ctx, callback);

        expect(fake.requests.map((request) => request.url)).toEqual([
            `${ARANX_CONNECT_API}/exchange`,
            `${ARANX_CONNECT_API}/confirm`
        ]);
        expect(fake.body(0)).toMatchObject({
            authorization_code: 'code-1',
            code_verifier: verifier,
            site_url: SITE
        });
        // The confirm call proves that the site holds the new key.
        expect(fake.auth(1)).toBe(`Bearer ${NEW.apiKey}`);
        expect(fake.body(1).confirmation_id).toBe('confirmation-1');
        // One write holds both values. The pasted pair stays where it was.
        expect(fake.settingWrites).toEqual(['credentials']);
        expect(Object.fromEntries(fake.settings)).toEqual({
            ...OLD,
            ...stored(NEW)
        });
        expect(await readConfig(fake.ctx)).toMatchObject({
            ...NEW,
            storage: 'settings'
        });
        fake.resetCalls();
        expect(fake.kv.has('credentials')).toBe(false);
        expect(fake.kv.get('websiteId')).toBe('website-1');
        expect(fake.kv.get('connect')).toMatchObject({
            status: 'connected',
            storage: 'settings',
            verifier: null
        });
        expect(JSON.stringify(response)).toContain(
            '/_emdash/admin/plugins/aranx/status'
        );
        expect(fake.calls()).toBe(0);
    });

    it('makes 9 calls on a site with an encryption key', async () => {
        const fake = fakeContext({ settings: OLD });
        const { callback } = await start(fake);

        await handleConnectCallback(fake.ctx, callback);

        // State read, exchange, website ID read, setting write, read back,
        // website ID write, confirm, state write, plain pair delete.
        expect(fake.calls()).toBe(9);
    });

    it('stores the keys in plain KV when the site has no encryption key', async () => {
        const fake = fakeContext({ noEncryptionKey: true });
        const { callback } = await start(fake);

        await handleConnectCallback(fake.ctx, callback);

        // The sandbox allows 10 subrequests per call. This is the longest
        // path: both stores and both reads, and the first website ID.
        expect(fake.calls()).toBe(10);
        expect(fake.settings.size).toBe(0);
        expect(fake.kv.get('credentials')).toEqual(NEW);
        expect(fake.kv.get('connect')).toMatchObject({
            status: 'connected',
            storage: 'kv'
        });
        expect(await readConfig(fake.ctx)).toMatchObject({
            ...NEW,
            storage: 'kv'
        });
        expect(fake.auth(1)).toBe(`Bearer ${NEW.apiKey}`);
    });

    it.each([
        ['refuses the confirm', refused(400, 'invalid_or_expired_authorization')],
        ['is unreachable', new Error('network')]
    ])(
        'stays within 10 calls without an encryption key when Aranx %s',
        async (_name, answer) => {
            const fake = fakeContext({
                noEncryptionKey: true,
                confirm: [answer]
            });
            const { callback } = await start(fake);

            await handleConnectCallback(fake.ctx, callback);

            expect(fake.calls()).toBeLessThanOrEqual(10);
        }
    );

    it('leaves the confirm pending when Aranx is unreachable, and the admin page queues the retry', async () => {
        const fake = fakeContext({
            settings: OLD,
            confirm: [new Error('network')]
        });
        const { callback } = await start(fake);

        await handleConnectCallback(fake.ctx, callback);

        expect(await readConfig(fake.ctx)).toMatchObject(NEW);
        expect(fake.kv.get('connect')).toMatchObject({
            status: 'pending',
            confirmationId: 'confirmation-1'
        });
        expect(fake.tasks).toHaveLength(0);

        // The callback redirects to the admin page.
        await handleAdmin(fake.ctx, { type: 'page_load' });
        expect(fake.tasks.map((task) => task.data)).toEqual([
            { kind: 'confirm' }
        ]);
    });

    it('tells the admin to connect again when Aranx refuses the confirm after the store', async () => {
        const fake = fakeContext({
            settings: OLD,
            confirm: [refused(400, 'invalid_or_expired_authorization')]
        });
        const { callback } = await start(fake);

        await handleConnectCallback(fake.ctx, callback);

        expect(fake.kv.get('connect')).toMatchObject({ status: 'failed' });
        const page = JSON.stringify(
            await handleAdmin(fake.ctx, { type: 'page_load' })
        );
        expect(page).toContain('Connect to Aranx again');
        // The new pair replaced the old one, and Aranx refused it.
        expect(page).not.toContain('still work');
        expect(fake.tasks).toHaveLength(0);
    });

    it('fails before the store when this site is bound to another Aranx website', async () => {
        const fake = fakeContext({
            settings: OLD,
            kv: { websiteId: 'website-2' }
        });
        const { callback } = await start(fake);

        await handleConnectCallback(fake.ctx, callback);

        expect(Object.fromEntries(fake.settings)).toEqual(OLD);
        expect(fake.kv.get('websiteId')).toBe('website-2');
        expect(fake.kv.get('connect')).toMatchObject({
            status: 'failed',
            error: expect.stringContaining('another Aranx website')
        });
        // No confirm: Aranx keeps the keys of website-2 as they are.
        expect(fake.requests.map((request) => request.url)).toEqual([
            `${ARANX_CONNECT_API}/exchange`
        ]);
    });

    it('deletes a plain-text pair left in KV once the encrypted pair is confirmed', async () => {
        const fake = fakeContext({ kv: { credentials: OLD } });
        const { callback } = await start(fake);

        await handleConnectCallback(fake.ctx, callback);

        expect(fake.kv.has('credentials')).toBe(false);
        expect(await readConfig(fake.ctx)).toMatchObject({
            ...NEW,
            storage: 'settings'
        });
    });

    it('keeps the plain-text pair while the confirm is pending', async () => {
        const fake = fakeContext({
            kv: { credentials: OLD },
            confirm: [new Error('network')]
        });
        const { callback } = await start(fake);

        await handleConnectCallback(fake.ctx, callback);

        expect(fake.kv.get('credentials')).toEqual(OLD);
    });

    it('keeps the old keys when the exchange fails', async () => {
        const fake = fakeContext({
            settings: OLD,
            exchange: [refused(400, 'invalid_or_expired_authorization')]
        });
        const { callback } = await start(fake);

        await handleConnectCallback(fake.ctx, callback);

        expect(Object.fromEntries(fake.settings)).toEqual(OLD);
        expect(fake.kv.get('connect')).toMatchObject({ status: 'failed' });
        expect(fake.requests).toHaveLength(1);
        expect(
            JSON.stringify(await handleAdmin(fake.ctx, { type: 'page_load' }))
        ).not.toContain('still work');
    });

    it('ignores a callback with another state, and makes no request', async () => {
        const fake = fakeContext({ settings: OLD });
        await start(fake);

        await handleConnectCallback(fake.ctx, {
            code: 'attacker-code',
            state: 'another-state'
        });

        expect(fake.requests).toHaveLength(0);
        expect(Object.fromEntries(fake.settings)).toEqual(OLD);
        // The start still waits for its own callback.
        expect(fake.kv.get('connect')).toMatchObject({ status: 'started' });
    });

    it('ignores a callback when no connection was started', async () => {
        const fake = fakeContext({ settings: OLD });

        await handleConnectCallback(fake.ctx, { code: 'c', state: 's' });

        expect(fake.requests).toHaveLength(0);
        expect(fake.calls()).toBe(1);
    });

    it('refuses a callback that arrives more than 15 minutes after the start', async () => {
        const fake = fakeContext({ settings: OLD });
        const { callback } = await start(fake);

        await handleConnectCallback(
            fake.ctx,
            callback,
            Date.now() + 16 * 60 * 1000
        );

        expect(fake.requests).toHaveLength(0);
        expect(fake.kv.get('connect')).toMatchObject({ status: 'failed' });
    });

    it('uses a code once: the second callback finds no started state', async () => {
        const fake = fakeContext();
        const { callback } = await start(fake);
        await handleConnectCallback(fake.ctx, callback);

        await handleConnectCallback(fake.ctx, callback);

        expect(fake.requests).toHaveLength(2);
    });

    it('records a cancel in Aranx and keeps the old keys', async () => {
        const fake = fakeContext({ settings: OLD });
        const { callback } = await start(fake);

        await handleConnectCallback(fake.ctx, {
            state: callback.state,
            error: 'access_denied'
        });

        expect(fake.requests).toHaveLength(0);
        expect(Object.fromEntries(fake.settings)).toEqual(OLD);
        expect(fake.kv.get('connect')).toMatchObject({
            status: 'failed',
            error: 'The connection was canceled in Aranx.'
        });
    });

    it('fails before the confirm when the setting write fails for another reason', async () => {
        const fake = fakeContext({ settings: OLD });
        const { callback } = await start(fake);
        fake.ctx.settings.set = () => Promise.reject(new Error('D1 is busy'));

        await handleConnectCallback(fake.ctx, callback);

        // No fallback to KV: the settings win there, so the plugin would
        // confirm a pair it does not use.
        expect(fake.kv.has('credentials')).toBe(false);
        expect(await readConfig(fake.ctx)).toMatchObject(OLD);
        expect(fake.kv.get('connect')).toMatchObject({
            status: 'failed',
            error: expect.stringContaining('D1 is busy')
        });
        expect(fake.requests.map((request) => request.url)).toEqual([
            `${ARANX_CONNECT_API}/exchange`
        ]);
    });

    it('does not confirm a plain KV pair that pasted settings would hide', async () => {
        // The encryption key went away after a manual setup. The settings
        // still win over KV, so the new pair would never be used.
        const fake = fakeContext({ noEncryptionKey: true, settings: OLD });
        const { callback } = await start(fake);

        await handleConnectCallback(fake.ctx, callback);

        expect(fake.requests.map((request) => request.url)).toEqual([
            `${ARANX_CONNECT_API}/exchange`
        ]);
        expect(fake.kv.get('connect')).toMatchObject({ status: 'failed' });
    });
});

describe('Aranx key rotation', () => {
    it('trades the code from the webhook for new keys without a verifier', async () => {
        const fake = fakeContext({ settings: OLD });

        await runRotateTask(fake.ctx, 'rotation-code');

        expect(fake.body(0)).toEqual({
            authorization_code: 'rotation-code',
            site_url: SITE,
            plugin_version: PLUGIN_VERSION
        });
        expect(fake.auth(1)).toBe(`Bearer ${NEW.apiKey}`);
        expect(await readConfig(fake.ctx)).toMatchObject(NEW);
        expect(fake.kv.get('connect')).toMatchObject({ status: 'connected' });
    });

    it('stays within 10 calls on its longest path, and queues the confirm retry', async () => {
        const fake = fakeContext({
            noEncryptionKey: true,
            kv: { websiteId: 'website-1', credentials: OLD },
            confirm: [new Error('network')]
        });

        await runRotateTask(fake.ctx, 'rotation-code');

        expect(fake.kv.get('credentials')).toEqual(NEW);
        expect(fake.tasks.map((task) => task.data)).toEqual([
            { kind: 'confirm' }
        ]);
        // Exchange, website ID read, state, setting write, KV write, read
        // back (2), confirm, state, task.
        expect(fake.calls()).toBe(10);
    });

    it('stores nothing when the code belongs to another Aranx website', async () => {
        const fake = fakeContext({
            settings: OLD,
            kv: { websiteId: 'website-2' }
        });

        await runRotateTask(fake.ctx, 'rotation-code');

        expect(Object.fromEntries(fake.settings)).toEqual(OLD);
        expect(fake.requests).toHaveLength(1);
        expect(fake.kv.get('connect')).toMatchObject({ status: 'failed' });
    });

    it('keeps the old keys and does not retry when Aranx refuses the code', async () => {
        const fake = fakeContext({
            settings: OLD,
            exchange: [refused(400, 'invalid_or_expired_authorization')]
        });

        await expect(
            runRotateTask(fake.ctx, 'used-code')
        ).resolves.toBeUndefined();

        expect(Object.fromEntries(fake.settings)).toEqual(OLD);
        expect(fake.kv.has('connect')).toBe(false);
    });

    it('throws on a network error so EmDash retries the task', async () => {
        const fake = fakeContext({
            settings: OLD,
            exchange: [new Error('network')]
        });

        await expect(runRotateTask(fake.ctx, 'code')).rejects.toThrow();
        expect(Object.fromEntries(fake.settings)).toEqual(OLD);
    });

    it('queues the rotate task for a signed connection.rotate event', async () => {
        const fake = fakeContext({
            settings: OLD,
            kv: { websiteId: 'website-1' }
        });
        const body = JSON.stringify({
            event: 'connection.rotate',
            website_id: 'website-1',
            timestamp: new Date().toISOString(),
            rotation_code: 'rotation-code'
        });

        const response = await handleWebhook(fake.ctx, {
            method: 'POST',
            headers: {
                'x-webhook-signature': await sign(OLD.webhookSecret, body)
            },
            body: new TextEncoder().encode(body)
        });

        expect(JSON.stringify(response)).toContain('202');
        expect(fake.tasks.map((task) => task.data)).toEqual([
            { kind: 'rotate', code: 'rotation-code' }
        ]);
    });

    it('does not queue a rotation for an event signed with another secret', async () => {
        const fake = fakeContext({ settings: OLD });
        const body = JSON.stringify({
            event: 'connection.rotate',
            website_id: 'website-1',
            timestamp: new Date().toISOString(),
            rotation_code: 'forged'
        });

        const response = await handleWebhook(fake.ctx, {
            method: 'POST',
            headers: { 'x-webhook-signature': await sign('guess', body) },
            body: new TextEncoder().encode(body)
        });

        expect(JSON.stringify(response)).toContain('401');
        expect(fake.tasks).toHaveLength(0);
    });
});

describe('confirm retry', () => {
    const pending = {
        status: 'pending',
        at: new Date().toISOString(),
        confirmationId: 'confirmation-1',
        storage: 'settings'
    };

    it('confirms with the stored key and marks the connection as connected', async () => {
        const fake = fakeContext({ settings: NEW, kv: { connect: pending } });

        await runConfirmTask(fake.ctx);

        expect(fake.auth(0)).toBe(`Bearer ${NEW.apiKey}`);
        expect(fake.kv.get('connect')).toMatchObject({ status: 'connected' });
        expect(fake.calls()).toBeLessThanOrEqual(5);
    });

    it('deletes the plain-text pair after the retry confirms an encrypted pair', async () => {
        const fake = fakeContext({
            settings: stored(NEW),
            kv: { connect: pending, credentials: OLD }
        });

        await runConfirmTask(fake.ctx);

        expect(fake.kv.has('credentials')).toBe(false);
        expect(fake.calls()).toBeLessThanOrEqual(5);
    });

    it('keeps a plain-text pair that is the one in use', async () => {
        const fake = fakeContext({
            kv: { connect: { ...pending, storage: 'kv' }, credentials: NEW }
        });

        await runConfirmTask(fake.ctx);

        expect(fake.kv.get('credentials')).toEqual(NEW);
        expect(fake.kv.get('connect')).toMatchObject({ status: 'connected' });
    });

    it('tells the admin to connect again when Aranx refuses the retry', async () => {
        const fake = fakeContext({
            settings: stored(NEW),
            kv: { connect: pending },
            confirm: [refused(409, 'authorization_no_longer_current')]
        });

        await runConfirmTask(fake.ctx);

        expect(fake.kv.get('connect')).toMatchObject({
            status: 'failed',
            error: expect.stringContaining('Connect to Aranx again')
        });
    });

    it('throws while Aranx is unreachable, so EmDash retries', async () => {
        const fake = fakeContext({
            settings: NEW,
            kv: { connect: pending },
            confirm: [new Error('network')]
        });

        await expect(runConfirmTask(fake.ctx)).rejects.toThrow();
        expect(fake.kv.get('connect')).toMatchObject({ status: 'pending' });
    });

    it('does nothing when no confirm is pending', async () => {
        const fake = fakeContext({ settings: NEW });

        await runConfirmTask(fake.ctx);

        expect(fake.requests).toHaveLength(0);
    });
});

describe('webhook during a key change', () => {
    async function deliver(
        fake: ReturnType<typeof fakeContext>,
        secret: string
    ) {
        const body = JSON.stringify({
            event: 'test',
            website_id: 'website-1',
            timestamp: new Date().toISOString()
        });
        return JSON.stringify(
            await handleWebhook(fake.ctx, {
                method: 'POST',
                headers: { 'x-webhook-signature': await sign(secret, body) },
                body: new TextEncoder().encode(body)
            })
        );
    }

    it('answers 503 to the old secret while the confirm is pending, so Aranx retries', async () => {
        const fake = fakeContext({
            settings: NEW,
            kv: {
                connect: {
                    status: 'pending',
                    at: new Date().toISOString(),
                    confirmationId: 'confirmation-1'
                }
            }
        });

        expect(await deliver(fake, OLD.webhookSecret)).toContain('503');
        expect(await deliver(fake, NEW.webhookSecret)).toContain('200');
    });

    it('answers 401 to a wrong secret when no key change is in flight', async () => {
        const fake = fakeContext({ settings: NEW });

        expect(await deliver(fake, OLD.webhookSecret)).toContain('401');
    });

    it.each([
        ['503 for 5 minutes after the confirm', 4 * 60 * 1000, '503'],
        ['401 once 5 minutes have passed', 6 * 60 * 1000, '401']
    ])('answers %s to the old secret', async (_name, age, status) => {
        // Aranx signed the delivery just before it took the new secret.
        const fake = fakeContext({
            settings: NEW,
            kv: {
                connect: {
                    status: 'connected',
                    at: new Date(Date.now() - age).toISOString(),
                    confirmationId: 'confirmation-1'
                }
            }
        });

        expect(await deliver(fake, OLD.webhookSecret)).toContain(status);
    });
});

describe('admin page', () => {
    function link(response: unknown): { label: string; url: string } | null {
        const { blocks } = response as {
            blocks: Array<{
                type: string;
                elements?: Array<{
                    type: string;
                    label: string;
                    target?: { kind: string; url?: string };
                }>;
            }>;
        };
        const found = blocks
            .flatMap((block) => block.elements ?? [])
            .find((element) => element.target?.kind === 'external');
        return found ? { label: found.label, url: found.target!.url! } : null;
    }

    it('answers the Connect button with a link to the Aranx approval page', async () => {
        const fake = fakeContext();

        const response = await handleAdmin(fake.ctx, {
            type: 'block_action',
            action_id: 'connect'
        });

        // EmDash 1.4 ignores `navigate` on a plugin page, so the link is
        // what the admin clicks.
        expect(response).not.toHaveProperty('navigate');
        const approve = link(response);
        expect(approve?.label).toBe('Approve in Aranx');
        const url = new URL(approve!.url);
        expect(`${url.origin}${url.pathname}`).toBe(ARANX_APPROVE_URL);
        const started = fake.kv.get('connect') as { state: string };
        expect(url.searchParams.get('state')).toBe(started.state);
        expect((response as { toast: unknown }).toast).toEqual({
            type: 'info',
            message: 'Approve the connection in Aranx'
        });
    });

    it('does not start a connection on a page load', async () => {
        const fake = fakeContext();
        await handleAdmin(fake.ctx, {
            type: 'block_action',
            action_id: 'connect'
        });
        const started = structuredClone(fake.kv.get('connect'));

        // The same page opened in a second tab.
        const response = await handleAdmin(fake.ctx, { type: 'page_load' });

        expect(link(response)).toBeNull();
        expect(fake.kv.get('connect')).toEqual(started);
    });
});

describe('admin page budget', () => {
    it('syncs, retries the confirm, and drops plain keys within 10 calls', async () => {
        const fake = fakeContext({
            settings: stored(NEW),
            kv: {
                credentials: OLD,
                connect: {
                    status: 'pending',
                    at: new Date().toISOString(),
                    confirmationId: 'confirmation-1',
                    storage: 'kv'
                }
            }
        });
        Object.assign(fake.ctx, {
            schema: { getCollection: () => Promise.resolve(null) }
        });
        fake.resetCalls();

        await handleAdmin(fake.ctx, { type: 'block_action', action_id: 'sync' });

        // 2 reads, sync, confirm, plain-key delete, count, query.
        expect(fake.calls()).toBeLessThanOrEqual(10);
        expect(fake.tasks.map((task) => task.data)).toEqual([
            { kind: 'feed' },
            { kind: 'confirm' }
        ]);
    });

    it('disconnects within 10 calls and deletes every key', async () => {
        const fake = fakeContext({
            settings: { ...stored(NEW), ...OLD },
            kv: { credentials: OLD, websiteId: 'website-1' }
        });
        fake.resetCalls();

        const response = (await handleAdmin(fake.ctx, {
            type: 'block_action',
            action_id: 'disconnect'
        })) as { toast: unknown };

        expect(fake.calls()).toBeLessThanOrEqual(10);
        expect(response.toast).toEqual({
            type: 'success',
            message: 'Disconnected from Aranx'
        });
        expect([...fake.settings.keys()]).toEqual([]);
        expect(fake.kv.has('credentials')).toBe(false);
        expect(fake.kv.get('websiteId')).toBe('website-1');
        expect(fake.kv.get('connect')).toMatchObject({ status: 'disconnected' });
        expect(await readConfig(fake.ctx)).toMatchObject({
            apiKey: null,
            webhookSecret: null
        });
    });
});

describe('category task', () => {
    it('reads the taxonomy setting and not the keys', async () => {
        const fake = fakeContext({
            noEncryptionKey: true,
            settings: { taxonomy: 'topics' },
            kv: { credentials: NEW, categoryTerms: { 'category-1': 'term-1' } }
        });
        const assigned: unknown[][] = [];
        Object.assign(fake.ctx, {
            taxonomies: {
                getTerms: async () => [],
                createTerm: async () => ({ id: 'term-new' }),
                getEntryTerms: async () => [],
                addEntryTerms: async (...args: unknown[]) => {
                    assigned.push(args);
                },
                removeEntryTerms: async () => undefined
            }
        });

        await runTermsTask(fake.ctx, {
            kind: 'terms',
            articleId: 'article-1',
            entryId: 'entry-1',
            collection: 'posts',
            categories: [{ id: 'category-1', name: 'News', slug: 'news' }],
            requestedStatus: 'published'
        });

        expect(assigned).toEqual([['posts', 'entry-1', 'topics', ['term-1']]]);
        // On a plain KV site `readConfig` costs a second call here.
        expect(fake.kvReads).toEqual(['categoryTerms']);
    });
});

describe('manual setup', () => {
    it('prefers the pair from the connection flow over pasted settings', async () => {
        const fake = fakeContext({ settings: { ...OLD, ...stored(NEW) } });

        expect(await readConfig(fake.ctx)).toMatchObject({
            ...NEW,
            storage: 'settings'
        });
    });

    it('reads the pasted settings when the managed setting is not a pair', async () => {
        const fake = fakeContext({
            settings: { ...OLD, credentials: 'edited by hand' }
        });

        expect(await readConfig(fake.ctx)).toMatchObject(OLD);
    });

    it('reads keys pasted into the settings without a KV read', async () => {
        const fake = fakeContext({ settings: OLD });

        expect(await readConfig(fake.ctx)).toMatchObject({
            ...OLD,
            storage: 'settings'
        });
        expect(fake.calls()).toBe(1);
    });

    it('prefers pasted settings over plain keys left in KV', async () => {
        const fake = fakeContext({ settings: OLD, kv: { credentials: NEW } });

        expect(await readConfig(fake.ctx)).toMatchObject(OLD);
    });
});

describe('in the EmDash runtime', () => {
    let host: PluginRuntimeTestHost | undefined;

    afterEach(async () => {
        await host?.dispose();
        host = undefined;
    });

    it('connects from the admin button through the public callback route', async () => {
        host = await createPluginRuntimeTestHost({ site: { url: SITE } });
        await host.actions.plugin.activate();

        // The page EmDash renders after the click: validated Block Kit.
        const clicked = await host.admin.act('/status', 'connect');
        const links = clicked.blocks.flatMap((block) =>
            block.type === 'actions'
                ? block.elements.flatMap((element) =>
                      element.type === 'link' &&
                      element.target.kind === 'external'
                          ? [{ label: element.label, url: element.target.url }]
                          : []
                  )
                : []
        );
        expect(links.map((item) => item.label)).toEqual(['Approve in Aranx']);
        const approve = new URL(links[0]!.url);
        expect(approve.origin).toBe(new URL(ARANX_APPROVE_URL).origin);

        await host.http.respond(`${ARANX_CONNECT_API}/exchange`, ok(GRANT)());
        await host.http.respond(
            `${ARANX_CONNECT_API}/confirm`,
            ok({ status: 'confirmed' })()
        );
        const redirect = approve.searchParams.get('redirect_uri')!;
        const response = await host.actions.routes.request('connect', {
            method: 'GET',
            url: `${redirect}?code=code-1&state=${approve.searchParams.get('state')}`
        });

        expect(response.status).toBe(302);
        expect(response.headers.get('location')).toContain('/status');
        expect(
            host.http.requests().map((request) => request.url)
        ).toEqual([
            `${ARANX_CONNECT_API}/exchange`,
            `${ARANX_CONNECT_API}/confirm`
        ]);
        const connect = await host.inspect.kv.get<{
            status: string;
            storage: string;
        }>('connect');
        expect(connect?.status).toBe('connected');
        // The test runtime decides whether an encryption key exists. Either
        // way the plugin must read back the keys it stored.
        const page = await host.admin.loadPage('/status');
        expect(JSON.stringify(page.blocks)).toContain('Connected');
        expect(JSON.stringify(page.blocks)).toContain('Reconnect');
        if (connect?.storage === 'kv') {
            expect(JSON.stringify(page.blocks)).toContain(
                'stored without encryption'
            );
        }
    });
});
