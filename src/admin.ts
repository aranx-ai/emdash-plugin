import type { PluginContext } from 'emdash/plugin';
import { readConfig } from './config';
import { articles, readFeedState } from './store';
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

/** The Aranx admin page: the webhook URL to paste into Aranx, sync state, and a sync button. */
export async function handleAdmin(
    ctx: PluginContext,
    input: unknown
): Promise<unknown> {
    const interaction = parseInteraction(input);
    const config = await readConfig(ctx);
    const configured = Boolean(config.apiKey && config.webhookSecret);

    let toast: { type: 'success' | 'error'; message: string } | undefined;
    if (
        interaction.type === 'block_action' &&
        interaction.actionId === 'sync'
    ) {
        if (configured) {
            await scheduleTask(ctx, { kind: 'feed' });
            toast = { type: 'success', message: 'Sync queued' };
        } else {
            toast = {
                type: 'error',
                message: 'Add the API key and webhook secret first'
            };
        }
    }

    const [count, feed] = await Promise.all([
        articles(ctx).count(),
        readFeedState(ctx)
    ]);
    const blocks: unknown[] = [];
    if (!configured) {
        blocks.push({
            type: 'banner',
            title: 'Add the API key and webhook secret from your Aranx API connection',
            variant: 'alert'
        });
    }
    blocks.push(
        {
            type: 'fields',
            fields: [
                { label: 'Webhook URL', value: ctx.url(webhookPath(ctx.plugin.id)) },
                { label: 'Articles', value: String(count) },
                { label: 'Last sync', value: feed.lastRunAt ?? 'Never' }
            ]
        },
        {
            type: 'actions',
            elements: [
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
