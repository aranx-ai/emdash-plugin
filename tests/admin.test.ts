import { describe, expect, it } from 'vitest';
import { webhookPath } from '../src/admin';

describe('webhookPath', () => {
    it('uses the slug for a local install', () => {
        expect(webhookPath('aranx')).toBe('/_emdash/api/plugins/aranx/webhook');
    });

    it('uses the hashed ID for a registry install', () => {
        expect(webhookPath('r_otneixpnd6iliahd')).toBe(
            '/_emdash/api/plugins/r_otneixpnd6iliahd/webhook'
        );
    });
});
