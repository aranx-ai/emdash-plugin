import {
    pluginResponse,
    type PluginContext,
    type PluginResponse
} from 'emdash/plugin';
import { readConfig } from './config';
import {
    deletePlainCredentials,
    readConnectState,
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
 * Aranx keeps the old key and secret valid until the confirm call, so a
 * failure at any step leaves a connected site connected. Aranx can also
 * start step 3 itself ("Reconnect" in Aranx): it sends a signed
 * `connection.rotate` webhook that carries a one-time code.
 *
 * The exchange and confirm calls go to a fixed Aranx origin, never to the
 * `apiBaseUrl` setting, which a site admin can edit.
 */

export const PLUGIN_VERSION = '0.1.9';
export const ARANX_APPROVE_URL = 'https://app.aranx.com/auth/emdash/consent';
export const ARANX_CONNECT_API = 'https://api.aranx.com/api/v1/auth/emdash';

/** Aranx codes expire after 10 minutes. The verifier is useless after that. */
const START_MAX_AGE_MS = 15 * 60 * 1000;
/** A webhook signed with the other secret gets a retry for this long. */
const IN_FLIGHT_MAX_AGE_MS = 60 * 60 * 1000;

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
 * Stores the keys as encrypted `secret` settings. EmDash refuses those on a
 * site without the `EMDASH_ENCRYPTION_KEY` Worker secret. The keys then go
 * to plugin KV in plain text, and the admin page says so. 2 calls, 3 when
 * the second setting fails after the first.
 */
export async function storeCredentials(
    ctx: PluginContext,
    credentials: StoredCredentials
): Promise<'settings' | 'kv'> {
    let wroteApiKey = false;
    try {
        await ctx.settings.set('apiKey', credentials.apiKey);
        wroteApiKey = true;
        await ctx.settings.set('webhookSecret', credentials.webhookSecret);
        return 'settings';
    } catch {
        await writePlainCredentials(ctx, {
            apiKey: credentials.apiKey,
            webhookSecret: credentials.webhookSecret
        });
        // The settings win over KV. A new key next to the old secret there
        // would break the webhook, so remove the half-written pair.
        if (wroteApiKey) await ctx.settings.delete('apiKey').catch(() => false);
        return 'kv';
    }
}

function message(error: unknown): string {
    return error instanceof Error ? error.message : 'Unknown error';
}

/**
 * Stores the keys, then confirms. A confirm that fails leaves the state
 * `pending` and queues a retry: both keys work in Aranx until it passes.
 * Up to 7 calls.
 */
async function storeAndConfirm(
    ctx: PluginContext,
    grant: Grant
): Promise<ConnectState['status']> {
    const storage = await storeCredentials(ctx, grant); // 2 or 3
    // One key and secret belong to one Aranx website.
    await writeWebsiteId(ctx, grant.websiteId); // 1
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
            // Aranx no longer knows this grant, for example after a newer
            // one replaced it.
            await writeConnectState(ctx, {
                ...next,
                status: 'failed',
                error: message(error)
            });
            return 'failed';
        }
        await writeConnectState(ctx, { ...next, status: 'pending' }); // 1
        await scheduleTask(ctx, { kind: 'confirm' }); // 1
        return 'pending';
    }
    await writeConnectState(ctx, { ...next, status: 'connected' }); // 1
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
 * plugin's admin page, which shows the result. Worst case: 9 calls.
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
    try {
        await storeAndConfirm(ctx, grant); // up to 7
    } catch (error) {
        return fail(ctx, started, `Could not store the keys. ${message(error)}`);
    }
    return redirectToAdmin(ctx);
}

/**
 * The `rotate` task. Aranx "Reconnect" sends a signed `connection.rotate`
 * webhook with a one-time code, and this task trades it for new keys. The
 * keys come from the fixed Aranx origin, never from the webhook body, so a
 * forged webhook cannot change them. Up to 9 calls.
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
    // A webhook signed with the old secret now gets a 503, and Aranx
    // retries it after the confirm call.
    await writeConnectState(ctx, {
        status: 'pending',
        state: null,
        verifier: null,
        confirmationId: grant.confirmationId,
        storage: null,
        error: null
    }); // 2
    await storeAndConfirm(ctx, grant); // up to 7
}

/**
 * The `confirm` task. It repeats a confirm call that failed. EmDash retries
 * a failed one-shot task 5 times. Up to 5 calls.
 */
export async function runConfirmTask(ctx: PluginContext): Promise<void> {
    const state = await readConnectState(ctx);
    if (!state || state.status !== 'pending' || !state.confirmationId) return;
    const { apiKey } = await readConfig(ctx);
    if (!apiKey) return;
    try {
        await confirm(ctx, apiKey, state.confirmationId);
    } catch (error) {
        if (!(error instanceof ConnectError) || !error.final) throw error;
        await writeConnectState(ctx, {
            ...state,
            status: 'failed',
            error: message(error)
        });
        return;
    }
    await writeConnectState(ctx, { ...state, status: 'connected' });
}

/**
 * True while new keys are stored here and Aranx may still sign with the
 * old secret, or the reverse. The webhook answers 503 then, and Aranx
 * retries the delivery.
 */
export function isConnectInFlight(
    state: ConnectState | null,
    now = Date.now()
): boolean {
    if (!state || (state.status !== 'started' && state.status !== 'pending'))
        return false;
    const age = now - Date.parse(state.at);
    return Number.isFinite(age) && age <= IN_FLIGHT_MAX_AGE_MS;
}

/** Removes plain-text keys that the encrypted settings replaced. */
export function dropPlainCredentials(ctx: PluginContext): Promise<boolean> {
    return deletePlainCredentials(ctx);
}
