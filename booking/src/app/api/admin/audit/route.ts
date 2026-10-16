import { route } from "@/lib/http/route";
import { listAudit } from "@/lib/services/admin";

export const GET = route({ auth: "staff", permission: "audit.read" }, async ({ req, principal }) => {
  const sp = new URL(req.url).searchParams;
  return {
    items: await listAudit(principal!, {
      entityType: sp.get("entityType") ?? undefined,
      entityId: sp.get("entityId") ?? undefined,
      before: sp.get("before") ? Number(sp.get("before")) : undefined,
    }),
  };
});
