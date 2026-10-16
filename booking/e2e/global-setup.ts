import { Client } from "pg";
import { migrate } from "../scripts/migrate";
import { seedBase } from "../src/lib/seed/base";
import { E2E_DB } from "../playwright.config";

/** Fresh database per run: drop, create, migrate, seed the fictional demo organisation. */
export default async function globalSetup(): Promise<void> {
  const u = new URL(E2E_DB);
  const name = u.pathname.slice(1);
  u.pathname = "/postgres";
  const admin = new Client({ connectionString: u.toString() });
  await admin.connect();
  await admin.query(`drop database if exists ${name} with (force)`);
  await admin.query(`create database ${name}`);
  await admin.end();
  await migrate(E2E_DB);
  const c = new Client({ connectionString: E2E_DB });
  await c.connect();
  await seedBase(c);
  await c.end();
}
