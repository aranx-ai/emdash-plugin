import { describe, expect, it } from 'vitest';
import type { PluginContext } from 'emdash/plugin';
import { readConfig } from '../src/config';

function withApiUrl(value: string | null) {
    const entries = value === null ? [] : [{ key: 'apiBaseUrl', value }];
    return {
        settings: { list: async () => entries },
        // No keys in the settings, so the plain-text copy is read too.
        kv: { get: async () => null }
    } as unknown as PluginContext;
}

describe('readConfig', () => {
    it('uses the API host by default', async () => {
        expect((await readConfig(withApiUrl(null))).apiBaseUrl).toBe(
            'https://api.aranx.com/api/v1/public'
        );
    });

    it('moves the URL that older versions saved to the API host', async () => {
        expect(
            (await readConfig(withApiUrl('https://aranx.com/api/v1/public/')))
                .apiBaseUrl
        ).toBe('https://api.aranx.com/api/v1/public');
    });

    it('keeps a custom URL', async () => {
        expect(
            (await readConfig(withApiUrl('https://api.dev.aranx.com/api/v1/public')))
                .apiBaseUrl
        ).toBe('https://api.dev.aranx.com/api/v1/public');
    });
});
