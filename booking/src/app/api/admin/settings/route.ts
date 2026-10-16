import { z } from "zod";
import { route } from "@/lib/http/route";
import { getSettings, updateSettings } from "@/lib/services/admin";
import type { SettingsGroup } from "@/lib/services/settings";

export const GET = route({ auth: "staff", permission: "settings.manage" }, async ({ principal }) =>
  getSettings(principal!),
);
export const PUT = route(
  {
    auth: "staff",
    permission: "settings.manage",
    body: z.object({ group: z.string(), value: z.unknown(), reason: z.string().min(3).max(200) }),
  },
  async ({ body, principal }) => {
    await updateSettings(principal!, body.group as SettingsGroup, body.value, body.reason);
    return { ok: true };
  },
);
