/**
 * Report quotas, counted in D1 so concurrent requests cannot read the same
 * count and all pass (the KV read-then-write did): each request takes a
 * slot with one atomic upsert, and gives it back if the report is not filed.
 *
 * Two quotas apply: per client (its address, or its IPv6 /64) and for the
 * whole site per day, which bounds what the repository token can be made to
 * post however many addresses a sender has. Client rows hold a SHA-256 of
 * the client key, never the address.
 */

export const REPORT_QUOTA_LIMIT = 3;
export const REPORT_QUOTA_WINDOW_SECONDS = 600;
export const REPORT_DAILY_LIMIT = 50;
const DAY_SECONDS = 24 * 60 * 60;
const GLOBAL_KEY = 'global';

interface Quota {
  readonly key: string;
  readonly limit: number;
  readonly windowSeconds: number;
}

/** A slot taken, or the seconds until one frees up. */
export type ReportSlot =
  | { readonly ok: true; readonly release: () => Promise<void> }
  | { readonly ok: false; readonly retryAfter: number };

/**
 * Takes one count in a window that restarts once `windowSeconds` have passed
 * since it opened. Returns the count after this request and when the window
 * opened (epoch seconds).
 */
async function take(
  db: D1Database,
  quota: Quota,
  now: number,
): Promise<{ count: number; windowStart: number }> {
  const row = await db
    .prepare(
      `INSERT INTO report_quota (key, window_start, count) VALUES (?1, ?2, 1)
       ON CONFLICT(key) DO UPDATE SET
         count = CASE WHEN window_start <= ?3 THEN 1 ELSE count + 1 END,
         window_start = CASE WHEN window_start <= ?3 THEN ?2 ELSE window_start END
       RETURNING count, window_start`,
    )
    .bind(quota.key, now, now - quota.windowSeconds)
    .first<{ count: number; window_start: number }>();
  if (!row) throw new Error('report quota: no row returned');
  return { count: row.count, windowStart: row.window_start };
}

/**
 * Gives back a slot taken in the window opened at `windowStart`. A window
 * that has restarted since keeps its count: the slot belonged to the old
 * one.
 */
async function giveBack(
  db: D1Database,
  key: string,
  windowStart: number,
): Promise<void> {
  await db
    .prepare(
      'UPDATE report_quota SET count = count - 1 WHERE key = ? AND window_start = ? AND count > 0',
    )
    .bind(key, windowStart)
    .run();
}

async function sha256Hex(text: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    'SHA-256',
    new TextEncoder().encode(text),
  );
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, '0'))
    .join('');
}

/**
 * Takes a report slot for `client` (see clientKey), checking the client
 * quota first, then the daily one. `release` gives the slots back when the
 * report could not be filed.
 */
export async function takeReportSlot(
  db: D1Database,
  client: string,
  now = Math.floor(Date.now() / 1000),
): Promise<ReportSlot> {
  const quotas: Quota[] = [
    {
      key: `client:${await sha256Hex(client)}`,
      limit: REPORT_QUOTA_LIMIT,
      windowSeconds: REPORT_QUOTA_WINDOW_SECONDS,
    },
    { key: GLOBAL_KEY, limit: REPORT_DAILY_LIMIT, windowSeconds: DAY_SECONDS },
  ];
  const taken: Array<{ key: string; windowStart: number }> = [];
  for (const quota of quotas) {
    const { count, windowStart } = await take(db, quota, now);
    taken.push({ key: quota.key, windowStart });
    if (count > quota.limit) {
      for (const slot of taken) await giveBack(db, slot.key, slot.windowStart);
      return {
        ok: false,
        retryAfter: Math.max(1, windowStart + quota.windowSeconds - now),
      };
    }
  }
  return {
    ok: true,
    release: async () => {
      for (const slot of taken) await giveBack(db, slot.key, slot.windowStart);
    },
  };
}

/** Deletes the rows of windows that closed over a day ago (daily cron). */
export async function purgeReportQuotas(
  db: D1Database,
  now = Math.floor(Date.now() / 1000),
): Promise<void> {
  await db
    .prepare('DELETE FROM report_quota WHERE window_start < ?')
    .bind(now - 2 * DAY_SECONDS)
    .run();
}
