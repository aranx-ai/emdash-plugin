import type { PluginContext } from 'emdash/plugin';

/**
 * Plugin state. The `articles` storage collection links each Aranx article
 * ID to its EmDash entry. KV holds the change feed position, the category
 * map, and the website ID.
 */

export interface ReportedState {
    status: string;
    url: string | null;
    scheduledAt: string | null;
}

export interface ArticleRecord {
    entryId: string;
    collection: string;
    aranxUpdatedAt: string;
    /** Aranx IDs of the categories assigned at the last sync. */
    categoryIds: string[];
    featuredUrl: string | null;
    featuredImage: Record<string, unknown> | null;
    reported: ReportedState | null;
}

export interface FeedState {
    cursor: string | null;
    lastRunAt: string | null;
}

const FEED_KEY = 'feed';
const CATEGORY_TERMS_KEY = 'categoryTerms';
const WEBSITE_ID_KEY = 'websiteId';

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function stringOrNull(value: unknown): string | null {
    return typeof value === 'string' ? value : null;
}

function toReported(value: unknown): ReportedState | null {
    if (!isRecord(value) || typeof value.status !== 'string') return null;
    return {
        status: value.status,
        url: stringOrNull(value.url),
        scheduledAt: stringOrNull(value.scheduledAt)
    };
}

export function toArticleRecord(value: unknown): ArticleRecord | null {
    if (!isRecord(value)) return null;
    if (
        typeof value.entryId !== 'string' ||
        typeof value.collection !== 'string'
    )
        return null;
    return {
        entryId: value.entryId,
        collection: value.collection,
        aranxUpdatedAt: stringOrNull(value.aranxUpdatedAt) ?? '',
        categoryIds: Array.isArray(value.categoryIds)
            ? value.categoryIds.filter(
                  (id): id is string => typeof id === 'string'
              )
            : [],
        featuredUrl: stringOrNull(value.featuredUrl),
        featuredImage: isRecord(value.featuredImage)
            ? value.featuredImage
            : null,
        reported: toReported(value.reported)
    };
}

export function articles(ctx: PluginContext) {
    const collection = ctx.storage.articles;
    return {
        async get(articleId: string): Promise<ArticleRecord | null> {
            return toArticleRecord(await collection.get(articleId));
        },
        async getMany(
            articleIds: string[]
        ): Promise<Map<string, ArticleRecord>> {
            const found = new Map<string, ArticleRecord>();
            if (articleIds.length === 0) return found;
            for (const [id, value] of await collection.getMany(articleIds)) {
                const record = toArticleRecord(value);
                if (record) found.set(id, record);
            }
            return found;
        },
        async findByEntry(
            entryId: string
        ): Promise<{ articleId: string; record: ArticleRecord } | null> {
            const page = await collection.query({
                where: { entryId },
                limit: 1
            });
            const item = page.items[0];
            const record = item ? toArticleRecord(item.data) : null;
            return item && record ? { articleId: item.id, record } : null;
        },
        put(articleId: string, record: ArticleRecord): Promise<void> {
            return collection.put(articleId, record);
        },
        delete(articleId: string): Promise<boolean> {
            return collection.delete(articleId);
        },
        count(): Promise<number> {
            return collection.count();
        }
    };
}

export async function readFeedState(ctx: PluginContext): Promise<FeedState> {
    const value = await ctx.kv.get<unknown>(FEED_KEY);
    return {
        cursor: isRecord(value) ? stringOrNull(value.cursor) : null,
        lastRunAt: isRecord(value) ? stringOrNull(value.lastRunAt) : null
    };
}

export function writeFeedState(
    ctx: PluginContext,
    state: FeedState
): Promise<void> {
    return ctx.kv.set(FEED_KEY, state);
}

/** Aranx category ID to EmDash term ID. */
export async function readCategoryTerms(
    ctx: PluginContext
): Promise<Record<string, string>> {
    const value = await ctx.kv.get<unknown>(CATEGORY_TERMS_KEY);
    const map: Record<string, string> = {};
    if (isRecord(value)) {
        for (const [id, termId] of Object.entries(value)) {
            if (typeof termId === 'string') map[id] = termId;
        }
    }
    return map;
}

export function writeCategoryTerms(
    ctx: PluginContext,
    map: Record<string, string>
): Promise<void> {
    return ctx.kv.set(CATEGORY_TERMS_KEY, map);
}

export async function readWebsiteId(
    ctx: PluginContext
): Promise<string | null> {
    return stringOrNull(await ctx.kv.get<unknown>(WEBSITE_ID_KEY));
}

export function writeWebsiteId(
    ctx: PluginContext,
    websiteId: string
): Promise<void> {
    return ctx.kv.set(WEBSITE_ID_KEY, websiteId);
}
