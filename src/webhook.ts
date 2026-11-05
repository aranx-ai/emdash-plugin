import {
    pluginResponse,
    type PluginContext,
    type PluginResponse
} from 'emdash/plugin';
import { readConfig } from './config';
import { verifySignature } from './signature';
import { readWebsiteId, writeWebsiteId } from './store';
import { scheduleTask } from './tasks';

/**
 * Receives Aranx webhooks at `/_emdash/api/plugins/<plugin id>/webhook`.
 * Docs: https://docs.aranx.com/api-reference/webhooks
 *
 * The handler verifies the event and queues an import task. The import runs
 * on the next cron tick, so the answer is fast and stays within the sandbox
 * limits. Worst case: 4 calls.
 */

export const MAX_WEBHOOK_BODY_BYTES = 64 * 1024;
/** Aranx signs each delivery and retry at send time. */
const MAX_TIMESTAMP_AGE_MS = 15 * 60 * 1000;
/** The contract allows 5 minutes for the signed feature check. */
const MAX_PROBE_AGE_MS = 5 * 60 * 1000;
const FEATURES = ['requested_status'];

const ARTICLE_EVENTS = new Set([
    'article.published',
    'article.updated',
    'article.deleted'
]);

function json(status: number, body: unknown): PluginResponse {
    return pluginResponse({
        status,
        headers: { 'content-type': 'application/json' },
        body: { kind: 'text', value: JSON.stringify(body) }
    });
}

function isFresh(
    timestamp: string | undefined,
    now: number,
    maxAge = MAX_TIMESTAMP_AGE_MS
): boolean {
    const time = timestamp ? Date.parse(timestamp) : Number.NaN;
    return Number.isFinite(time) && Math.abs(now - time) <= maxAge;
}

function isRecord(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export interface WebhookRequest {
    method: string;
    headers: Record<string, string>;
    body: Uint8Array;
}

interface Payload {
    event: string;
    articleId: string | null;
    websiteId: string;
    timestamp: string;
    requestedStatus: 'published' | 'draft' | null;
}

function parsePayload(body: Uint8Array): Payload | null {
    let value: unknown;
    try {
        value = JSON.parse(new TextDecoder().decode(body));
    } catch {
        return null;
    }
    if (!isRecord(value)) return null;
    const data = value;
    if (
        typeof data.event !== 'string' ||
        !data.event ||
        typeof data.website_id !== 'string' ||
        !data.website_id ||
        typeof data.timestamp !== 'string'
    ) {
        return null;
    }
    return {
        event: data.event,
        articleId:
            typeof data.article_id === 'string' && data.article_id
                ? data.article_id
                : null,
        websiteId: data.website_id,
        timestamp: data.timestamp,
        requestedStatus:
            data.requested_status === 'published' ||
            data.requested_status === 'draft'
                ? data.requested_status
                : null
    };
}

export async function handleWebhook(
    ctx: PluginContext,
    request: WebhookRequest,
    now = Date.now()
): Promise<PluginResponse> {
    const { webhookSecret } = await readConfig(ctx); // 1
    // 503 makes Aranx retry after the secret is saved.
    if (!webhookSecret) return json(503, { error: 'not_configured' });

    const signature = request.headers['x-webhook-signature'];

    // Aranx sends a signed HEAD to check the features of the receiver. The
    // sandbox cannot set the `X-Aranx-Webhook-Features` header, so a signed
    // GET returns the features in the body.
    if (request.method === 'HEAD' || request.method === 'GET') {
        const timestamp = request.headers['x-webhook-timestamp'];
        if (
            !isFresh(timestamp, now, MAX_PROBE_AGE_MS) ||
            !(await verifySignature(webhookSecret, timestamp ?? '', signature))
        ) {
            return json(401, { error: 'invalid_signature' });
        }
        return request.method === 'HEAD'
            ? pluginResponse({ status: 204 })
            : json(200, { features: FEATURES });
    }

    if (request.body.byteLength > MAX_WEBHOOK_BODY_BYTES) {
        return json(413, { error: 'payload_too_large' });
    }
    if (!(await verifySignature(webhookSecret, request.body, signature))) {
        return json(401, { error: 'invalid_signature' });
    }
    const payload = parsePayload(request.body);
    if (!payload) return json(400, { error: 'invalid_payload' });
    // The signature covers the timestamp, so an old one is a replay.
    if (!isFresh(payload.timestamp, now))
        return json(401, { error: 'stale_timestamp' });

    // One API key and secret belong to one Aranx website. Pin the first one.
    const websiteId = await readWebsiteId(ctx); // 2
    if (!websiteId)
        await writeWebsiteId(ctx, payload.websiteId); // 3
    else if (websiteId !== payload.websiteId)
        return json(400, { error: 'unknown_website' });

    if (ARTICLE_EVENTS.has(payload.event)) {
        if (!payload.articleId) return json(400, { error: 'invalid_payload' });
        await scheduleTask(ctx, {
            kind: 'article',
            articleId: payload.articleId,
            requestedStatus:
                payload.event === 'article.published'
                    ? payload.requestedStatus
                    : null
        }); // 4
        return json(202, { received: true, queued: true });
    }

    // `test`, category events, and future events need no action. Entries keep
    // the terms they have, and the sandbox cannot rename or delete terms.
    return json(200, { received: true });
}
