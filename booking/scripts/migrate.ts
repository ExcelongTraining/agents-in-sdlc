/* eslint-disable no-console */
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { Client } from "pg";

/**
 * Minimal forward-only migration runner. Applies supabase/migrations/*.sql in filename order and records them in
 * schema_migrations. Works against any PostgreSQL; with Supabase you can alternatively run `supabase db push`.
 * Usage: DATABASE_URL=... tsx scripts/migrate.ts [--reset]
 */
export async function migrate(databaseUrl: string, opts: { reset?: boolean } = {}): Promise<string[]> {
  const client = new Client({ connectionString: databaseUrl });
  await client.connect();
  const applied: string[] = [];
  try {
    if (opts.reset) {
      if (process.env.NODE_ENV === "production") throw new Error("Refusing to reset in production");
      await client.query("drop schema public cascade; create schema public;");
    }
    await client.query(
      "create table if not exists schema_migrations (name text primary key, applied_at timestamptz not null default now())",
    );
    const dir = path.resolve(__dirname, "../supabase/migrations");
    const files = readdirSync(dir).filter((f) => f.endsWith(".sql")).sort();
    const done = new Set((await client.query<{ name: string }>("select name from schema_migrations")).rows.map((r) => r.name));
    for (const file of files) {
      if (done.has(file)) continue;
      await client.query("begin");
      try {
        await client.query(readFileSync(path.join(dir, file), "utf8"));
        await client.query("insert into schema_migrations(name) values ($1)", [file]);
        await client.query("commit");
        applied.push(file);
      } catch (err) {
        await client.query("rollback");
        throw new Error(`Migration ${file} failed: ${(err as Error).message}`);
      }
    }
  } finally {
    await client.end();
  }
  return applied;
}

if (require.main === module || process.argv[1]?.endsWith("migrate.ts")) {
  const url = process.env.DATABASE_URL;
  if (!url) {
    console.error("DATABASE_URL is required");
    process.exit(1);
  }
  migrate(url, { reset: process.argv.includes("--reset") })
    .then((a) => console.log(a.length ? `Applied: ${a.join(", ")}` : "Database is up to date"))
    .catch((e) => {
      console.error(e.message);
      process.exit(1);
    });
}
