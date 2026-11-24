import type { PluginContext } from 'emdash/plugin';
import { readConfig } from './config';
import { dropPlainCredentials, startConnect } from './connect';
import { articles, readConnectState, readFeedState } from './store';
import { scheduleTask } from './tasks';

/**
 * The route path uses the plugin ID. A registry install gets a hashed ID
 * (`r_...`), so read it from the context instead of using the slug.
 */
export function webhookPath(pluginId: string): string {
    return `/_emdash/api/plugins/${encodeURIComponent(pluginId)}/webhook`;
}

interface Interaction {
    type: string;
    actionId: string | null;
}

function parseInteraction(input: unknown): Interaction {
    if (typeof input !== 'object' || input === null)
        return { type: 'page_load', actionId: null };
    const type =
        'type' in input && typeof input.type === 'string'
            ? input.type
            : 'page_load';
    const actionId =
        'action_id' in input && typeof input.action_id === 'string'
            ? input.action_id
            : null;
    return { type, actionId };
}

type Toast = { type: 'success' | 'error' | 'info'; message: string };

/**
 * The Aranx admin page: the connection to Aranx, the sync state, and a sync
 * button. Worst case: 7 calls.
 */
export async function handleAdmin(
    ctx: PluginContext,
    input: unknown
): Promise<unknown> {
    const interaction = parseInteraction(input);
    const action =
        interaction.type === 'block_action' ? interaction.actionId : null;

    // The EmDash admin page ignores `navigate` in an action answer, so the
    // answer shows a link to the Aranx approval page. Only this action
    // makes the URL: a page load must not replace the verifier of an
    // approval that waits in another tab.
    const approveUrl = action === 'connect' ? await startConnect(ctx) : null;

    const [config, connect, count, feed] = await Promise.all([
        readConfig(ctx),
        approveUrl ? null : readConnectState(ctx),
        articles(ctx).count(),
        readFeedState(ctx)
    ]);
    const configured = Boolean(config.apiKey && config.webhookSecret);

    let toast: Toast | undefined;
    if (action === 'sync') {
        if (configured) {
            await scheduleTask(ctx, { kind: 'feed' });
            toast = { type: 'success', message: 'Sync queued' };
        } else {
            toast = { type: 'error', message: 'Connect to Aranx first' };
        }
    }

    // A confirm call that failed gets another try on each visit.
    if (connect?.status === 'pending')
        await scheduleTask(ctx, { kind: 'confirm' });
    // The settings hold the keys again, so the plain-text copy can go.
    if (config.storage === 'settings' && connect?.storage === 'kv')
        await dropPlainCredentials(ctx);

    const blocks: unknown[] = [];
    if (approveUrl) {
        toast = { type: 'info', message: 'Approve the connection in Aranx' };
        blocks.push(
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
        );
    }
    if (connect?.status === 'failed' && connect.error) {
        blocks.push({
            type: 'banner',
            title: 'The connection to Aranx failed',
            description: connect.error,
            variant: 'error'
        });
    }
    if (!configured && !approveUrl) {
        blocks.push({
            type: 'banner',
            title: 'Connect this site to Aranx',
            description:
                'Add this site as a website in Aranx first. Then click "Connect to Aranx" and approve the connection.',
            variant: 'alert'
        });
    } else if (config.storage === 'kv') {
        blocks.push({
            type: 'banner',
            title: 'The Aranx keys are stored without encryption',
            description:
                'This site has no EMDASH_ENCRYPTION_KEY secret, so EmDash cannot encrypt plugin settings. The API key and the webhook secret are in the plugin storage as plain text. Add the secret to the Worker, then click "Reconnect" to store new, encrypted keys.',
            variant: 'alert'
        });
    }

    const status = !configured
        ? 'Not connected'
        : connect?.status === 'pending'
          ? 'Connected. Waiting for Aranx to confirm the new keys'
          : 'Connected';
    blocks.push(
        {
            type: 'fields',
            fields: [
                { label: 'Aranx', value: status },
                { label: 'Webhook URL', value: ctx.url(webhookPath(ctx.plugin.id)) },
                { label: 'Articles', value: String(count) },
                { label: 'Last sync', value: feed.lastRunAt ?? 'Never' }
            ]
        },
        {
            type: 'actions',
            elements: [
                {
                    type: 'button',
                    label: configured ? 'Reconnect' : 'Connect to Aranx',
                    action_id: 'connect',
                    ...(configured ? {} : { style: 'primary' })
                },
                { type: 'button', label: 'Sync now', action_id: 'sync' },
                {
                    type: 'link',
                    label: 'Settings',
                    target: { kind: 'plugin-settings' }
                }
            ]
        }
    );
    return { blocks, ...(toast ? { toast } : {}) };
}
