import { route } from "@/lib/http/route";
import { listSchedule } from "@/lib/services/schedule";

export const GET = route({ auth: "staff" }, async ({ req, principal }) => {
  const sp = new URL(req.url).searchParams;
  return {
    items: await listSchedule(principal!, {
      from: sp.get("from") as string,
      to: sp.get("to") as string,
      staffId: sp.get("staffId") ?? undefined,
    }),
  };
});
