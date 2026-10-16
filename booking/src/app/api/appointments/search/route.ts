import { z } from "zod";
import { DateTime } from "luxon";
import { route } from "@/lib/http/route";
import { can } from "@/lib/domain/rbac";
import { withTx } from "@/lib/db/tx";
import { searchSlots } from "@/lib/services/availability";
import { formatLocal } from "@/lib/domain/time";

/** Staff-side slot search (no notice limits). Masseuses can only search their own slots. */
export const GET = route({ auth: "staff" }, async ({ req, principal, orgId }) => {
  const sp = Object.fromEntries(new URL(req.url).searchParams);
  const p = z
    .object({
      branchId: z.uuid(),
      serviceId: z.uuid(),
      staffId: z.union([z.uuid(), z.literal("any")]).default("any"),
      from: z.iso.date(),
      days: z.coerce.number().int().min(1).max(14).default(1),
    })
    .parse(sp);
  const staffId = can(principal!, "schedule.read.all")
    ? p.staffId === "any"
      ? undefined
      : p.staffId
    : (principal!.staffId ?? "00000000-0000-0000-0000-000000000000");
  const to = DateTime.fromISO(p.from)
    .plus({ days: p.days - 1 })
    .toISODate() as string;
  return withTx({ kind: "system", orgId, actor: "user", userId: principal!.userId }, async (tx) => {
    const { grouped, staffNames } = await searchSlots(tx, {
      branchId: p.branchId,
      serviceId: p.serviceId,
      fromDate: p.from,
      toDate: to,
      staffId,
      now: new Date(),
      enforceNotice: false,
    });
    const tz = (
      await tx.one<{ timezone: string }>("select timezone from branches where id = $1", [p.branchId])
    ).timezone;
    return {
      slots: grouped.map((g) => ({
        startAt: g.startAt.toISOString(),
        local: formatLocal(g.startAt, tz, "EEE d MMM, h:mm a"),
        staff: g.staffIds.map((id) => ({ id, name: staffNames.get(id) ?? "" })),
      })),
    };
  });
});
