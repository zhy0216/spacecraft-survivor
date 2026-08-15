const RUN_LOG_PATH = '/api/logs';
const RUN_LOG_GAME_ID = 'starwreck';
const RUN_LOG_PAYLOAD_VERSION = 1;
const RUN_LOG_MAX_EVENTS = 8192;

/** 日志是有界 JSON，不是任意文件上传；1 MiB 足够最坏情况下的 8192 条事件。 */
export const RUN_LOG_MAX_BODY_BYTES = 1024 * 1024;
/** 双重硬闸：按月最多 5,000 个对象，同时总正文不超过 4 GB。 */
export const RUN_LOG_MONTHLY_MAX_OBJECTS = 5000;
export const RUN_LOG_MONTHLY_MAX_BYTES = 4_000_000_000;

interface ValidRunLogPayload {
  v: number;
  game: string;
  seed: number;
  events: unknown[];
  truncated: boolean;
  result: number;
  survivedSec: number;
  kills: number;
  eliteKills: number;
  segment: number;
  bossKilledAtSec: number;
  peakDps: number;
  weaponReport: Array<{ type: number; damage: number }>;
}

class PayloadTooLargeError extends Error {}

interface QuotaUsage {
  object_count: number;
  total_bytes: number;
}

function json(data: unknown, status = 200): Response {
  return Response.json(data, {
    status,
    headers: {
      'Cache-Control': 'no-store',
      'X-Content-Type-Options': 'nosniff',
    },
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function isNonNegativeNumber(value: unknown): value is number {
  return isFiniteNumber(value) && value >= 0;
}

function isNonNegativeInteger(value: unknown): value is number {
  return isNonNegativeNumber(value) && Number.isInteger(value);
}

function isWeaponReport(value: unknown): value is ValidRunLogPayload['weaponReport'] {
  return (
    Array.isArray(value) &&
    value.length <= 64 &&
    value.every(
      (entry) =>
        isRecord(entry) &&
        isNonNegativeInteger(entry.type) &&
        isNonNegativeNumber(entry.damage),
    )
  );
}

export function isValidRunLogPayload(value: unknown): value is ValidRunLogPayload {
  if (!isRecord(value)) return false;

  return (
    value.v === RUN_LOG_PAYLOAD_VERSION &&
    value.game === RUN_LOG_GAME_ID &&
    isNonNegativeInteger(value.seed) &&
    value.seed <= 0xffffffff &&
    Array.isArray(value.events) &&
    value.events.length <= RUN_LOG_MAX_EVENTS &&
    typeof value.truncated === 'boolean' &&
    (value.result === 1 || value.result === 2) &&
    isNonNegativeNumber(value.survivedSec) &&
    isNonNegativeInteger(value.kills) &&
    isNonNegativeInteger(value.eliteKills) &&
    isNonNegativeInteger(value.segment) &&
    isNonNegativeNumber(value.bossKilledAtSec) &&
    isNonNegativeNumber(value.peakDps) &&
    isWeaponReport(value.weaponReport)
  );
}

async function readBodyWithLimit(request: Request, limit: number): Promise<Uint8Array> {
  const declaredLength = request.headers.get('Content-Length');
  if (declaredLength !== null) {
    const length = Number(declaredLength);
    if (Number.isFinite(length) && length > limit) throw new PayloadTooLargeError();
  }

  if (request.body === null) return new Uint8Array();

  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;

  while (true) {
    const chunk = await reader.read();
    if (chunk.done) break;

    total += chunk.value.byteLength;
    if (total > limit) {
      await reader.cancel('run log payload too large');
      throw new PayloadTooLargeError();
    }
    chunks.push(chunk.value);
  }

  const body = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return body;
}

function buildObjectKey(now: Date, id: string): string {
  const [date] = now.toISOString().split('T');
  const [year, month, day] = date!.split('-');
  return `logs/${year}/${month}/${day}/${now.toISOString().replaceAll(':', '-')}-${id}.json`;
}

async function reserveMonthlyQuota(env: Env, now: Date, byteLength: number): Promise<QuotaUsage | null> {
  const month = now.toISOString().slice(0, 7);
  const updatedAt = now.toISOString();
  const results = await env.RUN_LOG_QUOTA.batch<QuotaUsage>([
    env.RUN_LOG_QUOTA.prepare(
      `INSERT OR IGNORE INTO monthly_log_quota (month, object_count, total_bytes, updated_at)
       VALUES (?, 0, 0, ?)`,
    ).bind(month, updatedAt),
    env.RUN_LOG_QUOTA.prepare(
      `UPDATE monthly_log_quota
       SET object_count = object_count + 1,
           total_bytes = total_bytes + ?,
           updated_at = ?
       WHERE month = ?
         AND object_count < ?
         AND total_bytes + ? <= ?
       RETURNING object_count, total_bytes`,
    ).bind(
      byteLength,
      updatedAt,
      month,
      RUN_LOG_MONTHLY_MAX_OBJECTS,
      byteLength,
      RUN_LOG_MONTHLY_MAX_BYTES,
    ),
  ]);

  return results[1]?.results[0] ?? null;
}

async function releaseMonthlyQuota(env: Env, now: Date, byteLength: number): Promise<void> {
  await env.RUN_LOG_QUOTA.prepare(
    `UPDATE monthly_log_quota
     SET object_count = MAX(0, object_count - 1),
         total_bytes = MAX(0, total_bytes - ?),
         updated_at = ?
     WHERE month = ?`,
  )
    .bind(byteLength, new Date().toISOString(), now.toISOString().slice(0, 7))
    .run();
}

async function storeRunLog(request: Request, env: Env): Promise<Response> {
  const requestOrigin = request.headers.get('Origin');
  if (requestOrigin !== null && requestOrigin !== new URL(request.url).origin) {
    return json({ ok: false, error: 'origin-not-allowed' }, 403);
  }

  const contentType = request.headers.get('Content-Type')?.toLowerCase() ?? '';
  if (!contentType.startsWith('application/json')) {
    return json({ ok: false, error: 'content-type-must-be-json' }, 415);
  }

  let bytes: Uint8Array;
  try {
    bytes = await readBodyWithLimit(request, RUN_LOG_MAX_BODY_BYTES);
  } catch (error) {
    if (error instanceof PayloadTooLargeError) {
      return json({ ok: false, error: 'payload-too-large' }, 413);
    }
    throw error;
  }

  let payload: unknown;
  try {
    payload = JSON.parse(new TextDecoder().decode(bytes));
  } catch {
    return json({ ok: false, error: 'invalid-json' }, 400);
  }

  if (!isValidRunLogPayload(payload)) {
    return json({ ok: false, error: 'invalid-run-log' }, 400);
  }

  const now = new Date();
  const id = crypto.randomUUID();
  const quota = await reserveMonthlyQuota(env, now, bytes.byteLength);
  if (quota === null) {
    return json({ ok: false, error: 'monthly-quota-exceeded' }, 429);
  }

  const key = buildObjectKey(now, id);
  try {
    await env.RUN_LOGS.put(key, bytes, {
      httpMetadata: { contentType: 'application/json; charset=utf-8' },
      customMetadata: {
        game: payload.game,
        payloadVersion: String(payload.v),
        seed: String(payload.seed),
        result: String(payload.result),
        eventCount: String(payload.events.length),
        truncated: String(payload.truncated),
      },
    });
  } catch (error) {
    try {
      await releaseMonthlyQuota(env, now, bytes.byteLength);
    } catch (releaseError) {
      console.error(
        JSON.stringify({
          message: 'failed to release run log quota',
          id,
          error: releaseError instanceof Error ? releaseError.message : String(releaseError),
        }),
      );
    }
    throw error;
  }

  console.log(
    JSON.stringify({
      message: 'run log stored',
      id,
      key,
      bytes: bytes.byteLength,
      events: payload.events.length,
      result: payload.result,
      monthlyObjects: quota.object_count,
      monthlyBytes: quota.total_bytes,
    }),
  );

  return json({ ok: true, id }, 201);
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    try {
      if (url.pathname === RUN_LOG_PATH) {
        if (request.method !== 'POST') {
          return new Response(null, {
            status: 405,
            headers: { Allow: 'POST', 'Cache-Control': 'no-store' },
          });
        }
        return await storeRunLog(request, env);
      }

      return await env.ASSETS.fetch(request);
    } catch (error) {
      console.error(
        JSON.stringify({
          message: 'request failed',
          method: request.method,
          path: url.pathname,
          error: error instanceof Error ? error.message : String(error),
        }),
      );
      return json({ ok: false, error: 'internal-error' }, 500);
    }
  },
} satisfies ExportedHandler<Env>;
