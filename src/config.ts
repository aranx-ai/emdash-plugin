import type { PluginContext } from 'emdash/plugin';
import { readPlainCredentials, type StoredCredentials } from './store';
import {
    AranxApiError,
    DEFAULT_API_BASE_URL,
    type ApiConfig
} from './aranx-api';

export interface PluginConfig {
    apiKey: string | null;
    webhookSecret: string | null;
    collection: string;
    taxonomy: string;
    apiBaseUrl: string;
    /**
     * Where the keys come from: the encrypted settings, or plugin KV in plain
     * text (a site without `EMDASH_ENCRYPTION_KEY`). Null when there are none.
     */
    storage: 'settings' | 'kv' | null;
}

// The URL that versions before 0.1.8 pre-filled and EmDash saved with the
// other settings. A saved copy means the default, so it maps to the API host.
const LEGACY_API_BASE_URL = 'https://aranx.com/api/v1/public';

function setting(entries: Map<string, unknown>, key: string): string | null {
    const value = entries.get(key);
    return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function apiBaseUrl(saved: string | null): string {
    const url = (saved ?? DEFAULT_API_BASE_URL).replace(/\/+$/, '');
    return url === LEGACY_API_BASE_URL ? DEFAULT_API_BASE_URL : url;
}

/**
 * The setting that holds the key and the secret from the connection flow
 * as one JSON string. One write stores both, so a reader never sees the
 * new key next to the old secret.
 */
export const CREDENTIALS_SETTING = 'credentials';

export function encodeCredentials(credentials: StoredCredentials): string {
    return JSON.stringify({
        apiKey: credentials.apiKey,
        webhookSecret: credentials.webhookSecret
    });
}

function decodeCredentials(value: string | null): StoredCredentials | null {
    if (!value) return null;
    let parsed: unknown;
    try {
        parsed = JSON.parse(value);
    } catch {
        return null;
    }
    if (typeof parsed !== 'object' || parsed === null) return null;
    const apiKey = 'apiKey' in parsed ? parsed.apiKey : null;
    const webhookSecret =
        'webhookSecret' in parsed ? parsed.webhookSecret : null;
    return typeof apiKey === 'string' &&
        typeof webhookSecret === 'string' &&
        apiKey &&
        webhookSecret
        ? { apiKey, webhookSecret }
        : null;
}

/**
 * Reads every setting in one bridge call. The pair from the connection flow
 * wins, then the `apiKey` and `webhookSecret` settings of a manual setup.
 * When the settings hold neither pair, a second call reads the plain-text
 * keys that the connection flow stored in KV.
 */
export async function readConfig(ctx: PluginContext): Promise<PluginConfig> {
    const entries = new Map(
        (await ctx.settings.list()).map(
            (entry) => [entry.key, entry.value] as const
        )
    );
    const managed = decodeCredentials(setting(entries, CREDENTIALS_SETTING));
    let apiKey = managed?.apiKey ?? setting(entries, 'apiKey');
    let webhookSecret =
        managed?.webhookSecret ?? setting(entries, 'webhookSecret');
    let storage: PluginConfig['storage'] =
        apiKey || webhookSecret ? 'settings' : null;
    if (!apiKey || !webhookSecret) {
        const plain = await readPlainCredentials(ctx);
        if (plain) {
            ({ apiKey, webhookSecret } = plain);
            storage = 'kv';
        }
    }
    return {
        apiKey,
        webhookSecret,
        storage,
        collection: setting(entries, 'collection') ?? 'posts',
        taxonomy: setting(entries, 'taxonomy') ?? 'category',
        apiBaseUrl: apiBaseUrl(setting(entries, 'apiBaseUrl'))
    };
}

/** The category taxonomy. 1 call: it reads no key, so no KV read follows. */
export async function readTaxonomy(ctx: PluginContext): Promise<string> {
    const value = await ctx.settings.get<unknown>('taxonomy');
    return typeof value === 'string' && value.trim()
        ? value.trim()
        : 'category';
}

export function apiConfig(config: PluginConfig): ApiConfig {
    if (!config.apiKey)
        throw new AranxApiError(401, 'The Aranx API key is not set');
    return { apiKey: config.apiKey, baseUrl: config.apiBaseUrl };
}
