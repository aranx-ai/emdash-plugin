import type { PluginContext } from 'emdash/plugin';
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
}

function setting(entries: Map<string, unknown>, key: string): string | null {
    const value = entries.get(key);
    return typeof value === 'string' && value.trim() ? value.trim() : null;
}

/** Reads every setting in one bridge call. */
export async function readConfig(ctx: PluginContext): Promise<PluginConfig> {
    const entries = new Map(
        (await ctx.settings.list()).map(
            (entry) => [entry.key, entry.value] as const
        )
    );
    return {
        apiKey: setting(entries, 'apiKey'),
        webhookSecret: setting(entries, 'webhookSecret'),
        collection: setting(entries, 'collection') ?? 'posts',
        taxonomy: setting(entries, 'taxonomy') ?? 'category',
        apiBaseUrl: (
            setting(entries, 'apiBaseUrl') ?? DEFAULT_API_BASE_URL
        ).replace(/\/+$/, '')
    };
}

export function apiConfig(config: PluginConfig): ApiConfig {
    if (!config.apiKey)
        throw new AranxApiError(401, 'The Aranx API key is not set');
    return { apiKey: config.apiKey, baseUrl: config.apiBaseUrl };
}
