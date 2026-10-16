/* eslint-disable no-console */
import { Client } from "pg";
import { seedBase } from "../src/lib/seed/base";
import { migrate } from "./migrate";

/**
 * Seeds FICTIONAL demo data into an empty database. Refuses to run in production or on a non-empty database.
 * Usage: DATABASE_URL=... SEED_PASSWORD=... tsx scripts/seed.ts
 */
async function main(): Promise<void> {
  if (process.env.NODE_ENV === "production") throw new Error("Seeding demo data is disabled in production");
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error("DATABASE_URL is required");
  await migrate(url);
  const client = new Client({ connectionString: url });
  await client.connect();
  try {
    const { rows } = await client.query("select count(*)::int n from organisations");
    if (rows[0].n > 0) {
      console.log("Database already has an organisation; skipping seed. Use `npm run db:reset` to start over.");
      return;
    }
    await client.query("begin");
    const w = await seedBase(client);
    await client.query("commit");
    console.log(`Seeded demo organisation. Staff logins use password from SEED_PASSWORD (default: ${w.password}).`);
    console.log(`Manager: ${w.manager.email}   Administrator: ${w.admin.email}   Masseuses: ${w.staff.map((s) => s.name.toLowerCase().replace(/\s/g, "") + "@lotus-demo.example").join(", ")}`);
  } finally {
    await client.end();
  }
}
main().catch((e) => {
  console.error(e.message);
  process.exit(1);
});
