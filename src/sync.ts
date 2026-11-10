import type { PluginContext } from 'emdash/plugin';
import {
    AranxApiError,
    getArticle,
    getFeedPage,
    reportArticle,
    type AranxArticle,
    type AranxCategory,
    type AranxImage,
    type ArticleReport,
    type ArticleStatus
} from './aranx-api';
import { apiConfig, readConfig } from './config';
import {
    bodyImageSources,
    toPortableText,
    type ImageSize
} from './portable-text';
import {
    articles,
    readCategoryTerms,
    readFeedState,
    writeCategoryTerms,
    writeFeedState,
    type ArticleRecord,
    type ReportedState
} from './store';
import { scheduleTask, type RequestedStatus, type Task } from './tasks';

/**
 * Integration contract: docs/.mintlify/skills/aranx-api-integration/SKILL.md
 * in the Aranx repository. Each function below stays within the sandbox
 * budget of 10 subrequests. The comments count the worst case.
 */

type ContentItem = NonNullable<
    Awaited<ReturnType<NonNullable<PluginContext['content']>['get']>>
>;
type CollectionSchema = NonNullable<
    Awaited<ReturnType<NonNullable<PluginContext['schema']>['getCollection']>>
>;

/** A feed page costs 4 calls plus one per article to import, and 2 to finish. */
const FEED_PAGE_SIZE = 3;
/** New terms per article import. Later imports create the rest. */
const MAX_NEW_TERMS = 2;

function errorCode(error: unknown): string | null {
    return typeof error === 'object' &&
        error !== null &&
        'code' in error &&
        typeof error.code === 'string'
        ? error.code
        : null;
}

interface FieldMap {
    title: string;
    body: string;
    excerpt: string | null;
    image: string | null;
    seo: boolean;
}

/** Fits the article to the collection's own fields. */
export function mapFields(schema: CollectionSchema): FieldMap {
    const fields = schema.fields;
    const byType = (type: string) =>
        fields.filter((field) => field.type === type);
    const named = (slugs: string[], types: string[]) =>
        slugs
            .map((slug) =>
                fields.find(
                    (field) => field.slug === slug && types.includes(field.type)
                )
            )
            .find(Boolean)?.slug ?? null;

    const title = schema.titleField ?? named(['title', 'name'], ['string']);
    const body =
        named(['content', 'body'], ['portableText']) ??
        byType('portableText')[0]?.slug;
    if (!title || !body) {
        throw new Error(
            `Collection "${schema.slug}" needs a string title field and a Portable Text field`
        );
    }
    return {
        title,
        body,
        excerpt: named(
            ['excerpt', 'summary', 'description'],
            ['text', 'string']
        ),
        image:
            named(
                ['featured_image', 'featuredImage', 'image', 'cover'],
                ['image']
            ) ??
            byType('image')[0]?.slug ??
            null,
        seo: schema.hasSeo
    };
}

/** The featured image is the item of `images` whose URL is not in the body. */
export function featuredImageOf(article: AranxArticle): AranxImage | null {
    const inBody = bodyImageSources(article.content);
    return article.images.find((image) => !inBody.has(image.url)) ?? null;
}

const IMAGE_TYPES: Record<string, string> = {
    webp: 'image/webp',
    png: 'image/png',
    jpg: 'image/jpeg',
    jpeg: 'image/jpeg',
    gif: 'image/gif',
    avif: 'image/avif'
};

function imageDimensions(image: AranxImage) {
    return image.width && image.height
        ? { width: image.width, height: image.height }
        : {};
}

/**
 * Copies the image to the EmDash media library (2 calls). Falls back to the
 * Aranx CDN URL, which is public and permanent.
 */
async function featuredImageValue(
    ctx: PluginContext,
    image: AranxImage
): Promise<Record<string, unknown>> {
    const alt = image.alt ? { alt: image.alt } : {};
    const external = {
        id: '',
        src: image.url,
        ...alt,
        ...imageDimensions(image)
    };
    if (!ctx.media?.upload || !ctx.http) return external;
    try {
        const response = await ctx.http.fetch(image.url);
        if (!response.ok) return external;
        const filename = decodeURIComponent(
            new URL(image.url).pathname.split('/').pop() || 'image'
        );
        const extension = filename.split('.').pop()?.toLowerCase() ?? '';
        const mimeType =
            response.headers.get('content-type')?.split(';')[0].trim() ||
            IMAGE_TYPES[extension] ||
            '';
        if (!mimeType.startsWith('image/')) return external;
        const uploaded = await ctx.media.upload(
            filename,
            mimeType,
            await response.arrayBuffer()
        );
        return {
            id: uploaded.mediaId,
            provider: 'local',
            mimeType,
            filename,
            meta: { storageKey: uploaded.storageKey },
            ...alt,
            ...imageDimensions(image)
        };
    } catch {
        return external;
    }
}

function sameIds(a: string[], b: string[]): boolean {
    return a.length === b.length && a.every((id, index) => id === b[index]);
}

/**
 * Step 1. Saves the article as an EmDash entry. New entries are drafts.
 * Worst case: 9 calls.
 */
export async function runArticleTask(
    ctx: PluginContext,
    articleId: string,
    requestedStatus: RequestedStatus | null
): Promise<void> {
    const config = await readConfig(ctx); // 1
    const article = await getArticle(ctx, apiConfig(config), articleId); // 2
    const store = articles(ctx);
    const record = await store.get(articleId); // 3
    const writer = ctx.content;
    if (!writer?.create || !writer.update || !writer.delete) {
        throw new Error('The content:write capability is not granted');
    }

    if (!article) {
        // In the Aranx trash or deleted. Move the copy to the EmDash trash.
        if (record) {
            await writer
                .delete(record.collection, record.entryId)
                .catch((error: unknown) => {
                    if (errorCode(error) !== 'NOT_FOUND') throw error;
                }); // 4
            await store.delete(articleId); // 5
        }
        return;
    }

    const categoryIds = article.categories.map((category) => category.id);
    if (record && record.aranxUpdatedAt === article.updatedAt) {
        // Nothing changed. A repeated `article.published` may still ask to publish.
        if (requestedStatus) {
            await scheduleTask(ctx, {
                kind: 'publish',
                articleId,
                entryId: record.entryId,
                collection: record.collection,
                requestedStatus
            });
        }
        return;
    }

    const collection = record?.collection ?? config.collection;
    if (!ctx.schema)
        throw new Error('The schema:read capability is not granted');
    const schema = await ctx.schema.getCollection(collection); // 4
    if (!schema) throw new Error(`Collection "${collection}" does not exist`);
    const fields = mapFields(schema);

    const featured = featuredImageOf(article);
    let featuredImage = record?.featuredImage ?? null;
    if (fields.image && featured && featured.url !== record?.featuredUrl) {
        featuredImage = await featuredImageValue(ctx, featured); // 5, 6
    }

    const imageSizes = new Map<string, ImageSize>(
        article.images.map((image) => [image.url, image])
    );
    const data: Record<string, unknown> = {
        [fields.title]: article.title,
        [fields.body]: toPortableText(article.content, imageSizes)
    };
    if (fields.excerpt) data[fields.excerpt] = article.metaDescription ?? '';
    if (fields.image && featuredImage && featured)
        data[fields.image] = featuredImage;
    // EmDash 1.4 accepts `seo` on create only. The sandbox update path
    // rejects it as an unknown field, so updates keep the first SEO values.
    if (fields.seo && !record) {
        data.seo = {
            title: article.metaTitle,
            description: article.metaDescription,
            image: featured?.url ?? null
        };
    }

    let entryId: string;
    if (record) {
        try {
            entryId = (await writer.update(collection, record.entryId, data))
                .id; // 7
        } catch (error) {
            // An editor moved the entry to the trash. Keep it there.
            if (errorCode(error) === 'NOT_FOUND') return;
            throw error;
        }
    } else {
        entryId = (await writer.create(collection, data)).id; // 7
    }

    await store.put(articleId, {
        entryId,
        collection,
        aranxUpdatedAt: article.updatedAt,
        categoryIds,
        featuredUrl: featured?.url ?? null,
        featuredImage: featured ? featuredImage : null,
        reported: record?.reported ?? null
    }); // 8

    const categoriesChanged = !sameIds(categoryIds, record?.categoryIds ?? []);
    await scheduleTask(
        ctx,
        categoriesChanged
            ? {
                  kind: 'terms',
                  articleId,
                  entryId,
                  collection,
                  categories: article.categories,
                  requestedStatus
              }
            : {
                  kind: 'publish',
                  articleId,
                  entryId,
                  collection,
                  requestedStatus
              }
    ); // 9
}

/**
 * Step 2. Assigns EmDash terms for the Aranx categories and removes terms
 * that came from Aranx but are no longer assigned. Terms that an editor
 * added stay. Worst case: 9 calls.
 */
export async function runTermsTask(
    ctx: PluginContext,
    task: Extract<Task, { kind: 'terms' }>
): Promise<void> {
    const taxonomies = ctx.taxonomies;
    try {
        if (
            !taxonomies?.createTerm ||
            !taxonomies.addEntryTerms ||
            !taxonomies.removeEntryTerms
        ) {
            throw new Error('The taxonomies:write capability is not granted');
        }
        const { taxonomy } = await readConfig(ctx); // 1
        const map = await readCategoryTerms(ctx); // 2
        const missing = task.categories.filter((category) => !map[category.id]);
        let changed = false;
        if (missing.length > 0) {
            const terms = await taxonomies.getTerms(taxonomy); // 3
            const bySlug = new Map(terms.map((term) => [term.slug, term.id]));
            let created = 0;
            for (const category of missing) {
                const existing = category.slug
                    ? bySlug.get(category.slug)
                    : undefined;
                if (existing) {
                    map[category.id] = existing;
                } else if (created < MAX_NEW_TERMS) {
                    const term = await taxonomies.createTerm(taxonomy, {
                        label: category.name,
                        ...(category.slug ? { slug: category.slug } : {})
                    }); // 4, 5
                    map[category.id] = term.id;
                    created++;
                } else {
                    continue;
                }
                changed = true;
            }
            if (changed) await writeCategoryTerms(ctx, map); // 6
        }

        const wanted = new Set(
            task.categories.flatMap(
                (category: AranxCategory) => map[category.id] ?? []
            )
        );
        const managed = new Set(Object.values(map));
        const current = await taxonomies.getEntryTerms(
            task.collection,
            task.entryId,
            { taxonomy }
        ); // 7
        const currentIds = new Set(current.map((term) => term.id));
        const add = [...wanted].filter((id) => !currentIds.has(id));
        const remove = [...currentIds].filter(
            (id) => managed.has(id) && !wanted.has(id)
        );
        if (add.length > 0)
            await taxonomies.addEntryTerms(
                task.collection,
                task.entryId,
                taxonomy,
                add
            ); // 8
        if (remove.length > 0) {
            await taxonomies.removeEntryTerms(
                task.collection,
                task.entryId,
                taxonomy,
                remove
            ); // 9
        }
    } catch (error) {
        // Categories are optional. A site without the taxonomy still gets the post.
        ctx.log.warn('Could not assign Aranx categories', {
            articleId: task.articleId,
            error: error instanceof Error ? error.message : String(error)
        });
    }
    await scheduleTask(ctx, {
        kind: 'publish',
        articleId: task.articleId,
        entryId: task.entryId,
        collection: task.collection,
        requestedStatus: task.requestedStatus
    }); // 10
}

/**
 * Step 3. Publishes when Aranx asks, or when the entry is live and has new
 * changes. A `draft` request never takes a live entry down. Then reports the
 * state. Worst case: 9 calls.
 */
export async function runPublishTask(
    ctx: PluginContext,
    task: Extract<Task, { kind: 'publish' }>
): Promise<void> {
    const publisher = ctx.content;
    if (!publisher?.getVersioned || !publisher.publish) {
        throw new Error('The content:publish capability is not granted');
    }
    const versioned = await publisher.getVersioned(
        task.collection,
        task.entryId
    ); // 1
    if (!versioned) {
        await reportEntry(ctx, task.articleId, null);
        return;
    }
    let item = versioned.item;
    const live = item.status === 'published';
    const hasChanges =
        !live ||
        (item.draftRevisionId != null &&
            item.draftRevisionId !== item.liveRevisionId);
    const shouldPublish =
        (task.requestedStatus === 'published' || live) && hasChanges;
    if (shouldPublish) {
        try {
            item = (
                await publisher.publish(task.collection, task.entryId, {
                    _rev: versioned._rev
                })
            ).item; // 2
        } catch (error) {
            // A site plugin refused the publish through `content:beforePublish`,
            // for example because the entry has no category. A retry gets the
            // same answer, so report the unchanged entry and end the task.
            if (errorCode(error) !== 'PUBLISH_REJECTED') throw error;
            ctx.log.warn('The site refused to publish the Aranx article', {
                articleId: task.articleId,
                reason: error instanceof Error ? error.message : String(error)
            }); // 3
        }
    }
    await reportEntry(ctx, task.articleId, item); // 4 to 9
}

/** Reports the entry state after an editor changes it. Worst case: 6 calls. */
export async function runReportTask(
    ctx: PluginContext,
    task: Extract<Task, { kind: 'report' }>
): Promise<void> {
    if (task.gone) {
        await reportEntry(ctx, task.articleId, null);
        return;
    }
    const record = await articles(ctx).get(task.articleId); // 1
    if (!record) return;
    const item =
        (await ctx.content?.get(record.collection, record.entryId)) ?? null; // 2
    await reportEntry(ctx, task.articleId, item, record);
}

function toIso(value: string | null | undefined): string | undefined {
    if (!value) return undefined;
    const time = Date.parse(value);
    return Number.isNaN(time) ? undefined : new Date(time).toISOString();
}

/** Maps an EmDash entry state to the Aranx article status. */
export function buildReport(
    ctx: PluginContext,
    item: ContentItem | null,
    publicUrl: string | null,
    previous: ReportedState | null
): { report: ArticleReport; state: ReportedState } {
    const url =
        publicUrl && publicUrl.startsWith('/') ? ctx.url(publicUrl) : publicUrl;
    let status: ArticleStatus = 'unpublished';
    if (item?.status === 'published') status = 'published';
    else if (item?.status === 'scheduled') status = 'scheduled';
    else if (item?.status === 'draft') status = 'draft';

    const report: ArticleReport = { status };
    const scheduledAt =
        status === 'scheduled' ? (toIso(item?.scheduledAt) ?? null) : null;
    if (status === 'published') {
        if (url) report.url = url;
        const publishedAt = toIso(item?.publishedAt);
        if (previous?.status !== 'published' && publishedAt)
            report.published_at = publishedAt;
    } else if (previous?.url) {
        report.url = null;
    }
    if (status === 'scheduled') {
        if (scheduledAt) report.scheduled_at = scheduledAt;
        else report.status = 'draft';
    }
    return {
        report,
        state: {
            status: report.status,
            url:
                report.url === undefined ? (previous?.url ?? null) : report.url,
            scheduledAt
        }
    };
}

/**
 * Sends `PATCH /articles/{id}` when the state differs from the last report.
 * Worst case: 6 calls.
 */
async function reportEntry(
    ctx: PluginContext,
    articleId: string,
    item: ContentItem | null,
    knownRecord?: ArticleRecord
): Promise<void> {
    const store = articles(ctx);
    const config = await readConfig(ctx); // 1
    const record = knownRecord ?? (await store.get(articleId)); // 2
    const publicUrl =
        item?.status === 'published' && record && ctx.content?.getPublicUrl
            ? await ctx.content.getPublicUrl(record.collection, record.entryId) // 3
            : null;
    const { report, state } = buildReport(
        ctx,
        item,
        publicUrl,
        record?.reported ?? null
    );
    const previous = record?.reported;
    if (
        previous &&
        previous.status === state.status &&
        previous.url === state.url &&
        previous.scheduledAt === state.scheduledAt
    ) {
        return;
    }
    try {
        await reportArticle(ctx, apiConfig(config), articleId, report); // 4
    } catch (error) {
        // 404: the article is in the Aranx trash. The next event removes the copy.
        if (error instanceof AranxApiError && error.status === 404) return;
        throw error;
    }
    if (record) await store.put(articleId, { ...record, reported: state }); // 5
}

export interface FeedResult {
    scheduled: number;
    hasMore: boolean;
}

/**
 * Reads one page of the change feed and queues an import for each new,
 * changed, or trashed article. Stores the cursor after the page, so a crash
 * repeats a page and never skips one. Worst case: 9 calls.
 */
export async function runFeedTask(ctx: PluginContext): Promise<FeedResult> {
    const config = await readConfig(ctx); // 1
    if (!config.apiKey) return { scheduled: 0, hasMore: false };
    const state = await readFeedState(ctx); // 2
    const page = await getFeedPage(
        ctx,
        apiConfig(config),
        state.cursor,
        FEED_PAGE_SIZE
    ); // 3
    const stored = await articles(ctx).getMany(
        page.items.map((item) => item.id)
    ); // 4

    let scheduled = 0;
    for (const item of page.items) {
        const record = stored.get(item.id);
        const needsImport = item.deleted
            ? Boolean(record)
            : !record ||
              Date.parse(record.aranxUpdatedAt) < Date.parse(item.updatedAt);
        if (!needsImport) continue;
        // The feed never publishes: no requested status.
        await scheduleTask(ctx, {
            kind: 'article',
            articleId: item.id,
            requestedStatus: null
        }); // 5 to 7
        scheduled++;
    }

    await writeFeedState(ctx, {
        cursor: page.nextCursor ?? state.cursor,
        lastRunAt: new Date().toISOString()
    }); // 8
    // Without a new position, the next request would repeat this page.
    const hasMore = page.hasMore && Boolean(page.nextCursor);
    if (hasMore) await scheduleTask(ctx, { kind: 'feed' }); // 9
    return { scheduled, hasMore };
}
