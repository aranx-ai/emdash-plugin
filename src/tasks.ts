import type { CronEvent, PluginContext } from 'emdash/plugin';
import type { AranxCategory } from './aranx-api';

/**
 * The sandbox allows about 10 subrequests per call, and every `ctx.*` call
 * and `ctx.http.fetch` counts. One article import needs more, so it runs as
 * a chain of one-shot cron tasks:
 *
 *   article  fetch the article, upload the featured image, save the entry
 *   terms    assign categories (only when they changed)
 *   publish  publish when Aranx asks or the entry is live, then report
 *
 * `report` sends the entry state to Aranx after an editor changes it.
 * `feed` reads the change feed every 15 minutes. `feed_next` continues a
 * backfill on the next tick. EmDash retries a failed one-shot task 5 times
 * with backoff.
 *
 * An event that arrives while the task of the same name runs is lost when
 * that task finishes. The feed task finds the change within 15 minutes.
 */

export type RequestedStatus = 'published' | 'draft';

export const FEED_TASK = 'feed';
export const FEED_NEXT_TASK = 'feed_next';
export const FEED_SCHEDULE = '*/15 * * * *';

export type Task =
    | {
          kind: 'article';
          articleId: string;
          requestedStatus: RequestedStatus | null;
      }
    | {
          kind: 'terms';
          articleId: string;
          entryId: string;
          collection: string;
          categories: AranxCategory[];
          requestedStatus: RequestedStatus | null;
      }
    | {
          kind: 'publish';
          articleId: string;
          entryId: string;
          collection: string;
          requestedStatus: RequestedStatus | null;
      }
    | { kind: 'report'; articleId: string; gone: boolean }
    | { kind: 'feed' };

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function requested(value: unknown): RequestedStatus | null {
    return value === 'published' || value === 'draft' ? value : null;
}

function categories(value: unknown): AranxCategory[] {
    if (!Array.isArray(value)) return [];
    return value.flatMap((item) =>
        isRecord(item) &&
        typeof item.id === 'string' &&
        typeof item.name === 'string'
            ? [
                  {
                      id: item.id,
                      name: item.name,
                      slug: typeof item.slug === 'string' ? item.slug : ''
                  }
              ]
            : []
    );
}

/**
 * Task names allow letters, digits, `-`, and `_`, up to 128 characters. The
 * article ID in a name only keeps one pending task per article and step. The
 * task data carries the real ID.
 */
function namePart(articleId: string): string {
    return articleId.replace(/[^A-Za-z0-9-]/g, '-').slice(0, 96);
}

/** Task names keep one pending task per article, step, and requested status. */
function taskName(task: Task): string {
    switch (task.kind) {
        case 'article':
            return task.requestedStatus
                ? `article_${namePart(task.articleId)}_${task.requestedStatus}`
                : `article_${namePart(task.articleId)}`;
        case 'terms':
        case 'publish':
        case 'report':
            return `${task.kind}_${namePart(task.articleId)}`;
        case 'feed':
            // A one-shot task is deleted after it runs, together with any
            // update to the same name made during the run. The feed task
            // schedules its successor while it runs, so each name is new.
            return `${FEED_NEXT_TASK}_${Date.now().toString(36)}`;
    }
}

/** Runs the task on the next cron tick. */
export function scheduleTask(ctx: PluginContext, task: Task): Promise<void> {
    if (!ctx.cron) throw new Error('Cron scheduling is unavailable');
    const { kind: _kind, ...data } = task;
    return ctx.cron.schedule(taskName(task), {
        schedule: new Date().toISOString(),
        data: { kind: task.kind, ...data }
    });
}

export function parseTask(event: CronEvent): Task | null {
    if (
        event.name === FEED_TASK ||
        event.name.startsWith(`${FEED_NEXT_TASK}_`)
    ) {
        return { kind: 'feed' };
    }
    const data = event.data ?? {};
    const articleId =
        typeof data.articleId === 'string' ? data.articleId : null;
    if (!articleId) return null;
    const entryId = typeof data.entryId === 'string' ? data.entryId : null;
    const collection =
        typeof data.collection === 'string' ? data.collection : null;
    const requestedStatus = requested(data.requestedStatus);

    switch (data.kind) {
        case 'article':
            return { kind: 'article', articleId, requestedStatus };
        case 'terms':
            return entryId && collection
                ? {
                      kind: 'terms',
                      articleId,
                      entryId,
                      collection,
                      categories: categories(data.categories),
                      requestedStatus
                  }
                : null;
        case 'publish':
            return entryId && collection
                ? {
                      kind: 'publish',
                      articleId,
                      entryId,
                      collection,
                      requestedStatus
                  }
                : null;
        case 'report':
            return { kind: 'report', articleId, gone: data.gone === true };
        default:
            return null;
    }
}
