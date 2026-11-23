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
import { readConfig } from '../src/config';
import { sign } from '../src/signature';
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
            set: (key: string, value: string) =>
                count(() => {
                    if (options.noEncryptionKey)
                        throw new Error(ENCRYPTION_ERROR);
                    settings.set(key, value);
                }),
            delete: (key: string) => count(() => settings.delete(key))
        },
        kv: {
            get: (key: string) => count(() => kv.get(key) ?? null),
            set: (key: string, value: unknown) =>
                count(() => {
                    kv.set(key, structuredClone(value));
                }),
            delete: (key: string) => count(() => kv.delete(key))
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
        expect(Object.fromEntries(fake.settings)).toEqual(NEW);
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
        // kv read, exchange, 2 settings, websiteId, confirm, state.
        expect(fake.calls()).toBe(7);
    });

    it('stores the keys in plain KV when the site has no encryption key', async () => {
        const fake = fakeContext({ noEncryptionKey: true });
        const { callback } = await start(fake);

        await handleConnectCallback(fake.ctx, callback);

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

    it('stays within 9 calls when the confirm call fails, and queues a retry', async () => {
        const fake = fakeContext({
            settings: OLD,
            confirm: [new Error('network')]
        });
        const { callback } = await start(fake);

        await handleConnectCallback(fake.ctx, callback);

        // The new keys are stored. Aranx accepts both until the confirm.
        expect(Object.fromEntries(fake.settings)).toEqual(NEW);
        expect(fake.kv.get('connect')).toMatchObject({
            status: 'pending',
            confirmationId: 'confirmation-1'
        });
        expect(fake.tasks.map((task) => task.data)).toEqual([
            { kind: 'confirm' }
        ]);
        expect(fake.calls()).toBeLessThanOrEqual(9);
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

    it('removes a half-written settings pair before it falls back to KV', async () => {
        const fake = fakeContext({ settings: OLD });
        const { callback } = await start(fake);
        const set = fake.ctx.settings.set.bind(fake.ctx.settings);
        fake.ctx.settings.set = (key: string, value: unknown) =>
            key === 'webhookSecret'
                ? Promise.reject(new Error('write failed'))
                : set(key, value);

        await handleConnectCallback(fake.ctx, callback);

        // A new key next to the old secret would break the webhook.
        expect(fake.settings.has('apiKey')).toBe(false);
        expect(await readConfig(fake.ctx)).toMatchObject({
            ...NEW,
            storage: 'kv'
        });
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
        expect(Object.fromEntries(fake.settings)).toEqual(NEW);
        expect(fake.kv.get('connect')).toMatchObject({ status: 'connected' });
        expect(fake.calls()).toBeLessThanOrEqual(9);
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
});

describe('manual setup', () => {
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

        const clicked = await host.admin.act('/status', 'connect');
        expect(clicked.navigate).toMatchObject({ kind: 'external' });
        const approve = new URL(
            (clicked.navigate as { kind: 'external'; url: string }).url
        );
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
