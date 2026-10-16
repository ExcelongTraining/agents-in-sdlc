import { inject } from "vitest";

process.env.DATABASE_URL = inject("dbUrl");
process.env.APP_SECRET = "test-secret-test-secret-test-secret-0123";
process.env.APP_BASE_URL = "http://localhost:3000";
process.env.WHATSAPP_PROVIDER = "mock";
process.env.ORG_SLUG = "lotus-demo";
process.env.CRON_SECRET = "test-cron-secret-0123456789";
(process.env as Record<string, string>).NODE_ENV = "test";
