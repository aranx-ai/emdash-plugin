import { afterEach, describe, expect, it } from 'vitest';
import {
    createPluginRuntimeTestHost,
    type PluginRuntimeTestHost
} from '@emdash-cms/plugin-test';
import { sign } from '../src/signature';

const API = 'https://api.aranx.com/api/v1/public';
const SECRET = 'arx_whsec_test';
const API_KEY = 'arx_sk_test';
const WEBSITE_ID = 'website-1';
const ARTICLE_ID = 'article-1';
const FEATURED = 'https://images.aranx.com/w/a/featured.webp';
const SECTION = 'https://images.aranx.com/w/a/section.webp';
const PNG = new Uint8Array([
    137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 13, 73, 72, 68, 82, 0, 0, 0, 1, 0,
    0, 0, 1, 8, 4, 0, 0, 0, 181, 28, 12, 2, 0, 0, 0, 11, 73, 68, 65, 84, 120,
    218, 99, 252, 255, 31, 0, 3, 3, 2, 0, 239, 162, 167, 91, 0, 0, 0, 0, 73, 69,
    78, 68, 174, 66, 96, 130
]);

let host: PluginRuntimeTestHost | undefined;

afterEach(async () => {
    await host?.dispose();
    host = undefined;
});

function article(overrides: Record<string, unknown> = {}) {
    return {
        id: ARTICLE_ID,
        title: 'How to start a blog',
        slug: 'how-to-start-a-blog',
        meta_title: 'Start a blog | Guide',
        meta_description: 'A step-by-step guide.',
        keywords: ['blog'],
        category: { name: 'Guides', slug: 'guides' },
        categories: [{ id: '7', name: 'Guides', slug: 'guides' }],
        content_format: 'json',
        content: [
            { tag: 'p', children: ['Intro.'] },
            {
                tag: 'h2',
                attributes: { id: 'step-one' },
                children: ['Step one']
            },
            {
                tag: 'figure',
                attributes: { class: 'article-section-image' },
                children: [
                    { tag: 'img', attributes: { src: SECTION, alt: 'Chart' } }
                ]
            }
        ],
        images: [
            {
                id: 'i1',
                url: SECTION,
                alt: 'Chart',
                width: 1600,
                height: 900,
                is_ai_generated: true
            },
            {
                id: 'i2',
                url: FEATURED,
                alt: 'Cover',
                width: 1792,
                height: 1024,
                is_ai_generated: true
            }
        ],
        status: 'unpublished',
        url: null,
        published_at: null,
        scheduled_at: null,
        created_at: '2026-11-01T10:00:00.000Z',
        updated_at: '2026-11-01T10:00:00.000Z',
        ...overrides
    };
}

async function setup() {
    host = await createPluginRuntimeTestHost({
        site: { url: 'https://blog.example.com' }
    });
    await host.fixtures.collection({
        slug: 'posts',
        label: 'Posts',
        supports: ['drafts', 'revisions', 'seo'],
        hasSeo: true,
        urlPattern: '/posts/{slug}',
        fields: [
            { slug: 'title', label: 'Title', type: 'string', required: true },
            { slug: 'content', label: 'Content', type: 'portableText' },
            { slug: 'excerpt', label: 'Excerpt', type: 'text' },
            { slug: 'featured_image', label: 'Featured image', type: 'image' }
        ]
    });
    await host.fixtures.taxonomyDefinition({
        name: 'category',
        label: 'Categories',
        hierarchical: true,
        collections: ['posts']
    });
    await host.fixtures.plugin.setting('apiKey', API_KEY);
    await host.fixtures.plugin.setting('webhookSecret', SECRET);
    await host.actions.plugin.activate();
    return host;
}

async function deliver(
    current: PluginRuntimeTestHost,
    payload: Record<string, unknown>,
    secret = SECRET
): Promise<Response> {
    const body = JSON.stringify({
        website_id: WEBSITE_ID,
        timestamp: new Date().toISOString(),
        ...payload
    });
    return current.actions.routes.request('webhook', {
        method: 'POST',
        rawBody: body,
        headers: {
            'content-type': 'application/json',
            'x-webhook-signature': await sign(secret, body)
        }
    });
}

async function queueArticle(current: PluginRuntimeTestHost, body = article()) {
    await current.http.respond(
        `${API}/articles/${ARTICLE_ID}?format=json&image_format=webp`,
        Response.json(body)
    );
}

async function queueFeatured(current: PluginRuntimeTestHost) {
    await current.http.respond(
        FEATURED,
        new Response(PNG, { headers: { 'content-type': 'image/png' } })
    );
}

async function queuePatch(current: PluginRuntimeTestHost) {
    await current.http.respond(
        `${API}/articles/${ARTICLE_ID}`,
        Response.json({ id: ARTICLE_ID, status: 'published' })
    );
}

/**
 * Runs cron ticks until no task is due. The host clock stays at the time it
 * was set, and tasks are due at the real time they were scheduled.
 */
async function drain(current: PluginRuntimeTestHost) {
    for (let i = 0; i < 6; i++) {
        await current.waitForDeferredTasks();
        current.scheduled.setTime(new Date(Date.now() + 1000));
        const { processed } = await current.scheduled.run();
        await current.waitForDeferredTasks();
        if (processed === 0) return;
    }
}

function patches(current: PluginRuntimeTestHost) {
    return current.http
        .requests()
        .filter((request) => request.method === 'PATCH')
        .map((request) => ({
            url: request.url,
            auth: request.headers.authorization,
            body: JSON.parse(new TextDecoder().decode(request.body)) as Record<
                string,
                unknown
            >
        }));
}

describe('webhook receiver', () => {
    it('rejects a bad signature and accepts a test event', async () => {
        const current = await setup();
        expect(
            (await deliver(current, { event: 'test' }, 'wrong')).status
        ).toBe(401);
        const response = await deliver(current, { event: 'test' });
        expect(response.status).toBe(200);
        expect(await response.json()).toEqual({ received: true });
        expect(await current.inspect.scheduledTasks()).toHaveLength(1); // only the feed
    });

    it('rejects a replayed delivery and another website', async () => {
        const current = await setup();
        const stale = await deliver(current, {
            event: 'test',
            timestamp: new Date(Date.now() - 60 * 60 * 1000).toISOString()
        });
        expect(stale.status).toBe(401);
        expect((await deliver(current, { event: 'test' })).status).toBe(200);
        expect(
            (await deliver(current, { event: 'test', website_id: 'website-2' }))
                .status
        ).toBe(400);
    });

    it('answers the signed feature check', async () => {
        const current = await setup();
        const timestamp = new Date().toISOString();
        const headers = {
            'x-webhook-timestamp': timestamp,
            'x-webhook-signature': await sign(SECRET, timestamp)
        };
        const head = await current.actions.routes.request('webhook', {
            method: 'HEAD',
            headers
        });
        expect(head.status).toBe(204);
        const get = await current.actions.routes.request('webhook', {
            method: 'GET',
            headers
        });
        expect(get.status).toBe(200);
        expect(await get.json()).toEqual({ features: ['requested_status'] });
        const unsigned = await current.actions.routes.request('webhook', {
            method: 'GET',
            headers: { 'x-webhook-timestamp': timestamp }
        });
        expect(unsigned.status).toBe(401);
    });

    it('answers 503 until the secret is saved', async () => {
        host = await createPluginRuntimeTestHost();
        expect((await deliver(host, { event: 'test' })).status).toBe(503);
    });
});

describe('article import', () => {
    it('publishes an article, assigns its category, and reports the live URL', async () => {
        const current = await setup();
        const response = await deliver(current, {
            event: 'article.published',
            article_id: ARTICLE_ID,
            requested_status: 'published'
        });
        expect(response.status).toBe(202);

        await queueArticle(current);
        await queueFeatured(current);
        await queuePatch(current);
        await drain(current);

        const [entry] = await current.inspect.content.list('posts');
        expect(entry).toMatchObject({
            status: 'published',
            data: {
                title: 'How to start a blog',
                excerpt: 'A step-by-step guide.',
                featured_image: {
                    id: expect.stringMatching(/.+/),
                    provider: 'local',
                    alt: 'Cover'
                }
            }
        });
        expect(entry.data.content).toMatchObject([
            { _type: 'block', style: 'normal', children: [{ text: 'Intro.' }] },
            { _type: 'block', style: 'h2', children: [{ text: 'Step one' }] },
            {
                _type: 'image',
                asset: { url: SECTION },
                alt: 'Chart',
                width: 1600,
                height: 900
            }
        ]);

        const terms = await current.inspect.content.terms(
            'posts',
            entry.id,
            'category'
        );
        expect(terms.map((term) => term.slug)).toEqual(['guides']);

        expect(patches(current)).toEqual([
            {
                url: `${API}/articles/${ARTICLE_ID}`,
                auth: `Bearer ${API_KEY}`,
                body: {
                    status: 'published',
                    url: `https://blog.example.com/posts/${entry.slug}`,
                    published_at: expect.any(String)
                }
            }
        ]);
    });

    it('saves a draft for Push as Draft and reports it', async () => {
        const current = await setup();
        await deliver(current, {
            event: 'article.published',
            article_id: ARTICLE_ID,
            requested_status: 'draft'
        });
        await queueArticle(current);
        await queueFeatured(current);
        await queuePatch(current);
        await drain(current);

        const [entry] = await current.inspect.content.list('posts');
        expect(entry.status).toBe('draft');
        expect(patches(current).map((patch) => patch.body)).toEqual([
            { status: 'draft' }
        ]);
    });

    it('updates a live entry in place and keeps it live', async () => {
        const current = await setup();
        await deliver(current, {
            event: 'article.published',
            article_id: ARTICLE_ID,
            requested_status: 'published'
        });
        await queueArticle(current);
        await queueFeatured(current);
        await queuePatch(current);
        await drain(current);

        await deliver(current, {
            event: 'article.updated',
            article_id: ARTICLE_ID
        });
        await queueArticle(
            current,
            article({
                title: 'How to start a blog in 2027',
                updated_at: '2026-11-02T10:00:00.000Z'
            })
        );
        await drain(current);

        const entries = await current.inspect.content.list('posts');
        expect(entries).toHaveLength(1);
        expect(entries[0]).toMatchObject({
            status: 'published',
            data: { title: 'How to start a blog in 2027' }
        });
        // Same featured image: no second download. Same state: no second report.
        const requests = current.http.requests();
        expect(
            requests.filter((request) => request.url === FEATURED)
        ).toHaveLength(1);
        expect(patches(current)).toHaveLength(1);
    });

    it('leaves the entry alone when only the Aranx update time changes', async () => {
        const current = await setup();
        await deliver(current, {
            event: 'article.published',
            article_id: ARTICLE_ID,
            requested_status: 'published'
        });
        await queueArticle(current);
        await queueFeatured(current);
        await queuePatch(current);
        await drain(current);
        const [before] = await current.inspect.content.list('posts');

        // The status report above changed `updated_at` in Aranx.
        await deliver(current, {
            event: 'article.updated',
            article_id: ARTICLE_ID
        });
        await queueArticle(
            current,
            article({
                status: 'published',
                updated_at: '2026-11-02T10:00:00.000Z'
            })
        );
        await drain(current);

        const after = await current.inspect.content.get('posts', before.id);
        expect(after?.updatedAt).toBe(before.updatedAt);
        expect(after?.draftRevisionId ?? null).toBe(
            before.draftRevisionId ?? null
        );
        expect(
            await current.inspect.storage.get('articles', ARTICLE_ID)
        ).toMatchObject({ aranxUpdatedAt: '2026-11-02T10:00:00.000Z' });
        expect(patches(current)).toHaveLength(1);
    });

    it('updates categories without publishing an editor draft', async () => {
        const current = await setup();
        await deliver(current, {
            event: 'article.published',
            article_id: ARTICLE_ID,
            requested_status: 'published'
        });
        await queueArticle(current);
        await queueFeatured(current);
        await queuePatch(current);
        await drain(current);
        const [entry] = await current.inspect.content.list('posts');
        await current.actions.content.update('posts', entry.id, {
            data: { title: 'Edited in EmDash' }
        });
        const edited = await current.inspect.content.get('posts', entry.id);
        expect(edited?.draftRevisionId).toBeTruthy();

        await deliver(current, {
            event: 'article.updated',
            article_id: ARTICLE_ID
        });
        await queueArticle(
            current,
            article({
                status: 'published',
                categories: [{ id: '8', name: 'Tips', slug: 'tips' }],
                updated_at: '2026-11-02T10:00:00.000Z'
            })
        );
        await drain(current);

        const after = await current.inspect.content.get('posts', entry.id);
        expect(after?.draftRevisionId).toBe(edited?.draftRevisionId);
        expect(after?.liveRevisionId).toBe(edited?.liveRevisionId);
        const terms = await current.inspect.content.terms(
            'posts',
            entry.id,
            'category'
        );
        expect(terms.map((term) => term.slug)).toEqual(['tips']);
        expect(
            await current.inspect.storage.get('articles', ARTICLE_ID)
        ).toMatchObject({ categoryIds: ['8'] });
    });

    it('keeps an adopted entry until the article changes in Aranx', async () => {
        const current = await setup();
        const entry = await current.fixtures.content('posts', {
            slug: 'demarrer-un-blog',
            status: 'published',
            data: { title: 'Démarrer un blog' }
        });
        await current.fixtures.plugin.storage('articles', ARTICLE_ID, {
            entryId: entry.id,
            collection: 'posts',
            aranxUpdatedAt: '1970-01-01T00:00:00.000Z',
            categoryIds: [],
            featuredUrl: null,
            featuredImage: null,
            reported: {
                status: 'published',
                url: 'https://blog.example.com/posts/demarrer-un-blog',
                scheduledAt: null,
                publishError: null
            },
            adopted: true
        });

        await deliver(current, {
            event: 'article.updated',
            article_id: ARTICLE_ID
        });
        await queueArticle(current, article({ status: 'published' }));
        await drain(current);

        const kept = await current.inspect.content.get('posts', entry.id);
        expect(kept?.data.title).toBe('Démarrer un blog');
        expect(kept?.updatedAt).toBe(entry.updatedAt);
        expect(
            await current.inspect.storage.get('articles', ARTICLE_ID)
        ).toMatchObject({
            adopted: false,
            categoryIds: ['7'],
            featuredUrl: FEATURED,
            contentHash: expect.stringMatching(/^[0-9a-f]{64}$/)
        });
        expect(
            current.http.requests().filter((request) => request.url === FEATURED)
        ).toHaveLength(0);
        expect(patches(current)).toHaveLength(0);

        await deliver(current, {
            event: 'article.updated',
            article_id: ARTICLE_ID
        });
        await queueArticle(
            current,
            article({
                title: 'How to start a blog in 2027',
                status: 'published',
                updated_at: '2026-11-02T10:00:00.000Z'
            })
        );
        await drain(current);

        const entries = await current.inspect.content.list('posts');
        expect(entries).toHaveLength(1);
        expect(entries[0]).toMatchObject({
            status: 'published',
            data: { title: 'How to start a blog in 2027' }
        });
    });

    it('moves the entry to the trash when the article is deleted', async () => {
        const current = await setup();
        await deliver(current, {
            event: 'article.published',
            article_id: ARTICLE_ID,
            requested_status: 'draft'
        });
        await queueArticle(current);
        await queueFeatured(current);
        await queuePatch(current);
        await drain(current);
        expect(await current.inspect.content.list('posts')).toHaveLength(1);

        await deliver(current, {
            event: 'article.deleted',
            article_id: ARTICLE_ID
        });
        await current.http.respond(
            `${API}/articles/${ARTICLE_ID}?format=json&image_format=webp`,
            Response.json({ error: 'Article not found' }, { status: 404 })
        );
        await drain(current);

        expect(await current.inspect.content.list('posts')).toHaveLength(0);
        expect(await current.inspect.storage.list('articles')).toHaveLength(0);
    });

    it('reports the new state when an editor unpublishes the entry', async () => {
        const current = await setup();
        await deliver(current, {
            event: 'article.published',
            article_id: ARTICLE_ID,
            requested_status: 'published'
        });
        await queueArticle(current);
        await queueFeatured(current);
        await queuePatch(current);
        await drain(current);
        const [entry] = await current.inspect.content.list('posts');

        await current.http.respond(
            `${API}/articles/${ARTICLE_ID}`,
            Response.json({ id: ARTICLE_ID })
        );
        const result = await current.actions.content.unpublish(
            'posts',
            entry.id
        );
        expect(result).toMatchObject({ success: true });
        await drain(current);

        expect(patches(current).map((patch) => patch.body)).toEqual([
            expect.objectContaining({ status: 'published' }),
            { status: 'draft', url: null }
        ]);
    });
});

describe('change feed', () => {
    it('imports articles as drafts and never publishes them', async () => {
        const current = await setup();
        const params = new URLSearchParams({
            include_deleted: 'true',
            limit: '3',
            updated_after: '1970-01-01T00:00:00Z'
        });
        await current.http.respond(
            `${API}/articles?${params}`,
            Response.json({
                articles: [
                    { ...article(), deleted: false, featured_image: null }
                ],
                pagination: { has_more: false, next_cursor: 'cursor-1' }
            })
        );
        await queueArticle(current);
        await queueFeatured(current);
        await queuePatch(current);

        await current.transport.invokeHook('cron', {
            name: 'feed',
            scheduledAt: new Date().toISOString()
        });
        await drain(current);

        const [entry] = await current.inspect.content.list('posts');
        expect(entry.status).toBe('draft');
        expect(patches(current).map((patch) => patch.body)).toEqual([
            { status: 'draft' }
        ]);
        expect(await current.inspect.kv.get('feed')).toMatchObject({
            cursor: 'cursor-1'
        });
    });

    it('skips new articles created before the conversion', async () => {
        const current = await setup();
        await current.fixtures.plugin.kv('feed', {
            cursor: null,
            lastRunAt: null,
            importAfter: '2026-11-05T00:00:00.000Z'
        });
        const params = new URLSearchParams({
            include_deleted: 'true',
            limit: '3',
            updated_after: '1970-01-01T00:00:00Z'
        });
        await current.http.respond(
            `${API}/articles?${params}`,
            Response.json({
                articles: [
                    { ...article(), deleted: false, featured_image: null }
                ],
                pagination: { has_more: false, next_cursor: 'cursor-1' }
            })
        );

        await current.transport.invokeHook('cron', {
            name: 'feed',
            scheduledAt: new Date().toISOString()
        });
        await drain(current);

        expect(await current.inspect.content.list('posts')).toHaveLength(0);
        expect(
            current.http
                .requests()
                .filter((request) =>
                    request.url.startsWith(`${API}/articles/${ARTICLE_ID}`)
                )
        ).toHaveLength(0);
        expect(await current.inspect.kv.get('feed')).toMatchObject({
            cursor: 'cursor-1',
            importAfter: '2026-11-05T00:00:00.000Z'
        });
    });
});

describe('admin page', () => {
    type Page = { blocks: Array<Record<string, unknown>>; toast?: unknown };

    function find(page: Page, type: string): Record<string, unknown>[] {
        const all: Record<string, unknown>[] = [];
        const walk = (blocks: Array<Record<string, unknown>>) => {
            for (const block of blocks) {
                if (block.type === type) all.push(block);
                if (Array.isArray(block.blocks))
                    walk(block.blocks as Array<Record<string, unknown>>);
                if (Array.isArray(block.columns) && block.type === 'columns')
                    for (const column of block.columns as Array<
                        Array<Record<string, unknown>>
                    >)
                        walk(column);
            }
        };
        walk(page.blocks);
        return all;
    }

    function activityRows(page: Page) {
        const table = find(page, 'table')[0] as { rows: Array<Record<string, unknown>> };
        return table.rows.map((row) => ({
            direction: row.direction,
            event: row.event,
            article: (row.article as { label: string }).label,
            result: row.result
        }));
    }

    function stat(page: Page, label: string) {
        return find(page, 'stats')
            .flatMap((block) => block.items as Array<Record<string, unknown>>)
            .find((item) => item.label === label)?.value;
    }

    async function feedAnswers(current: PluginRuntimeTestHost, response: Response) {
        const params = new URLSearchParams({
            include_deleted: 'true',
            limit: '3',
            updated_after: '1970-01-01T00:00:00Z'
        });
        await current.http.respond(`${API}/articles?${params}`, response);
    }

    async function runFeed(current: PluginRuntimeTestHost) {
        await current.transport
            .invokeHook('cron', {
                name: 'feed',
                scheduledAt: new Date().toISOString()
            })
            .catch(() => undefined);
    }

    it('shows the webhook URL', async () => {
        const current = await setup();
        const page = await current.admin.loadPage('/status');
        expect(JSON.stringify(page)).toContain(
            'https://blog.example.com/_emdash/api/plugins/aranx/webhook'
        );
    });

    it('welcomes a site that is not connected', async () => {
        host = await createPluginRuntimeTestHost();
        const page = (await host.admin.loadPage('/status')) as unknown as Page;
        const [welcome] = find(page, 'empty');
        expect(welcome).toMatchObject({
            title: 'Welcome to Aranx',
            actions: [{ label: 'Connect to Aranx', action_id: 'connect' }]
        });
        expect(find(page, 'accordion')[0]).toMatchObject({
            label: 'What happens when you connect?'
        });
        expect(find(page, 'table')).toHaveLength(0);
    });

    it('lists the import and the report in the sync activity', async () => {
        const current = await setup();
        await deliver(current, {
            event: 'article.published',
            article_id: ARTICLE_ID,
            requested_status: 'published'
        });
        await queueArticle(current);
        await queueFeatured(current);
        await queuePatch(current);
        await drain(current);

        const page = (await current.admin.loadPage('/status')) as unknown as Page;
        expect(activityRows(page)).toEqual([
            {
                direction: 'OUT',
                event: 'Sent status: published',
                article: 'How to start a blog',
                result: 'OK'
            }
        ]);
        const [entry] = await current.inspect.content.list('posts');
        const table = find(page, 'table')[0] as {
            rows: Array<{ article: { target: unknown } }>;
        };
        expect(table.rows[0]!.article.target).toEqual({
            kind: 'content',
            collection: 'posts',
            id: entry!.id
        });
        expect(stat(page, 'Status')).toBe('Active');
        expect(stat(page, 'Articles')).toBe(1);
        expect(stat(page, 'Last event from Aranx')).toBe('Just now');
    });

    it('shows a test event from Aranx as the last event', async () => {
        const current = await setup();
        await deliver(current, { event: 'test' });
        const page = (await current.admin.loadPage('/status')) as unknown as Page;
        const item = find(page, 'stats')
            .flatMap((block) => block.items as Array<Record<string, unknown>>)
            .find((entry) => entry.label === 'Last event from Aranx');
        expect(item).toMatchObject({ value: 'Just now', description: 'test' });
    });

    it('shows where Aranx fields go, with the SEO panel', async () => {
        const current = await setup();
        const page = (await current.admin.loadPage('/status')) as unknown as Page;
        const fields = find(page, 'fields').flatMap(
            (block) => block.fields as Array<{ label: string; value: string }>
        );
        expect(fields).toEqual(
            expect.arrayContaining([
                { label: 'Meta description', value: 'excerpt' },
                { label: 'Featured image', value: 'featured_image' },
                { label: 'SEO title and description', value: 'EmDash SEO panel' }
            ])
        );
    });

    it('says the connection is lost when Aranx refuses the key', async () => {
        const current = await setup();
        await feedAnswers(
            current,
            Response.json({ error: 'invalid_api_key' }, { status: 401 })
        );
        await runFeed(current);

        expect(await current.inspect.kv.get('feed')).toMatchObject({
            error: { status: 401 }
        });
        const page = (await current.admin.loadPage('/status')) as unknown as Page;
        expect(stat(page, 'Status')).toBe('Connection lost');
        expect(find(page, 'banner')).toContainEqual(
            expect.objectContaining({ title: 'Connection lost', variant: 'error' })
        );
        const buttons = find(page, 'actions').flatMap(
            (block) => block.elements as Array<Record<string, unknown>>
        );
        expect(buttons).toContainEqual(
            expect.objectContaining({ label: 'Reconnect', action_id: 'connect' })
        );
    });

    it('clears the feed error after a good run', async () => {
        const current = await setup();
        await current.fixtures.plugin.kv('feed', {
            cursor: null,
            lastRunAt: null,
            importAfter: null,
            error: { message: 'down', status: 503, at: new Date().toISOString() }
        });
        await feedAnswers(
            current,
            Response.json({
                articles: [],
                pagination: { has_more: false, next_cursor: null }
            })
        );
        await runFeed(current);

        expect(await current.inspect.kv.get('feed')).toMatchObject({
            error: null,
            lastRunAt: expect.any(String)
        });
    });

    it('disconnects: deletes the keys and stops the webhook', async () => {
        const current = await setup();
        await deliver(current, { event: 'test' });

        const page = (await current.admin.act('/status', 'disconnect')) as unknown as Page;

        expect(page.toast).toEqual({
            type: 'success',
            message: 'Disconnected from Aranx'
        });
        expect(find(page, 'empty')[0]).toMatchObject({ title: 'Welcome to Aranx' });
        expect(find(page, 'banner')).toContainEqual(
            expect.objectContaining({ title: 'Disconnected from Aranx' })
        );
        expect(await current.inspect.setting('apiKey')).toBeNull();
        expect(await current.inspect.setting('webhookSecret')).toBeNull();
        // The pin stays, so a new connection to the same website resumes.
        expect(await current.inspect.kv.get('websiteId')).toBe(WEBSITE_ID);

        const response = await deliver(current, { event: 'test' });
        expect(response.status).toBe(401);
        expect(await response.json()).toEqual({ error: 'disconnected' });
    });
});
