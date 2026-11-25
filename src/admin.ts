import type { PluginContext } from 'emdash/plugin';
import {
    configFrom,
    readSettings,
    type PluginConfig
} from './config';
import {
    PLUGIN_VERSION,
    disconnect,
    dropPlainCredentials,
    startConnect
} from './connect';
import {
    articles,
    readPluginState,
    type ArticleRecord,
    type ConnectState,
    type PluginState
} from './store';
import { isAuthError, mapFields } from './sync';
import { scheduleTask } from './tasks';

/**
 * The Aranx admin page. It follows the dashboard of the Aranx WordPress
 * plugin: a welcome page before the first connection, then the connection
 * status, the recent sync activity, and how articles fit the collection.
 * Worst case: 8 calls.
 */

/** The Aranx dashboard. The plugin page links to the website in it. */
export const ARANX_APP_URL = 'https://app.aranx.com';
/** The feed runs every 15 minutes. A gap of an hour means cron stopped. */
const SYNC_OVERDUE_MS = 60 * 60 * 1000;
const ACTIVITY_PAGE_SIZE = 8;
const MAX_TITLE_LENGTH = 60;
const MAX_REASON_LENGTH = 120;

/**
 * The route path uses the plugin ID. A registry install gets a hashed ID
 * (`r_...`), so read it from the context instead of using the slug.
 */
export function webhookPath(pluginId: string): string {
    return `/_emdash/api/plugins/${encodeURIComponent(pluginId)}/webhook`;
}

export function consoleUrl(websiteId: string | null): string {
    return websiteId
        ? `${ARANX_APP_URL}/websites/${encodeURIComponent(websiteId)}/content/posts`
        : ARANX_APP_URL;
}

export function publishingUrl(websiteId: string | null): string {
    return websiteId
        ? `${ARANX_APP_URL}/websites/${encodeURIComponent(websiteId)}/publishing`
        : ARANX_APP_URL;
}

interface Interaction {
    type: string;
    actionId: string | null;
    value: unknown;
}

function parseInteraction(input: unknown): Interaction {
    if (typeof input !== 'object' || input === null)
        return { type: 'page_load', actionId: null, value: null };
    const type =
        'type' in input && typeof input.type === 'string'
            ? input.type
            : 'page_load';
    const actionId =
        'action_id' in input && typeof input.action_id === 'string'
            ? input.action_id
            : null;
    const value = 'value' in input ? input.value : null;
    return { type, actionId, value };
}

function cursorOf(value: unknown): string | undefined {
    return typeof value === 'object' &&
        value !== null &&
        'cursor' in value &&
        typeof value.cursor === 'string' &&
        value.cursor
        ? value.cursor
        : undefined;
}

type Toast = { type: 'success' | 'error' | 'info'; message: string };
type Block = Record<string, unknown>;

/** "5 min ago". `now` comes from the caller, so tests can fix it. */
export function timeAgo(iso: string | null, now: number): string | null {
    if (!iso) return null;
    const time = Date.parse(iso);
    if (!Number.isFinite(time)) return null;
    const seconds = Math.max(0, Math.round((now - time) / 1000));
    if (seconds < 60) return 'Just now';
    const minutes = Math.round(seconds / 60);
    if (minutes < 60) return `${minutes} min ago`;
    const hours = Math.round(minutes / 60);
    if (hours < 24) return `${hours} h ago`;
    const days = Math.round(hours / 24);
    return days === 1 ? '1 day ago' : `${days} days ago`;
}

function truncate(text: string, max: number): string {
    return text.length > max ? `${text.slice(0, max - 1).trimEnd()}…` : text;
}

/**
 * - `active`: the keys work and the feed runs.
 * - `pending`: new keys wait for the Aranx confirm.
 * - `unstable`: the last feed run failed, or no run for an hour.
 * - `lost`: Aranx refused the API key.
 */
export type Health = 'active' | 'pending' | 'unstable' | 'lost';

export function healthOf(state: PluginState, now: number): Health {
    const { feed, connect } = state;
    if (feed.error && isAuthError(feed.error.status)) return 'lost';
    if (connect?.status === 'pending') return 'pending';
    if (feed.error) return 'unstable';
    // Before the first run, the connection time is the reference.
    const since =
        feed.lastRunAt ?? (connect?.status === 'connected' ? connect.at : null);
    const time = since ? Date.parse(since) : NaN;
    if (Number.isFinite(time) && now - time > SYNC_OVERDUE_MS)
        return 'unstable';
    return 'active';
}

const HEALTH_LABELS: Record<Health, string> = {
    active: 'Active',
    pending: 'Confirming',
    unstable: 'Unstable',
    lost: 'Connection lost'
};

/**
 * Handles a page load or a button click. Reads all settings and all KV in
 * one call each, so an action and the full page fit in the budget.
 */
export async function handleAdmin(
    ctx: PluginContext,
    input: unknown,
    now = Date.now()
): Promise<unknown> {
    const interaction = parseInteraction(input);
    const action =
        interaction.type === 'block_action' ? interaction.actionId : null;

    const [settings, state] = await Promise.all([
        readSettings(ctx),
        readPluginState(ctx)
    ]); // 2
    let config = configFrom(settings, state.plainCredentials);
    let toast: Toast | undefined;

    // The EmDash admin page ignores `navigate` in an action answer, so the
    // answer shows a link to the Aranx approval page. Only this action
    // makes the URL: a page load must not replace the verifier of an
    // approval that waits in another tab.
    const approveUrl = action === 'connect' ? await startConnect(ctx) : null; // 3
    // The state on screen. A new start replaces any earlier one.
    const connect: ConnectState | null = approveUrl ? null : state.connect;

    if (action === 'disconnect') {
        if (config.apiKey || config.webhookSecret) {
            await disconnect(ctx, settings, Boolean(state.plainCredentials)); // 3 to 7
            config = { ...config, apiKey: null, webhookSecret: null, storage: null };
            state.connect = {
                status: 'disconnected',
                at: new Date(now).toISOString(),
                state: null,
                verifier: null,
                confirmationId: null,
                storage: null,
                error: null
            };
            toast = { type: 'success', message: 'Disconnected from Aranx' };
        }
        // The welcome page needs no other call.
        return { blocks: welcomePage(ctx, config, state, null), ...(toast ? { toast } : {}) };
    }

    const configured = Boolean(config.apiKey && config.webhookSecret);
    if (action === 'sync') {
        if (configured) {
            await scheduleTask(ctx, { kind: 'feed' }); // 3
            toast = { type: 'success', message: 'Sync queued' };
        } else {
            toast = { type: 'error', message: 'Connect to Aranx first' };
        }
    }
    if (approveUrl)
        toast = { type: 'info', message: 'Approve the connection in Aranx' };

    // A confirm call that failed gets another try on each visit.
    if (connect?.status === 'pending')
        await scheduleTask(ctx, { kind: 'confirm' }); // 4
    // The settings hold the keys again, so the plain-text copy can go.
    if (config.storage === 'settings' && connect?.storage === 'kv')
        await dropPlainCredentials(ctx); // 5

    if (!configured) {
        return {
            blocks: welcomePage(ctx, config, { ...state, connect }, approveUrl),
            ...(toast ? { toast } : {})
        };
    }

    const store = articles(ctx);
    const [count, recent, schema] = await Promise.all([
        store.count(),
        store.recent(
            ACTIVITY_PAGE_SIZE,
            action === 'activity_page' ? cursorOf(interaction.value) : undefined
        ),
        ctx.schema
            ? ctx.schema.getCollection(config.collection).catch(() => null)
            : Promise.resolve(null)
    ]); // 6 to 8

    const blocks = [
        ...(approveUrl ? approvalBlocks(approveUrl) : []),
        ...connectionBlocks(ctx, config, { ...state, connect }, count, now),
        { type: 'divider' },
        ...activityBlocks(recent.items, recent.cursor),
        { type: 'divider' },
        ...mappingBlocks(config, schema),
        technicalDetails(ctx, config, state)
    ];
    return { blocks, ...(toast ? { toast } : {}) };
}

function approvalBlocks(approveUrl: string): Block[] {
    return [
        {
            type: 'banner',
            title: 'Approve the connection in Aranx',
            description:
                'Open Aranx, choose the website, and approve. Aranx then sends you back to this page.',
            variant: 'alert'
        },
        {
            type: 'actions',
            elements: [
                {
                    type: 'link',
                    label: 'Approve in Aranx',
                    target: { kind: 'external', url: approveUrl },
                    appearance: 'primary'
                }
            ]
        }
    ];
}

function failedBanner(connect: ConnectState | null): Block[] {
    return connect?.status === 'failed' && connect.error
        ? [
              {
                  type: 'banner',
                  title: 'The connection to Aranx failed',
                  description: connect.error,
                  variant: 'error'
              }
          ]
        : [];
}

/** Before the first connection, and after "Disconnect". */
function welcomePage(
    ctx: PluginContext,
    config: PluginConfig,
    state: PluginState,
    approveUrl: string | null
): Block[] {
    const blocks: Block[] = [];
    if (approveUrl) blocks.push(...approvalBlocks(approveUrl));
    blocks.push(...failedBanner(state.connect));
    if (state.connect?.status === 'disconnected' && !approveUrl) {
        blocks.push(
            {
                type: 'banner',
                title: 'Disconnected from Aranx',
                description:
                    'This site no longer receives Aranx articles, and the entries stay. Aranx keeps the connection until you remove it on its Publishing page.',
                variant: 'alert'
            },
            {
                type: 'actions',
                elements: [
                    {
                        type: 'link',
                        label: 'Open the Publishing page in Aranx',
                        target: {
                            kind: 'external',
                            url: publishingUrl(state.websiteId)
                        }
                    }
                ]
            }
        );
    }
    blocks.push(
        {
            type: 'empty',
            title: 'Welcome to Aranx',
            description: `Connect this site to Aranx. Aranx writes SEO articles, and this plugin saves each one as an entry in "${config.collection}", with its featured image and categories. Add this site as a website in Aranx first.`,
            size: 'lg',
            actions: approveUrl
                ? []
                : [
                      {
                          type: 'button',
                          label: 'Connect to Aranx',
                          action_id: 'connect',
                          style: 'primary'
                      }
                  ]
        },
        {
            type: 'stats',
            items: [
                {
                    label: 'Content sync',
                    value: 'Articles',
                    description: `Each Aranx article becomes an entry in "${config.collection}".`
                },
                {
                    label: 'Central management',
                    value: 'One dashboard',
                    description:
                        'Plan, write, and publish all your content from Aranx.'
                }
            ]
        },
        {
            type: 'stats',
            items: [
                {
                    label: 'Near-real-time updates',
                    value: 'Minutes',
                    description:
                        'A signed webhook brings each change. A sync every 15 minutes catches any it missed.'
                },
                {
                    label: 'Secure connection',
                    value: 'Encrypted keys',
                    description:
                        'One key pair per website, kept in the encrypted plugin settings. Every webhook is signed.'
                }
            ]
        },
        {
            type: 'accordion',
            label: 'What happens when you connect?',
            blocks: [
                {
                    type: 'columns',
                    columns: [
                        [
                            { type: 'section', text: 'Automatic setup' },
                            {
                                type: 'context',
                                text: 'You approve the connection in Aranx. You copy no key.'
                            },
                            {
                                type: 'context',
                                text: "Aranx sets this site's webhook URL."
                            },
                            {
                                type: 'context',
                                text: 'The plugin stores the keys and replaces them when you click "Rotate keys".'
                            }
                        ],
                        [
                            { type: 'section', text: 'Content integration' },
                            {
                                type: 'context',
                                text: 'New articles stay drafts until Aranx asks to publish them.'
                            },
                            {
                                type: 'context',
                                text: 'When an editor publishes, unpublishes, or deletes an entry, Aranx gets the new status.'
                            },
                            {
                                type: 'context',
                                text: 'Entries that exist already stay as they are.'
                            }
                        ]
                    ]
                }
            ]
        },
        {
            type: 'actions',
            elements: [
                {
                    type: 'link',
                    label: 'Manual setup in Settings',
                    target: { kind: 'plugin-settings' }
                }
            ]
        }
    );
    return blocks;
}

function connectionBlocks(
    ctx: PluginContext,
    config: PluginConfig,
    state: PluginState,
    count: number,
    now: number
): Block[] {
    const { connect, feed, lastWebhook } = state;
    const health = healthOf(state, now);
    const blocks: Block[] = [...failedBanner(connect)];

    if (health === 'lost') {
        blocks.push({
            type: 'banner',
            title: 'Connection lost',
            description: `Aranx refused this site's API key ${timeAgo(feed.error?.at ?? null, now)?.toLowerCase() ?? 'recently'}. Reconnect to resume syncing. The entries on this site stay.`,
            variant: 'error'
        });
    } else if (health === 'unstable') {
        blocks.push({
            type: 'banner',
            title: 'The sync is late',
            description: feed.error
                ? `The last sync failed: ${feed.error.message}. The plugin tries again every 15 minutes.`
                : "The plugin syncs every 15 minutes, and the last sync was more than an hour ago. Check that the site's cron trigger runs every minute.",
            variant: 'alert'
        });
    } else if (health === 'pending') {
        blocks.push({
            type: 'banner',
            title: 'Waiting for Aranx to confirm the new keys',
            description:
                'The plugin stored the new keys. It asks Aranx again on each visit to this page and from a background task.',
            variant: 'default'
        });
    }
    if (config.storage === 'kv') {
        blocks.push({
            type: 'banner',
            title: 'The Aranx keys are stored without encryption',
            description:
                'This site has no EMDASH_ENCRYPTION_KEY secret, so EmDash cannot encrypt plugin settings. The API key and the webhook secret are in the plugin storage as plain text. Add the secret to the Worker, then click "Reconnect" to store new, encrypted keys.',
            variant: 'alert'
        });
    }

    blocks.push({
        type: 'section',
        text:
            health === 'lost'
                ? 'Aranx no longer accepts this connection.'
                : 'Connected to Aranx. Manage your articles and publishing from the Aranx dashboard.',
        accessory: {
            type: 'link',
            label: 'Open Aranx',
            target: { kind: 'external', url: consoleUrl(state.websiteId) },
            appearance: 'secondary'
        }
    });

    const lastSync = timeAgo(feed.lastRunAt, now);
    const lastEvent = timeAgo(lastWebhook?.at ?? null, now);
    blocks.push({
        type: 'stats',
        items: [
            {
                label: 'Status',
                value: HEALTH_LABELS[health]
            },
            {
                label: 'Articles',
                value: count,
                description: 'Linked to Aranx articles'
            },
            {
                label: 'Last sync',
                value: lastSync ?? 'Not yet',
                description: 'Runs every 15 minutes'
            },
            {
                label: 'Last event from Aranx',
                value: lastEvent ?? 'None yet',
                description: lastWebhook?.event ?? 'Webhook'
            }
        ]
    });

    const confirmedAt =
        connect?.status === 'connected' ? timeAgo(connect.at, now) : null;
    blocks.push({
        type: 'fields',
        fields: [
            ...(confirmedAt ? [{ label: 'Keys confirmed', value: confirmedAt }] : []),
            {
                label: 'Key storage',
                value:
                    config.storage === 'kv'
                        ? 'Plugin storage, not encrypted'
                        : 'Encrypted settings'
            },
            ...(state.websiteId
                ? [{ label: 'Aranx website', value: state.websiteId }]
                : [])
        ]
    });

    // Encrypting plain-text keys also needs new keys.
    const reconnect = health !== 'active' || config.storage === 'kv';
    blocks.push({
        type: 'actions',
        elements: [
            {
                type: 'button',
                label: reconnect ? 'Reconnect' : 'Rotate keys',
                action_id: 'connect',
                ...(reconnect ? { style: 'primary' } : {})
            },
            { type: 'button', label: 'Sync now', action_id: 'sync' },
            {
                type: 'button',
                label: 'Disconnect',
                action_id: 'disconnect',
                style: 'danger',
                confirm: {
                    title: 'Disconnect from Aranx?',
                    text: 'The plugin deletes its keys and stops importing articles. The entries stay on this site. Aranx keeps the connection until you remove it on its Publishing page.',
                    confirm: 'Disconnect',
                    deny: 'Cancel',
                    style: 'danger'
                }
            },
            {
                type: 'link',
                label: 'Settings',
                target: { kind: 'plugin-settings' }
            }
        ]
    });

    if (health === 'lost') {
        blocks.push({
            type: 'accordion',
            label: 'Why did this happen?',
            blocks: [
                {
                    type: 'context',
                    text: 'The connection was removed in Aranx, or replaced by a new connection for the same website.'
                },
                {
                    type: 'context',
                    text: 'The key was rotated in Aranx, and this site never received the new one.'
                },
                {
                    type: 'context',
                    text: 'Your entries, categories, and settings are safe. "Reconnect" gets new keys.'
                }
            ]
        });
    }
    return blocks;
}

function activityLabel(record: ArticleRecord): string {
    const activity = record.activity!;
    switch (activity.kind) {
        case 'imported':
            return 'Imported as a new entry';
        case 'updated':
            return 'Updated from Aranx';
        case 'reported':
            return `Sent status: ${activity.status ?? 'unknown'}`;
        case 'refused':
            return `Publish refused: ${truncate(activity.error ?? 'no reason given', MAX_REASON_LENGTH)}`;
    }
}

function activityBlocks(
    items: Array<{ articleId: string; record: ArticleRecord }>,
    cursor: string | null
): Block[] {
    return [
        { type: 'header', text: 'Recent sync activity' },
        {
            type: 'context',
            text: 'The last change of each article between EmDash and Aranx. IN: Aranx changed the entry. OUT: the plugin sent the entry status to Aranx.'
        },
        {
            type: 'table',
            block_id: 'activity',
            page_action_id: 'activity_page',
            columns: [
                { key: 'direction', label: 'Direction', format: 'badge' },
                { key: 'event', label: 'Event' },
                { key: 'article', label: 'Article', format: 'element' },
                { key: 'at', label: 'When', format: 'relative_time' },
                { key: 'result', label: 'Result', format: 'badge' }
            ],
            rows: items.map(({ record }) => ({
                direction: record.activity!.direction === 'in' ? 'IN' : 'OUT',
                event: activityLabel(record),
                article: {
                    type: 'link',
                    label: truncate(record.title || 'Untitled', MAX_TITLE_LENGTH),
                    target: {
                        kind: 'content',
                        collection: record.collection,
                        id: record.entryId
                    },
                    appearance: 'inline'
                },
                at: record.activityAt,
                result: record.activity!.kind === 'refused' ? 'Error' : 'OK'
            })),
            ...(cursor ? { next_cursor: cursor } : {}),
            empty_text:
                'No sync activity yet. Publish an article in Aranx to see it here.'
        }
    ];
}

type CollectionSchema = Parameters<typeof mapFields>[0];

/** What WordPress shows as "SEO metadata": where each Aranx field goes. */
function mappingBlocks(
    config: PluginConfig,
    schema: CollectionSchema | null
): Block[] {
    const blocks: Block[] = [
        { type: 'header', text: 'Content and SEO' },
        {
            type: 'context',
            text: `Where each Aranx field goes in the "${config.collection}" collection.`
        }
    ];
    if (!schema) {
        blocks.push({
            type: 'banner',
            title: `The collection "${config.collection}" does not exist`,
            description:
                'Aranx cannot save articles. Pick an existing collection in Settings.',
            variant: 'error'
        });
        return blocks;
    }
    let fields: ReturnType<typeof mapFields>;
    try {
        fields = mapFields(schema);
    } catch (error) {
        blocks.push({
            type: 'banner',
            title: `The collection "${config.collection}" cannot hold Aranx articles`,
            description: error instanceof Error ? error.message : String(error),
            variant: 'error'
        });
        return blocks;
    }
    blocks.push({
        type: 'fields',
        fields: [
            { label: 'Title', value: fields.title },
            { label: 'Body', value: fields.body },
            {
                label: 'Meta description',
                value: fields.excerpt ?? 'Not saved: no excerpt field'
            },
            {
                label: 'Featured image',
                value: fields.image ?? 'Not saved: no image field'
            },
            {
                label: 'SEO title and description',
                value: fields.seo ? 'EmDash SEO panel' : 'Not saved: SEO is off'
            },
            { label: 'Categories', value: `Taxonomy "${config.taxonomy}"` }
        ]
    });
    blocks.push(
        fields.seo
            ? {
                  type: 'banner',
                  description:
                      "Aranx fills the EmDash SEO panel of each new entry. EmDash keeps those first values: later changes to the meta title in Aranx do not reach the entry.",
                  variant: 'default'
              }
            : {
                  type: 'banner',
                  title: 'SEO is off for this collection',
                  description: `Turn on SEO for "${config.collection}" in the EmDash content types, so new entries get the Aranx meta title and description.`,
                  variant: 'alert'
              }
    );
    return blocks;
}

function technicalDetails(
    ctx: PluginContext,
    config: PluginConfig,
    state: PluginState
): Block {
    return {
        type: 'accordion',
        label: 'Technical details',
        blocks: [
            {
                type: 'fields',
                fields: [
                    { label: 'Plugin version', value: PLUGIN_VERSION },
                    { label: 'Plugin ID', value: ctx.plugin.id },
                    { label: 'API URL', value: config.apiBaseUrl },
                    { label: 'Collection', value: config.collection },
                    { label: 'Category taxonomy', value: config.taxonomy },
                    {
                        label: 'Aranx website ID',
                        value: state.websiteId ?? 'Not set'
                    },
                    {
                        label: 'Connection state',
                        value: state.connect?.status ?? 'Manual setup'
                    }
                ]
            },
            {
                type: 'context',
                text: 'Webhook URL. Aranx sets it when you connect. A manual setup needs it in Aranx.'
            },
            {
                type: 'code',
                code: ctx.url(webhookPath(ctx.plugin.id)),
                language: 'bash'
            }
        ]
    };
}
