import { describe, expect, it, vi } from 'vitest';
import type { PluginContext } from 'emdash/plugin';
import { runPublishTask } from '../src/sync';
import type { ArticleRecord, ReportedState } from '../src/store';

const API = 'https://aranx.com/api/v1/public';
const ARTICLE_ID = 'article-1';
const REASON = 'Assign a category before publishing.';

/** The error the sandbox throws when a `content:beforePublish` hook cancels. */
function contentActionError(code: string, message: string): Error {
    return Object.assign(new Error(message), { code, name: code });
}

function storedRecord(reported: Partial<ReportedState> | null): ArticleRecord {
    return {
        entryId: 'entry-1',
        collection: 'posts',
        aranxUpdatedAt: '2026-11-01T00:00:00.000Z',
        categoryIds: [],
        featuredUrl: null,
        featuredImage: null,
        reported: reported
            ? {
                  status: 'draft',
                  url: null,
                  scheduledAt: null,
                  publishError: null,
                  ...reported
              }
            : null
    };
}

/**
 * The plugin-test runtime host loads only this plugin, so it cannot run a
 * second plugin's publish policy. This fake context covers the calls that the
 * publish task makes. `publish` is either the error to throw or the published
 * entry to return. Storage is an in-memory map.
 */
function fakeContext(
    publish: Error | 'published',
    stored: object | null = null
) {
    const fetch = vi.fn(async () => Response.json({ id: ARTICLE_ID }));
    const warn = vi.fn();
    const records = new Map<string, unknown>();
    if (stored) records.set(ARTICLE_ID, stored);
    const ctx = {
        settings: {
            list: async () => [{ key: 'apiKey', value: 'arx_sk_test' }]
        },
        storage: {
            articles: {
                get: async (id: string) => records.get(id) ?? null,
                put: async (id: string, value: unknown) => {
                    records.set(id, value);
                }
            }
        },
        content: {
            getVersioned: async () => ({
                item: { id: 'entry-1', status: 'draft' },
                _rev: 'rev-1'
            }),
            publish: async () => {
                if (publish instanceof Error) throw publish;
                return {
                    item: {
                        id: 'entry-1',
                        status: 'published',
                        publishedAt: '2026-11-05T10:00:00.000Z'
                    }
                };
            },
            getPublicUrl: async () => 'https://site.example/posts/entry-1'
        },
        http: { fetch },
        log: { warn }
    } as unknown as PluginContext;
    const reported = () =>
        (records.get(ARTICLE_ID) as ArticleRecord | undefined)?.reported;
    const bodies = () =>
        fetch.mock.calls.map((call) =>
            JSON.parse(String((call as unknown as [string, RequestInit])[1].body))
        );
    return { ctx, fetch, warn, reported, bodies };
}

function publishTask(requestedStatus: 'published' | 'draft' | null) {
    return {
        kind: 'publish',
        articleId: ARTICLE_ID,
        entryId: 'entry-1',
        collection: 'posts',
        requestedStatus
    } as const;
}

const task = publishTask('published');
const rejected = (reason = REASON) =>
    contentActionError('PUBLISH_REJECTED', reason);

describe('publish task', () => {
    it('reports a draft with the reason when a site policy refuses the publish', async () => {
        const { ctx, fetch, warn } = fakeContext(rejected());

        await expect(runPublishTask(ctx, task)).resolves.toBeUndefined();

        expect(warn).toHaveBeenCalledWith(
            'The site refused to publish the Aranx article',
            { articleId: ARTICLE_ID, reason: REASON }
        );
        expect(fetch).toHaveBeenCalledTimes(1);
        expect(fetch).toHaveBeenCalledWith(
            `${API}/articles/${ARTICLE_ID}`,
            expect.objectContaining({
                method: 'PATCH',
                body: JSON.stringify({ status: 'draft', publish_error: REASON })
            })
        );
    });

    it('sends the reason when the stored state is already a draft', async () => {
        const { ctx, bodies, reported } = fakeContext(
            rejected(),
            storedRecord({ status: 'draft' })
        );

        await runPublishTask(ctx, task);

        expect(bodies()).toEqual([{ status: 'draft', publish_error: REASON }]);
        expect(reported()?.publishError).toBe(REASON);
    });

    it('reads a stored state without an error field as no error', async () => {
        const record = storedRecord({ status: 'draft' });
        const legacy = {
            ...record,
            reported: { status: 'draft', url: null, scheduledAt: null }
        };
        const { ctx, bodies } = fakeContext(rejected(), legacy);

        await runPublishTask(ctx, task);

        expect(bodies()).toEqual([{ status: 'draft', publish_error: REASON }]);
    });

    it('sends the same reason only once', async () => {
        const { ctx, fetch } = fakeContext(
            rejected(),
            storedRecord({ status: 'draft' })
        );

        await runPublishTask(ctx, task);
        await runPublishTask(ctx, task);

        expect(fetch).toHaveBeenCalledTimes(1);
    });

    it('sends a changed reason even when the status is the same', async () => {
        const { ctx, bodies } = fakeContext(
            rejected('Add a cover image.'),
            storedRecord({ status: 'draft', publishError: REASON })
        );

        await runPublishTask(ctx, task);

        expect(bodies()).toEqual([
            { status: 'draft', publish_error: 'Add a cover image.' }
        ]);
    });

    it('resets the stored error after a successful publish without sending null', async () => {
        const { ctx, bodies, reported } = fakeContext(
            'published',
            storedRecord({ status: 'draft', publishError: REASON })
        );

        await runPublishTask(ctx, task);

        expect(bodies()).toEqual([
            {
                status: 'published',
                url: 'https://site.example/posts/entry-1',
                published_at: '2026-11-05T10:00:00.000Z'
            }
        ]);
        expect(reported()).toMatchObject({
            status: 'published',
            publishError: null
        });
    });

    it('clears the stored error on a draft request that is not refused', async () => {
        const { ctx, bodies, reported } = fakeContext(
            rejected(),
            storedRecord({ status: 'draft', publishError: REASON })
        );

        await runPublishTask(ctx, publishTask('draft'));

        expect(bodies()).toEqual([{ status: 'draft', publish_error: null }]);
        expect(reported()?.publishError).toBeNull();
    });

    it('keeps the stored error on a feed import', async () => {
        const { ctx, fetch } = fakeContext(
            rejected(),
            storedRecord({ status: 'draft', publishError: REASON })
        );

        await runPublishTask(ctx, publishTask(null));

        expect(fetch).not.toHaveBeenCalled();
    });

    it('trims the reason', async () => {
        const { ctx, bodies } = fakeContext(rejected(`  ${REASON}\n`));

        await runPublishTask(ctx, task);

        expect(bodies()[0].publish_error).toBe(REASON);
    });

    it('truncates the reason to 1000 characters', async () => {
        const { ctx, bodies } = fakeContext(rejected('a'.repeat(1200)));

        await runPublishTask(ctx, task);

        expect(bodies()[0].publish_error).toBe('a'.repeat(1000));
    });

    it('sends a fallback when the reason is empty', async () => {
        const { ctx, bodies } = fakeContext(rejected('   '));

        await runPublishTask(ctx, task);

        expect(bodies()[0].publish_error).toBe(
            'The site refused to publish this entry.'
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
