import {
    pluginResponse,
    type PluginContext,
    type PluginResponse
} from 'emdash/plugin';
import {
    CREDENTIALS_SETTING,
    KEY_SETTINGS,
    encodeCredentials,
    readConfig,
    type SettingEntries
} from './config';
import {
    deletePlainCredentials,
    readConnectState,
    readWebsiteId,
    writeConnectState,
    writePlainCredentials,
    writeWebsiteId,
    type ConnectState,
    type StoredCredentials
} from './store';
import { scheduleTask } from './tasks';

/**
 * The connection to Aranx without copy and paste.
 *
 * 1. "Connect to Aranx" on the admin page stores a PKCE verifier and opens
 *    the Aranx approval page in a new tab.
 * 2. The user approves. Aranx sends the browser to the `connect` route with
 *    a one-time code.
 * 3. The route trades the code and the verifier for the API key and the
 *    webhook secret, stores them, and confirms to Aranx with the new key.
 *
 * Aranx keeps the old key and secret valid until the confirm call. A
 * failure before the new keys are stored leaves a connected site connected.
 * After that, a confirm that Aranx refuses leaves keys that do not work, and
 * the admin connects again. Aranx can also start step 3 itself ("Reconnect"
 * in Aranx): it sends a signed `connection.rotate` webhook that carries a
 * one-time code.
 *
 * The exchange and confirm calls go to a fixed Aranx origin, never to the
 * `apiBaseUrl` setting, which a site admin can edit.
 */

export const PLUGIN_VERSION = '0.2.0';
export const ARANX_APPROVE_URL = 'https://app.aranx.com/auth/emdash/consent';
export const ARANX_CONNECT_API = 'https://api.aranx.com/api/v1/auth/emdash';

/** Aranx codes expire after 10 minutes. The verifier is useless after that. */
const START_MAX_AGE_MS = 15 * 60 * 1000;
/** A webhook signed with the other secret gets a retry for this long. */
const IN_FLIGHT_MAX_AGE_MS = 60 * 60 * 1000;
/**
 * Aranx may have signed a delivery with the old secret just before the
 * confirm. It gets a retry for this long after the keys are confirmed.
 */
const CONFIRMED_GRACE_MS = 5 * 60 * 1000;

export function connectPath(pluginId: string): string {
    return `/_emdash/api/plugins/${encodeURIComponent(pluginId)}/connect`;
}

export function adminPagePath(pluginId: string): string {
    return `/_emdash/admin/plugins/${encodeURIComponent(pluginId)}/status`;
}

function base64Url(bytes: Uint8Array): string {
    let binary = '';
    for (const byte of bytes) binary += String.fromCharCode(byte);
    return btoa(binary)
        .replace(/\+/g, '-')
        .replace(/\//g, '_')
        .replace(/=+$/, '');
}

function randomToken(byteLength: number): string {
    return base64Url(crypto.getRandomValues(new Uint8Array(byteLength)));
}

/** The S256 PKCE challenge of a verifier. */
export async function pkceChallenge(verifier: string): Promise<string> {
    const digest = await crypto.subtle.digest(
        'SHA-256',
        new TextEncoder().encode(verifier)
    );
    return base64Url(new Uint8Array(digest));
}

function constantTimeEqual(a: string, b: string): boolean {
    let diff = a.length ^ b.length;
    for (let i = 0; i < a.length; i++)
        diff |= a.charCodeAt(i) ^ b.charCodeAt(i % (b.length || 1));
    return b.length > 0 && diff === 0;
}

function siteOrigin(ctx: PluginContext): string {
    return new URL(ctx.url('/')).origin;
}

/**
 * Starts a connection and returns the Aranx approval URL. 1 call.
 * A new start replaces the verifier of an earlier one.
 */
export async function startConnect(ctx: PluginContext): Promise<string> {
    const state = randomToken(16);
    const verifier = randomToken(32);
    await writeConnectState(ctx, {
        status: 'started',
        state,
        verifier,
        confirmationId: null,
        storage: null,
        error: null
    });
    const url = new URL(ARANX_APPROVE_URL);
    url.searchParams.set('site_url', siteOrigin(ctx));
    url.searchParams.set('site_name', ctx.site.name || siteOrigin(ctx));
    url.searchParams.set('redirect_uri', ctx.url(connectPath(ctx.plugin.id)));
    url.searchParams.set('state', state);
    url.searchParams.set('code_challenge', await pkceChallenge(verifier));
    url.searchParams.set('plugin_version', PLUGIN_VERSION);
    return url.toString();
}

class ConnectError extends Error {
    constructor(
        message: string,
        /** Aranx refused the request. A retry gets the same answer. */
        readonly final: boolean
    ) {
        super(message);
        this.name = 'ConnectError';
    }
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

async function post(
    ctx: PluginContext,
    path: string,
    body: Record<string, unknown>,
    apiKey?: string
): Promise<Record<string, unknown>> {
    if (!ctx.http)
        throw new ConnectError(
            'The network:request capability is not granted',
            true
        );
    const response = await ctx.http.fetch(`${ARANX_CONNECT_API}${path}`, {
        method: 'POST',
        headers: {
            Accept: 'application/json',
            'Content-Type': 'application/json',
            ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {})
        },
        body: JSON.stringify(body)
    });
    const data: unknown = await response.json().catch(() => null);
    if (!response.ok) {
        const code =
            isRecord(data) && typeof data.error === 'string' ? data.error : '';
        throw new ConnectError(
            `Aranx answered ${response.status}${code ? ` (${code})` : ''}`,
            response.status >= 400 &&
                response.status < 500 &&
                response.status !== 429
        );
    }
    if (!isRecord(data)) throw new ConnectError('Aranx sent no data', false);
    return data;
}

interface Grant extends StoredCredentials {
    websiteId: string;
    confirmationId: string;
}

async function exchange(
    ctx: PluginContext,
    code: string,
    verifier: string | null
): Promise<Grant> {
    const data = await post(ctx, '/exchange', {
        authorization_code: code,
        ...(verifier ? { code_verifier: verifier } : {}),
        site_url: siteOrigin(ctx),
        plugin_version: PLUGIN_VERSION
    });
    const { api_key, webhook_secret, website_id, confirmation_id } = data;
    if (
        typeof api_key !== 'string' ||
        typeof webhook_secret !== 'string' ||
        typeof website_id !== 'string' ||
        typeof confirmation_id !== 'string' ||
        !api_key ||
        !webhook_secret
    )
        throw new ConnectError('Aranx sent an incomplete answer', false);
    return {
        apiKey: api_key,
        webhookSecret: webhook_secret,
        websiteId: website_id,
        confirmationId: confirmation_id
    };
}

/**
 * Tells Aranx that this site stored the keys. Aranx then revokes the old
 * key and signs with the new secret. 1 call.
 */
async function confirm(
    ctx: PluginContext,
    apiKey: string,
    confirmationId: string
): Promise<void> {
    await post(
        ctx,
        '/confirm',
        { confirmation_id: confirmationId, plugin_version: PLUGIN_VERSION },
        apiKey
    );
}

/**
 * EmDash refuses a `secret` setting on a site without the
 * `EMDASH_ENCRYPTION_KEY` Worker secret. The sandbox bridge keeps the
 * message of that error and may drop its code.
 */
function isMissingEncryptionKey(error: unknown): boolean {
    if (typeof error !== 'object' || error === null) return false;
    const code = 'code' in error ? error.code : null;
    const text = 'message' in error ? error.message : null;
    return (
        code === 'PLUGIN_SETTING_ENCRYPTION_KEY_MISSING' ||
        (typeof text === 'string' && text.includes('EMDASH_ENCRYPTION_KEY'))
    );
}

/**
 * Stores the key and the secret as one encrypted `secret` setting, in one
 * write. On a site without `EMDASH_ENCRYPTION_KEY` the pair goes to plugin
 * KV in plain text, and the admin page says so. Any other write error is
 * thrown: the old pair stays in use and nothing is confirmed. 1 or 2 calls.
 */
export async function storeCredentials(
    ctx: PluginContext,
    credentials: StoredCredentials
): Promise<'settings' | 'kv'> {
    try {
        await ctx.settings.set(
            CREDENTIALS_SETTING,
            encodeCredentials(credentials)
        );
        return 'settings';
    } catch (error) {
        if (!isMissingEncryptionKey(error)) throw error;
        await writePlainCredentials(ctx, {
            apiKey: credentials.apiKey,
            webhookSecret: credentials.webhookSecret
        });
        return 'kv';
    }
}

function message(error: unknown): string {
    return error instanceof Error ? error.message : 'Unknown error';
}

const OTHER_WEBSITE =
    'This site is connected to another Aranx website. Approve the connection for that website.';

/**
 * Stores the keys, checks that the plugin reads them back, then confirms.
 * A confirm that fails for now leaves the state `pending`: the next request
 * with the new key confirms it, and so does the `confirm` task. A confirm
 * that Aranx refuses leaves keys that Aranx does not accept, so the admin
 * connects again. Up to 7 calls, 8 with `retry`.
 *
 * `pinned` is the website ID this site is bound to, already checked against
 * the grant.
 */
async function storeAndConfirm(
    ctx: PluginContext,
    grant: Grant,
    pinned: string | null,
    retry: 'task' | 'admin-page'
): Promise<ConnectState['status']> {
    const storage = await storeCredentials(ctx, grant); // 1 or 2
    // A request with the new key confirms the grant in Aranx. So the plugin
    // must select this pair, and no older one, before Aranx hears of it.
    const stored = await readConfig(ctx); // 1 or 2
    if (
        stored.apiKey !== grant.apiKey ||
        stored.webhookSecret !== grant.webhookSecret
    ) {
        throw new ConnectError(
            'The plugin does not read back the keys it stored. Remove the API key and the webhook secret from the plugin settings, then connect again.',
            true
        );
    }
    // One key and secret belong to one Aranx website.
    if (!pinned) await writeWebsiteId(ctx, grant.websiteId); // 1
    const next = {
        state: null,
        verifier: null,
        confirmationId: grant.confirmationId,
        storage,
        error: null
    };
    try {
        await confirm(ctx, grant.apiKey, grant.confirmationId); // 1
    } catch (error) {
        if (error instanceof ConnectError && error.final) {
            // Aranx no longer knows this grant. The keys stored above do
            // not work, and the earlier ones are gone.
            await writeConnectState(ctx, {
                ...next,
                status: 'failed',
                error: `${message(error)}. Aranx did not accept the new keys. Connect to Aranx again.`
            }); // 1
            return 'failed';
        }
        await writeConnectState(ctx, { ...next, status: 'pending' }); // 1
        // The admin page queues the retry itself when it shows `pending`.
        if (retry === 'task') await scheduleTask(ctx, { kind: 'confirm' }); // 1
        return 'pending';
    }
    await writeConnectState(ctx, { ...next, status: 'connected' }); // 1
    // The encrypted pair is in use, so a plain-text pair of an earlier
    // connection can go.
    if (storage === 'settings') await deletePlainCredentials(ctx); // 1
    return 'connected';
}

function redirectToAdmin(ctx: PluginContext): PluginResponse {
    return pluginResponse({
        status: 302,
        headers: {
            location: adminPagePath(ctx.plugin.id),
            'cache-control': 'no-store'
        }
    });
}

function param(input: unknown, name: string): string | null {
    if (!isRecord(input)) return null;
    const value = input[name];
    return typeof value === 'string' && value ? value : null;
}

async function fail(
    ctx: PluginContext,
    previous: ConnectState | null,
    error: string
): Promise<PluginResponse> {
    await writeConnectState(ctx, {
        status: 'failed',
        state: null,
        verifier: null,
        confirmationId: null,
        storage: previous?.storage ?? null,
        error
    });
    return redirectToAdmin(ctx);
}

/**
 * The public `connect` route. Aranx sends the browser here after the user
 * approves or cancels. The route always answers with a redirect to the
 * plugin's admin page, which shows the result. Worst case: 10 calls.
 *
 * Anyone can call a public route. Without the `state` of a start made on
 * this site in the last 15 minutes the route does nothing, and the code is
 * worth nothing without the verifier in KV.
 */
export async function handleConnectCallback(
    ctx: PluginContext,
    input: unknown,
    now = Date.now()
): Promise<PluginResponse> {
    const started = await readConnectState(ctx); // 1
    const state = param(input, 'state');
    if (
        !started ||
        started.status !== 'started' ||
        !started.state ||
        !started.verifier ||
        !state ||
        !constantTimeEqual(state, started.state)
    ) {
        return redirectToAdmin(ctx);
    }
    const age = now - Date.parse(started.at);
    if (!Number.isFinite(age) || age > START_MAX_AGE_MS) {
        return fail(ctx, started, 'The approval took too long. Connect again.');
    }
    const code = param(input, 'code');
    if (!code) {
        return fail(
            ctx,
            started,
            param(input, 'error') === 'access_denied'
                ? 'The connection was canceled in Aranx.'
                : 'Aranx did not approve the connection.'
        );
    }

    let grant: Grant;
    try {
        grant = await exchange(ctx, code, started.verifier); // 2
    } catch (error) {
        return fail(ctx, started, `Could not get the keys. ${message(error)}`);
    }
    // The feed position and the article links belong to the pinned website.
    // Nothing is stored yet, so the keys in use stay as they are.
    const pinned = await readWebsiteId(ctx); // 3
    if (pinned && pinned !== grant.websiteId)
        return fail(ctx, started, OTHER_WEBSITE);
    try {
        // The redirect below opens the admin page, which queues a retry.
        await storeAndConfirm(ctx, grant, pinned, 'admin-page'); // up to 7
    } catch (error) {
        return fail(ctx, started, `Could not store the keys. ${message(error)}`);
    }
    return redirectToAdmin(ctx);
}

/**
 * The `rotate` task. Aranx "Reconnect" sends a signed `connection.rotate`
 * webhook with a one-time code, and this task trades it for new keys. The
 * keys come from the fixed Aranx origin, never from the webhook body, so a
 * forged webhook cannot change them. Up to 10 calls.
 */
export async function runRotateTask(
    ctx: PluginContext,
    code: string
): Promise<void> {
    let grant: Grant;
    try {
        grant = await exchange(ctx, code, null); // 1
    } catch (error) {
        // A used or expired code fails the same way on every retry.
        if (error instanceof ConnectError && error.final) {
            ctx.log.warn(`Aranx key rotation skipped: ${message(error)}`);
            return;
        }
        throw error;
    }
    const pinned = await readWebsiteId(ctx); // 2
    if (pinned && pinned !== grant.websiteId) {
        await writeConnectState(ctx, {
            status: 'failed',
            state: null,
            verifier: null,
            confirmationId: null,
            storage: null,
            error: OTHER_WEBSITE
        });
        return;
    }
    // A webhook signed with the old secret now gets a 503, and Aranx
    // retries it after the confirm call.
    await writeConnectState(ctx, {
        status: 'pending',
        state: null,
        verifier: null,
        confirmationId: grant.confirmationId,
        storage: null,
        error: null
    }); // 3
    await storeAndConfirm(ctx, grant, pinned, 'task'); // up to 7
}

/**
 * The `confirm` task. It repeats a confirm call that failed. EmDash retries
 * a failed one-shot task 5 times. Up to 5 calls.
 */
export async function runConfirmTask(ctx: PluginContext): Promise<void> {
    const state = await readConnectState(ctx);
    if (!state || state.status !== 'pending' || !state.confirmationId) return;
    const { apiKey, storage } = await readConfig(ctx);
    if (!apiKey) return;
    try {
        await confirm(ctx, apiKey, state.confirmationId);
    } catch (error) {
        if (!(error instanceof ConnectError) || !error.final) throw error;
        await writeConnectState(ctx, {
            ...state,
            status: 'failed',
            error: `${message(error)}. Aranx did not accept the new keys. Connect to Aranx again.`
        });
        return;
    }
    await writeConnectState(ctx, { ...state, status: 'connected' });
    if (storage === 'settings') await deletePlainCredentials(ctx);
}

/**
 * True while new keys are stored here and Aranx may still sign with the
 * old secret, or the reverse, and for 5 minutes after the confirm. The
 * webhook answers 503 then, and Aranx retries the delivery.
 */
export function isConnectInFlight(
    state: ConnectState | null,
    now = Date.now()
): boolean {
    if (!state || state.status === 'failed' || state.status === 'disconnected')
        return false;
    const age = now - Date.parse(state.at);
    return (
        Number.isFinite(age) &&
        age <=
            (state.status === 'connected'
                ? CONFIRMED_GRACE_MS
                : IN_FLIGHT_MAX_AGE_MS)
    );
}

/**
 * "Disconnect" on the admin page. Deletes the keys from the settings and
 * KV, so the plugin stops importing and the webhook answers 401. The pinned
 * Aranx website, the feed position, and the article links stay, so a new
 * connection to the same website resumes where this one stopped.
 *
 * Aranx has no call that lets the plugin revoke its key, so Aranx keeps the
 * connection until the owner removes it on the Publishing page. Up to 5
 * calls: it deletes only the settings that `settings` holds.
 */
export async function disconnect(
    ctx: PluginContext,
    settings: SettingEntries,
    hasPlainCredentials: boolean
): Promise<void> {
    for (const key of KEY_SETTINGS)
        if (settings.has(key)) await ctx.settings.delete(key); // 1 to 3
    if (hasPlainCredentials) await deletePlainCredentials(ctx); // 4
    await writeConnectState(ctx, {
        status: 'disconnected',
        state: null,
        verifier: null,
        confirmationId: null,
        storage: null,
        error: null
    }); // 5
}

/** Removes plain-text keys that the encrypted settings replaced. */
export function dropPlainCredentials(ctx: PluginContext): Promise<boolean> {
    return deletePlainCredentials(ctx);
}
