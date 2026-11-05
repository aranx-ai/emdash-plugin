import {
    pluginRoute,
    type PluginContext,
    type SandboxedPlugin
} from 'emdash/plugin';
import { handleAdmin } from './admin';
import { articles } from './store';
import {
    runArticleTask,
    runFeedTask,
    runPublishTask,
    runReportTask,
    runTermsTask
} from './sync';
import { FEED_SCHEDULE, FEED_TASK, parseTask, scheduleTask } from './tasks';
import { MAX_WEBHOOK_BODY_BYTES, handleWebhook } from './webhook';

/**
 * Aranx for EmDash. Aranx writes SEO articles. This plugin receives the
 * signed Aranx webhook, imports each article into a collection, and reports
 * the live URL back to Aranx.
 */

function entryId(content: Record<string, unknown>): string | null {
    return typeof content.id === 'string' ? content.id : null;
}

/** Queues a report when an editor changes an entry that came from Aranx. 2 calls. */
async function queueReport(
    ctx: PluginContext,
    id: string | null
): Promise<void> {
    if (!id) return;
    const found = await articles(ctx).findByEntry(id);
    if (found)
        await scheduleTask(ctx, {
            kind: 'report',
            articleId: found.articleId,
            gone: false
        });
}

const plugin: SandboxedPlugin = {
    hooks: {
        'plugin:activate': async (_event, ctx) => {
            await ctx.cron?.schedule(FEED_TASK, { schedule: FEED_SCHEDULE });
        },
        cron: async (event, ctx) => {
            const task = parseTask(event);
            if (!task) return;
            switch (task.kind) {
                case 'article':
                    return runArticleTask(
                        ctx,
                        task.articleId,
                        task.requestedStatus
                    );
                case 'terms':
                    return runTermsTask(ctx, task);
                case 'publish':
                    return runPublishTask(ctx, task);
                case 'report':
                    return runReportTask(ctx, task);
                case 'feed':
                    await runFeedTask(ctx);
                    return;
            }
        },
        'content:afterPublish': (event, ctx) =>
            queueReport(ctx, entryId(event.content)),
        'content:afterUnpublish': (event, ctx) =>
            queueReport(ctx, entryId(event.content)),
        'content:afterSchedule': (event, ctx) =>
            queueReport(ctx, entryId(event.content)),
        'content:afterUnschedule': (event, ctx) =>
            queueReport(ctx, entryId(event.content)),
        'content:afterRestore': (event, ctx) =>
            queueReport(ctx, entryId(event.content)),
        'content:afterDelete': async (event, ctx) => {
            const store = articles(ctx);
            const found = await store.findByEntry(event.id);
            if (!found) return;
            if (event.permanent) await store.delete(found.articleId);
            await scheduleTask(ctx, {
                kind: 'report',
                articleId: found.articleId,
                gone: event.permanent
            });
        }
    },
    routes: {
        webhook: pluginRoute({
            public: true,
            methods: ['HEAD', 'GET', 'POST'],
            request: {
                body: 'bytes',
                maxBytes: MAX_WEBHOOK_BODY_BYTES,
                headers: ['x-webhook-signature', 'x-webhook-timestamp']
            },
            response: 'raw',
            handler: (routeCtx, ctx) =>
                handleWebhook(ctx, {
                    method: routeCtx.request.method.toUpperCase(),
                    headers: routeCtx.request.headers,
                    body: routeCtx.input
                })
        }),
        admin: {
            permission: 'plugins:manage',
            handler: (routeCtx, ctx) => handleAdmin(ctx, routeCtx.input)
        }
    }
};

export default plugin;
