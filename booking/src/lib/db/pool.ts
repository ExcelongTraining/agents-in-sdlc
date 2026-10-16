import { Pool, types } from "pg";
import { env } from "../config/env";

// numeric -> number (money amounts and hour fractions are small); int8 -> number (counts); keep timestamptz as Date.
types.setTypeParser(1700, (v) => Number(v));
types.setTypeParser(20, (v) => Number(v));

const globalForPool = globalThis as unknown as { __bkPool?: Pool };

export function getPool(): Pool {
  if (!globalForPool.__bkPool) {
    const e = env();
    globalForPool.__bkPool = new Pool({
      connectionString: e.DATABASE_URL,
      max: e.NODE_ENV === "production" ? 10 : 20,
      idleTimeoutMillis: 30_000,
      connectionTimeoutMillis: 10_000,
      ssl: e.DATABASE_SSL === "true" ? { rejectUnauthorized: true } : undefined,
    });
    globalForPool.__bkPool.on("error", (err) => console.error("pg pool error", err.message));
  }
  return globalForPool.__bkPool;
}

export async function closePool(): Promise<void> {
  if (globalForPool.__bkPool) {
    await globalForPool.__bkPool.end();
    globalForPool.__bkPool = undefined;
  }
}
