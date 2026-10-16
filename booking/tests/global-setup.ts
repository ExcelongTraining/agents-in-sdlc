import { Client } from "pg";
import { randomBytes } from "node:crypto";
import { migrate } from "../scripts/migrate";
import type { TestProject } from "vitest/node";

declare module "vitest" {
  export interface ProvidedContext {
    dbUrl: string;
  }
}

/**
 * Creates a throw-away database from the migrations, so tests exercise real PostgreSQL (exclusion constraints,
 * triggers, RLS). Needs TEST_DATABASE_ADMIN_URL (a superuser/createdb connection to any database).
 * Default matches the CI service container and the local sandbox.
 */
export default async function setup(project: TestProject): Promise<() => Promise<void>> {
  const adminUrl =
    process.env.TEST_DATABASE_ADMIN_URL ?? "postgres://postgres:postgres@localhost:5432/postgres";
  const name = `bk_test_${randomBytes(4).toString("hex")}`;
  const admin = new Client({ connectionString: adminUrl });
  try {
    await admin.connect();
  } catch (e) {
    throw new Error(
      `Cannot connect to PostgreSQL for tests (${(e as Error).message}). Set TEST_DATABASE_ADMIN_URL. See README.`,
    );
  }
  await admin.query(`create database ${name}`);
  const u = new URL(adminUrl);
  u.pathname = `/${name}`;
  await migrate(u.toString());
  project.provide("dbUrl", u.toString());
  return async () => {
    await admin.query(`drop database if exists ${name} with (force)`);
    await admin.end();
  };
}
