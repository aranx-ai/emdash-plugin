import { describe, expect, it } from 'vitest';
import {
    consoleUrl,
    healthOf,
    publishingUrl,
    timeAgo,
    webhookPath
} from '../src/admin';
import type { PluginState } from '../src/store';

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

describe('timeAgo', () => {
    const now = Date.parse('2026-11-25T12:00:00.000Z');

    it('rounds to the largest unit', () => {
        expect(timeAgo('2026-11-25T11:59:30.000Z', now)).toBe('Just now');
        expect(timeAgo('2026-11-25T11:55:00.000Z', now)).toBe('5 min ago');
        expect(timeAgo('2026-11-25T09:00:00.000Z', now)).toBe('3 h ago');
        expect(timeAgo('2026-11-24T12:00:00.000Z', now)).toBe('1 day ago');
        expect(timeAgo('2026-11-20T12:00:00.000Z', now)).toBe('5 days ago');
    });

    it('returns null without a valid time', () => {
        expect(timeAgo(null, now)).toBeNull();
        expect(timeAgo('soon', now)).toBeNull();
    });
});

describe('healthOf', () => {
    const now = Date.parse('2026-11-25T12:00:00.000Z');
    const state = (overrides: Partial<PluginState> = {}): PluginState => ({
        feed: {
            cursor: null,
            lastRunAt: '2026-11-25T11:50:00.000Z',
            importAfter: null,
            error: null
        },
        connect: null,
        websiteId: 'website-1',
        plainCredentials: null,
        lastWebhook: null,
        ...overrides
    });
    const feedError = (status: number) => ({
        ...state().feed,
        error: { message: 'Aranx API failed', status, at: '2026-11-25T11:45:00.000Z' }
    });

    it('is active while the feed runs', () => {
        expect(healthOf(state(), now)).toBe('active');
    });

    it('is lost when Aranx refuses the key', () => {
        expect(healthOf(state({ feed: feedError(401) }), now)).toBe('lost');
        expect(healthOf(state({ feed: feedError(403) }), now)).toBe('lost');
    });

    it('is unstable after another error or an hour without a run', () => {
        expect(healthOf(state({ feed: feedError(502) }), now)).toBe('unstable');
        expect(
            healthOf(
                state({ feed: { ...state().feed, lastRunAt: '2026-11-25T10:30:00.000Z' } }),
                now
            )
        ).toBe('unstable');
    });

    it('waits for the confirm', () => {
        expect(
            healthOf(
                state({
                    connect: {
                        status: 'pending',
                        at: '2026-11-25T11:59:00.000Z',
                        state: null,
                        verifier: null,
                        confirmationId: 'c',
                        storage: 'settings',
                        error: null
                    }
                }),
                now
            )
        ).toBe('pending');
    });
});

describe('Aranx links', () => {
    it('opens the website in Aranx', () => {
        expect(consoleUrl('website-1')).toBe(
            'https://app.aranx.com/websites/website-1/content/posts'
        );
        expect(publishingUrl('website-1')).toBe(
            'https://app.aranx.com/websites/website-1/publishing'
        );
        expect(consoleUrl(null)).toBe('https://app.aranx.com');
    });
});
