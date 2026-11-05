import type { PluginContext } from 'emdash/plugin';
import type { ContentNode } from './portable-text';

/**
 * Client for the Aranx public API. Every request goes through
 * `ctx.http.fetch`, which counts toward the sandbox subrequest limit.
 * Docs: https://docs.aranx.com/api-reference/introduction
 */

export const DEFAULT_API_BASE_URL = 'https://aranx.com/api/v1/public';

export class AranxApiError extends Error {
    constructor(
        readonly status: number,
        message: string
    ) {
        super(message);
        this.name = 'AranxApiError';
    }
}

export type ArticleStatus =
    | 'unpublished'
    | 'draft'
    | 'pending'
    | 'private'
    | 'scheduled'
    | 'published';

export interface AranxImage {
    url: string;
    alt: string | null;
    width: number | null;
    height: number | null;
}

export interface AranxCategory {
    id: string;
    name: string;
    slug: string;
}

export interface AranxArticle {
    id: string;
    title: string;
    slug: string | null;
    metaTitle: string | null;
    metaDescription: string | null;
    categories: AranxCategory[];
    content: (ContentNode | string)[];
    images: AranxImage[];
    status: ArticleStatus;
    url: string | null;
    updatedAt: string;
}

export interface FeedItem {
    id: string;
    deleted: boolean;
    updatedAt: string;
}

export interface FeedPage {
    items: FeedItem[];
    hasMore: boolean;
    nextCursor: string | null;
}

export interface ApiConfig {
    apiKey: string;
    baseUrl: string;
}

type JsonRecord = Record<string, unknown>;

function isRecord(value: unknown): value is JsonRecord {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function str(value: unknown): string | null {
    return typeof value === 'string' ? value : null;
}

function num(value: unknown): number | null {
    return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function invalid(what: string): never {
    throw new AranxApiError(502, `Aranx API returned an invalid ${what}`);
}

function parseNodes(value: unknown, depth = 0): (ContentNode | string)[] {
    if (!Array.isArray(value) || depth > 64) return invalid('article body');
    return value.map((item): ContentNode | string => {
        if (typeof item === 'string') return item;
        if (!isRecord(item) || typeof item.tag !== 'string')
            return invalid('article body');
        const node: ContentNode = { tag: item.tag.toLowerCase() };
        if (isRecord(item.attributes)) {
            const attributes: Record<string, string> = {};
            for (const [name, attribute] of Object.entries(item.attributes)) {
                if (typeof attribute === 'string') attributes[name] = attribute;
                else if (typeof attribute === 'number')
                    attributes[name] = String(attribute);
            }
            node.attributes = attributes;
        }
        if (item.children !== undefined)
            node.children = parseNodes(item.children, depth + 1);
        return node;
    });
}

function parseCategories(body: JsonRecord): AranxCategory[] {
    if (Array.isArray(body.categories)) {
        return body.categories.flatMap((item) => {
            if (!isRecord(item)) return [];
            const id =
                str(item.id) ??
                (num(item.id) === null ? null : String(item.id));
            const name = str(item.name);
            if (!id || !name) return [];
            return [{ id, name, slug: str(item.slug) ?? '' }];
        });
    }
    return [];
}

export function parseArticle(body: unknown): AranxArticle {
    if (!isRecord(body)) return invalid('article');
    const id = str(body.id);
    const title = str(body.title);
    const updatedAt = str(body.updated_at);
    if (!id || title === null || !updatedAt) return invalid('article');
    if (body.content_format !== undefined && body.content_format !== 'json') {
        return invalid('article format');
    }
    const images = Array.isArray(body.images)
        ? body.images.flatMap((image): AranxImage[] => {
              if (!isRecord(image) || !str(image.url)) return [];
              return [
                  {
                      url: String(image.url),
                      alt: str(image.alt),
                      width: num(image.width),
                      height: num(image.height)
                  }
              ];
          })
        : [];
    return {
        id,
        title,
        slug: str(body.slug),
        metaTitle: str(body.meta_title),
        metaDescription: str(body.meta_description),
        categories: parseCategories(body),
        content: parseNodes(body.content),
        images,
        status: (str(body.status) as ArticleStatus | null) ?? 'unpublished',
        url: str(body.url),
        updatedAt
    };
}

export function parseFeedPage(body: unknown): FeedPage {
    if (
        !isRecord(body) ||
        !Array.isArray(body.articles) ||
        !isRecord(body.pagination)
    ) {
        return invalid('article list');
    }
    const items = body.articles.map((item): FeedItem => {
        if (!isRecord(item) || !str(item.id) || !str(item.updated_at)) {
            return invalid('article list');
        }
        return {
            id: String(item.id),
            deleted: item.deleted === true,
            updatedAt: String(item.updated_at)
        };
    });
    return {
        items,
        hasMore: body.pagination.has_more === true,
        nextCursor: str(body.pagination.next_cursor)
    };
}

async function request(
    ctx: PluginContext,
    config: ApiConfig,
    path: string,
    init: RequestInit = {}
): Promise<unknown> {
    if (!ctx.http)
        throw new AranxApiError(
            0,
            'The network:request capability is not granted'
        );
    const response = await ctx.http.fetch(`${config.baseUrl}${path}`, {
        ...init,
        headers: {
            Authorization: `Bearer ${config.apiKey}`,
            Accept: 'application/json',
            ...(init.body ? { 'Content-Type': 'application/json' } : {})
        }
    });
    if (!response.ok) {
        const body: unknown = await response.json().catch(() => null);
        const message =
            isRecord(body) && typeof body.error === 'string' ? body.error : '';
        throw new AranxApiError(
            response.status,
            `Aranx API ${init.method ?? 'GET'} ${path} failed with ${response.status}${message ? `: ${message}` : ''}`
        );
    }
    return response.json();
}

/** Returns the article with a JSON body and WebP images, or null on 404. */
export async function getArticle(
    ctx: PluginContext,
    config: ApiConfig,
    articleId: string
): Promise<AranxArticle | null> {
    try {
        return parseArticle(
            await request(
                ctx,
                config,
                `/articles/${encodeURIComponent(articleId)}?format=json&image_format=webp`
            )
        );
    } catch (error) {
        if (error instanceof AranxApiError && error.status === 404) return null;
        throw error;
    }
}

/**
 * Reads one page of the change feed. Without a cursor, the feed starts at the
 * first article. Trashed articles come back with `deleted: true`.
 */
export async function getFeedPage(
    ctx: PluginContext,
    config: ApiConfig,
    cursor: string | null,
    limit: number
): Promise<FeedPage> {
    const params = new URLSearchParams({
        include_deleted: 'true',
        limit: String(limit)
    });
    if (cursor) params.set('cursor', cursor);
    else params.set('updated_after', '1970-01-01T00:00:00Z');
    return parseFeedPage(await request(ctx, config, `/articles?${params}`));
}

export interface ArticleReport {
    status: ArticleStatus;
    url?: string | null;
    published_at?: string;
    scheduled_at?: string;
}

/** Reports the state of the article on this site. A 404 means it is in the Aranx trash. */
export async function reportArticle(
    ctx: PluginContext,
    config: ApiConfig,
    articleId: string,
    report: ArticleReport
): Promise<void> {
    await request(ctx, config, `/articles/${encodeURIComponent(articleId)}`, {
        method: 'PATCH',
        body: JSON.stringify(report)
    });
}
