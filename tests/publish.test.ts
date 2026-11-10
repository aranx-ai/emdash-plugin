import { describe, expect, it, vi } from 'vitest';
import type { PluginContext } from 'emdash/plugin';
import { runPublishTask } from '../src/sync';

const API = 'https://aranx.com/api/v1/public';
const ARTICLE_ID = 'article-1';

/** The error the sandbox throws when a `content:beforePublish` hook cancels. */
function contentActionError(code: string, message: string): Error {
    return Object.assign(new Error(message), { code, name: code });
}

/**
 * The plugin-test runtime host loads only this plugin, so it cannot run a
 * second plugin's publish policy. This fake context covers the calls that the
 * publish task makes.
 */
function fakeContext(publishError: Error) {
    const fetch = vi.fn(async () => Response.json({ id: ARTICLE_ID }));
    const warn = vi.fn();
    const ctx = {
        settings: {
            list: async () => [{ key: 'apiKey', value: 'arx_sk_test' }]
        },
        storage: { articles: { get: async () => null } },
        content: {
            getVersioned: async () => ({
                item: { id: 'entry-1', status: 'draft' },
                _rev: 'rev-1'
            }),
            publish: async () => {
                throw publishError;
            }
        },
        http: { fetch },
        log: { warn }
    } as unknown as PluginContext;
    return { ctx, fetch, warn };
}

const task = {
    kind: 'publish',
    articleId: ARTICLE_ID,
    entryId: 'entry-1',
    collection: 'posts',
    requestedStatus: 'published'
} as const;

describe('publish task', () => {
    it('reports a draft and ends when a site policy refuses the publish', async () => {
        const { ctx, fetch, warn } = fakeContext(
            contentActionError(
                'PUBLISH_REJECTED',
                'Assign a category before publishing.'
            )
        );

        await expect(runPublishTask(ctx, task)).resolves.toBeUndefined();

        expect(warn).toHaveBeenCalledWith(
            'The site refused to publish the Aranx article',
            {
                articleId: ARTICLE_ID,
                reason: 'Assign a category before publishing.'
            }
        );
        expect(fetch).toHaveBeenCalledTimes(1);
        expect(fetch).toHaveBeenCalledWith(
            `${API}/articles/${ARTICLE_ID}`,
            expect.objectContaining({
                method: 'PATCH',
                body: JSON.stringify({ status: 'draft' })
            })
        );
    });

    it('throws other publish errors so EmDash retries the task', async () => {
        const { ctx, fetch } = fakeContext(
            contentActionError('CONFLICT', 'Revision precondition did not match')
        );

        await expect(runPublishTask(ctx, task)).rejects.toThrow(
            'Revision precondition did not match'
        );
        expect(fetch).not.toHaveBeenCalled();
    });
});
