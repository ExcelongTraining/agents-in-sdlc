import { z } from "zod";
import { route } from "@/lib/http/route";
import { listTemplates, updateTemplate } from "@/lib/services/admin";

export const GET = route({ auth: "staff" }, async ({ principal }) => ({
  items: await listTemplates(principal!),
}));
export const PATCH = route(
  {
    auth: "staff",
    permission: "integrations.manage",
    body: z.object({
      id: z.uuid(),
      status: z.string().optional(),
      providerTemplateId: z.string().max(100).nullable().optional(),
      name: z.string().max(100).optional(),
    }),
  },
  async ({ body, principal }) => {
    await updateTemplate(principal!, body.id, body);
    return { ok: true };
  },
);
