import { describe, expect, it } from 'vitest';
import type { CronEvent } from 'emdash/plugin';
import { FEED_NEXT_TASK, FEED_TASK, parseTask } from '../src/tasks';

function event(name: string, data?: Record<string, unknown>): CronEvent {
    return { name, data, scheduledAt: '2026-11-05T10:00:00.000Z' };
}

describe('parseTask', () => {
    it('reads the feed task and every feed_next continuation as a feed step', () => {
        expect(parseTask(event(FEED_TASK))).toEqual({ kind: 'feed' });
        expect(parseTask(event(`${FEED_NEXT_TASK}_1a2b3c`))).toEqual({
            kind: 'feed'
        });
    });

    it('parses an article step with a requested status', () => {
        expect(
            parseTask(
                event('article_article-1_draft', {
                    kind: 'article',
                    articleId: 'article-1',
                    requestedStatus: 'draft'
                })
            )
        ).toEqual({
            kind: 'article',
            articleId: 'article-1',
            requestedStatus: 'draft'
        });
    });

    it('drops an unknown requested status to null', () => {
        expect(
            parseTask(
                event('article_article-1', {
                    kind: 'article',
                    articleId: 'article-1',
                    requestedStatus: 'scheduled'
                })
            )
        ).toEqual({ kind: 'article', articleId: 'article-1', requestedStatus: null });
    });

    it('rejects a task without an article ID', () => {
        expect(parseTask(event('article_x', { kind: 'article' }))).toBeNull();
        expect(
            parseTask(event('report_x', { kind: 'report', articleId: 42 }))
        ).toBeNull();
    });

    it('rejects terms and publish steps that lack entryId or collection', () => {
        expect(
            parseTask(
                event('terms_article-1', {
                    kind: 'terms',
                    articleId: 'article-1',
                    collection: 'posts'
                })
            )
        ).toBeNull();
        expect(
            parseTask(
                event('publish_article-1', {
                    kind: 'publish',
                    articleId: 'article-1',
                    entryId: 'entry-1'
                })
            )
        ).toBeNull();
    });

    it('keeps only categories that have a string ID and name', () => {
        const task = parseTask(
            event('terms_article-1', {
                kind: 'terms',
                articleId: 'article-1',
                entryId: 'entry-1',
                collection: 'posts',
                categories: [
                    { id: '7', name: 'Guides', slug: 'guides' },
                    { id: 8, name: 'Numeric ID' },
                    { id: '9' },
                    'Plain string',
                    { id: '10', name: 'No slug' }
                ]
            })
        );
        expect(task).toEqual({
            kind: 'terms',
            articleId: 'article-1',
            entryId: 'entry-1',
            collection: 'posts',
            requestedStatus: null,
            categories: [
                { id: '7', name: 'Guides', slug: 'guides' },
                { id: '10', name: 'No slug', slug: '' }
            ]
        });
    });

    it('reads gone only when it is exactly true', () => {
        const base = { kind: 'report', articleId: 'article-1' };
        expect(parseTask(event('report_article-1', base))).toEqual({
            kind: 'report',
            articleId: 'article-1',
            gone: false
        });
        expect(
            parseTask(event('report_article-1', { ...base, gone: 'true' }))
        ).toEqual({ kind: 'report', articleId: 'article-1', gone: false });
        expect(
            parseTask(event('report_article-1', { ...base, gone: true }))
        ).toEqual({ kind: 'report', articleId: 'article-1', gone: true });
    });

    it('returns null for an unknown step kind', () => {
        expect(
            parseTask(
                event('other_article-1', {
                    kind: 'other',
                    articleId: 'article-1'
                })
            )
        ).toBeNull();
    });
});
