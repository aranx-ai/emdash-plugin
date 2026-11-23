import type { PluginContext } from 'emdash/plugin';
import { readPlainCredentials } from './store';
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
 * Reads every setting in one bridge call. The keys in the settings win. When
 * the settings do not hold both, a second call reads the plain-text keys
 * that the connection flow stored in KV.
 */
export async function readConfig(ctx: PluginContext): Promise<PluginConfig> {
    const entries = new Map(
        (await ctx.settings.list()).map(
            (entry) => [entry.key, entry.value] as const
        )
    );
    let apiKey = setting(entries, 'apiKey');
    let webhookSecret = setting(entries, 'webhookSecret');
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

export function apiConfig(config: PluginConfig): ApiConfig {
    if (!config.apiKey)
        throw new AranxApiError(401, 'The Aranx API key is not set');
    return { apiKey: config.apiKey, baseUrl: config.apiBaseUrl };
}
