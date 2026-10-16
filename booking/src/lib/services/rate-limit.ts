import type { Tx } from "../db/tx";
import { AppError } from "../errors";

/**
 * Fixed-window counter in PostgreSQL (works on serverless without Redis). One atomic upsert per call.
 * Throws RATE_LIMITED when `limit` is exceeded within `windowSeconds`.
 */
export async function rateLimit(tx: Tx, key: string, limit: number, windowSeconds: number): Promise<void> {
  const row = await tx.one<{ count: number }>(
    `insert into rate_limits(key, window_start, count) values ($1, now(), 1)
     on conflict (key) do update set
       count = case when rate_limits.window_start < now() - make_interval(secs => $2) then 1 else rate_limits.count + 1 end,
       window_start = case when rate_limits.window_start < now() - make_interval(secs => $2) then now() else rate_limits.window_start end
     returning count`,
    [key, windowSeconds],
  );
  if (row.count > limit) throw new AppError("RATE_LIMITED", "Too many attempts. Please wait a few minutes and try again.");
}
