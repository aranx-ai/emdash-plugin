import { describe, expect, it } from 'vitest';
import { sign, verifySignature } from '../src/signature';

const SECRET = 'arx_whsec_test';
const BODY =
    '{"event":"test","website_id":"w1","timestamp":"2026-11-05T10:00:00.000Z"}';

describe('signatures', () => {
    it('matches the Aranx format', async () => {
        // printf '%s' "$BODY" | openssl dgst -sha256 -hmac "$SECRET"
        const expected =
            'sha256=3dfaf040ab1f2fe95c92f55ff8136fc8f1b03200178f164194abce223cd04b88';
        expect(await sign(SECRET, BODY)).toBe(expected);
        expect(await sign(SECRET, new TextEncoder().encode(BODY))).toBe(
            expected
        );
    });

    it('accepts a valid signature and rejects others', async () => {
        const bytes = new TextEncoder().encode(BODY);
        const signature = await sign(SECRET, bytes);
        expect(signature).toMatch(/^sha256=[0-9a-f]{64}$/);
        await expect(verifySignature(SECRET, bytes, signature)).resolves.toBe(
            true
        );
        await expect(
            verifySignature(SECRET, bytes, ` ${signature} `)
        ).resolves.toBe(true);
        await expect(verifySignature('other', bytes, signature)).resolves.toBe(
            false
        );
        await expect(
            verifySignature(
                SECRET,
                new TextEncoder().encode(`${BODY} `),
                signature
            )
        ).resolves.toBe(false);
        await expect(verifySignature(SECRET, bytes, undefined)).resolves.toBe(
            false
        );
        await expect(verifySignature(SECRET, bytes, '')).resolves.toBe(false);
        await expect(
            verifySignature(SECRET, bytes, signature.slice(0, -1))
        ).resolves.toBe(false);
    });
});
