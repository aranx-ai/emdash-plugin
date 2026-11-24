import type { PluginContext } from 'emdash/plugin';

/**
 * Plugin state. The `articles` storage collection links each Aranx article
 * ID to its EmDash entry. KV holds the change feed position, the category
 * map, the website ID, the state of the connection to Aranx, and, on a site
 * without `EMDASH_ENCRYPTION_KEY`, the API key and webhook secret.
 */

export interface ReportedState {
    status: string;
    url: string | null;
    scheduledAt: string | null;
    /** The `publish_error` that Aranx holds. Older records lack it. */
    publishError: string | null;
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
    /** SHA-256 of the Aranx fields written to the entry. Older records lack it. */
    contentHash: string | null;
    /**
     * The entry existed before the plugin, for example a post migrated from
     * WordPress, and a conversion script linked it. The first import records
     * the content hash and leaves the entry as it is.
     */
    adopted: boolean;
}

export interface FeedState {
    cursor: string | null;
    lastRunAt: string | null;
    /**
     * Set by a conversion script, never by the plugin. The feed does not
     * import a new article created before this time: it predates the
     * plugin and was never on the site.
     */
    importAfter: string | null;
}

const FEED_KEY = 'feed';
const CATEGORY_TERMS_KEY = 'categoryTerms';
const WEBSITE_ID_KEY = 'websiteId';
const CONNECT_KEY = 'connect';
const CREDENTIALS_KEY = 'credentials';

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
        scheduledAt: stringOrNull(value.scheduledAt),
        publishError: stringOrNull(value.publishError)
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
        reported: toReported(value.reported),
        contentHash: stringOrNull(value.contentHash),
        adopted: value.adopted === true
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
        lastRunAt: isRecord(value) ? stringOrNull(value.lastRunAt) : null,
        importAfter: isRecord(value) ? stringOrNull(value.importAfter) : null
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

/**
 * The connection to Aranx made with the "Connect to Aranx" button or an
 * Aranx "Reconnect".
 *
 * - `started`: the admin opened the Aranx approval page. `state` and
 *   `verifier` wait for the callback.
 * - `pending`: the new keys are stored here, and Aranx has not confirmed
 *   them yet. Aranx still accepts the old key and signs with the old secret.
 * - `connected`: Aranx confirmed the keys.
 * - `failed`: the last attempt failed. `error` says what to do next.
 */
export interface ConnectState {
    status: 'started' | 'pending' | 'connected' | 'failed';
    /** ISO time of the last change. */
    at: string;
    state: string | null;
    verifier: string | null;
    /** The ID that the confirm call sends to Aranx. */
    confirmationId: string | null;
    /** Where the keys are: encrypted settings, or plugin KV in plain text. */
    storage: 'settings' | 'kv' | null;
    error: string | null;
}

export async function readConnectState(
    ctx: PluginContext
): Promise<ConnectState | null> {
    const value = await ctx.kv.get<unknown>(CONNECT_KEY);
    if (!isRecord(value)) return null;
    const status = value.status;
    if (
        status !== 'started' &&
        status !== 'pending' &&
        status !== 'connected' &&
        status !== 'failed'
    )
        return null;
    return {
        status,
        at: stringOrNull(value.at) ?? '',
        state: stringOrNull(value.state),
        verifier: stringOrNull(value.verifier),
        confirmationId: stringOrNull(value.confirmationId),
        storage:
            value.storage === 'settings' || value.storage === 'kv'
                ? value.storage
                : null,
        error: stringOrNull(value.error)
    };
}

export function writeConnectState(
    ctx: PluginContext,
    state: Omit<ConnectState, 'at'>
): Promise<void> {
    return ctx.kv.set(CONNECT_KEY, { ...state, at: new Date().toISOString() });
}

export interface StoredCredentials {
    apiKey: string;
    webhookSecret: string;
}

/** The keys kept in plain text, for a site without `EMDASH_ENCRYPTION_KEY`. */
export async function readPlainCredentials(
    ctx: PluginContext
): Promise<StoredCredentials | null> {
    const value = await ctx.kv.get<unknown>(CREDENTIALS_KEY);
    if (
        !isRecord(value) ||
        typeof value.apiKey !== 'string' ||
        typeof value.webhookSecret !== 'string' ||
        !value.apiKey ||
        !value.webhookSecret
    )
        return null;
    return { apiKey: value.apiKey, webhookSecret: value.webhookSecret };
}

export function writePlainCredentials(
    ctx: PluginContext,
    credentials: StoredCredentials
): Promise<void> {
    return ctx.kv.set(CREDENTIALS_KEY, credentials);
}

export function deletePlainCredentials(ctx: PluginContext): Promise<boolean> {
    return ctx.kv.delete(CREDENTIALS_KEY);
}
