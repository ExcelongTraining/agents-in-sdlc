import { route } from "@/lib/http/route";
import { integrationStatus } from "@/lib/services/admin";

export const GET = route({ auth: "staff", permission: "integrations.manage" }, async ({ principal }) =>
  integrationStatus(principal!),
);
