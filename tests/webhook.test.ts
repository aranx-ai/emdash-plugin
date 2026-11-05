import { afterEach, describe, expect, it } from 'vitest';
import {
    createPluginRuntimeTestHost,
    type PluginRuntimeTestHost
} from '@emdash-cms/plugin-test';
import { sign } from '../src/signature';

const SECRET = 'arx_whsec_test';
const WEBSITE_ID = 'website-1';

let host: PluginRuntimeTestHost | undefined;

afterEach(async () => {
    await host?.dispose();
    host = undefined;
});

async function setup(): Promise<PluginRuntimeTestHost> {
    host = await createPluginRuntimeTestHost();
    await host.fixtures.plugin.setting('webhookSecret', SECRET);
    return host;
}

describe('webhook probe freshness', () => {
    it('rejects a signed feature check whose timestamp is older than 5 minutes', async () => {
        const current = await setup();
        const timestamp = new Date(Date.now() - 10 * 60 * 1000).toISOString();
        const headers = {
            'x-webhook-timestamp': timestamp,
            'x-webhook-signature': await sign(SECRET, timestamp)
        };

        const head = await current.actions.routes.request('webhook', {
            method: 'HEAD',
            headers
        });
        const get = await current.actions.routes.request('webhook', {
            method: 'GET',
            headers
        });

        expect(head.status).toBe(401);
        expect(get.status).toBe(401);
    });
});

describe('webhook payload checks', () => {
    it('rejects an article event without article_id before it queues a task', async () => {
        const current = await setup();
        const timestamp = new Date().toISOString();
        const body = JSON.stringify({
            event: 'article.published',
            website_id: WEBSITE_ID,
            timestamp
        });
        const response = await current.actions.routes.request('webhook', {
            method: 'POST',
            rawBody: body,
            headers: {
                'content-type': 'application/json',
                'x-webhook-timestamp': timestamp,
                'x-webhook-signature': await sign(SECRET, body)
            }
        });

        expect(response.status).toBe(400);
        expect(await response.json()).toEqual({ error: 'invalid_payload' });
        expect(await current.inspect.scheduledTasks()).toHaveLength(0);
    });
});
