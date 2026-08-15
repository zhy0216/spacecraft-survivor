import { env, SELF } from 'cloudflare:test';
import { afterEach, describe, expect, it } from 'vitest';
import {
  RUN_LOG_MAX_BODY_BYTES,
  RUN_LOG_MONTHLY_MAX_OBJECTS,
} from '../worker/index';

declare module 'cloudflare:test' {
  interface ProvidedEnv extends Env {}
}

function validPayload(): Record<string, unknown> {
  return {
    v: 1,
    game: 'starwreck',
    seed: 42,
    events: [{ k: 'gameOver', t: 550, result: 1 }],
    truncated: false,
    result: 1,
    survivedSec: 550,
    kills: 1234,
    eliteKills: 7,
    segment: 4,
    bossKilledAtSec: 550,
    peakDps: 88.5,
    weaponReport: [{ type: 0, damage: 900 }],
  };
}

async function clearStorage(): Promise<void> {
  let cursor: string | undefined;
  do {
    const page = await env.RUN_LOGS.list({ cursor });
    if (page.objects.length > 0) {
      await env.RUN_LOGS.delete(page.objects.map((object) => object.key));
    }
    cursor = page.truncated ? page.cursor : undefined;
  } while (cursor !== undefined);

  await env.RUN_LOG_QUOTA.prepare('DELETE FROM monthly_log_quota').run();
}

afterEach(clearStorage);

describe('POST /api/logs', () => {
  it('validates, reserves quota, and stores a run log in R2', async () => {
    const payload = validPayload();
    const response = await SELF.fetch('https://starwreck.example/api/logs', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Origin: 'https://starwreck.example',
      },
      body: JSON.stringify(payload),
    });

    expect(response.status).toBe(201);
    const result = await response.json<{ ok: boolean; id: string }>();
    expect(result.ok).toBe(true);
    expect(result.id).toMatch(/^[0-9a-f-]{36}$/);

    const objects = await env.RUN_LOGS.list({ include: ['customMetadata'] });
    expect(objects.objects).toHaveLength(1);
    expect(objects.objects[0]!.customMetadata?.eventCount).toBe('1');

    const stored = await env.RUN_LOGS.get(objects.objects[0]!.key);
    expect(await stored?.json()).toEqual(payload);

    const quota = await env.RUN_LOG_QUOTA.prepare(
      'SELECT object_count, total_bytes FROM monthly_log_quota',
    ).first<{ object_count: number; total_bytes: number }>();
    expect(quota?.object_count).toBe(1);
    expect(quota?.total_bytes).toBeGreaterThan(0);
  });

  it('rejects malformed payloads without writing an object', async () => {
    const response = await SELF.fetch('https://starwreck.example/api/logs', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ game: 'starwreck' }),
    });

    expect(response.status).toBe(400);
    expect((await env.RUN_LOGS.list()).objects).toHaveLength(0);
    expect(await env.RUN_LOG_QUOTA.prepare('SELECT COUNT(*) AS count FROM monthly_log_quota').first('count')).toBe(0);
  });

  it('rejects bodies over the explicit size limit', async () => {
    const response = await SELF.fetch('https://starwreck.example/api/logs', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: new Uint8Array(RUN_LOG_MAX_BODY_BYTES + 1),
    });

    expect(response.status).toBe(413);
    expect((await env.RUN_LOGS.list()).objects).toHaveLength(0);
    expect(await env.RUN_LOG_QUOTA.prepare('SELECT COUNT(*) AS count FROM monthly_log_quota').first('count')).toBe(0);
  });

  it('stops before writing when the monthly object quota is exhausted', async () => {
    const month = new Date().toISOString().slice(0, 7);
    await env.RUN_LOG_QUOTA.prepare(
      `INSERT INTO monthly_log_quota (month, object_count, total_bytes, updated_at)
       VALUES (?, ?, 0, ?)`,
    )
      .bind(month, RUN_LOG_MONTHLY_MAX_OBJECTS, new Date().toISOString())
      .run();

    const response = await SELF.fetch('https://starwreck.example/api/logs', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(validPayload()),
    });

    expect(response.status).toBe(429);
    expect((await env.RUN_LOGS.list()).objects).toHaveLength(0);
  });
});
