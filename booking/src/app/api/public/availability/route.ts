import { z } from "zod";
import { DateTime } from "luxon";
import { route } from "@/lib/http/route";
import { withTx } from "@/lib/db/tx";
import { searchSlots } from "@/lib/services/availability";
import { formatLocal } from "@/lib/domain/time";

const q = z.object({
  branchId: z.uuid(),
  serviceId: z.uuid(),
  staffId: z.union([z.uuid(), z.literal("any")]).default("any"),
  from: z.iso.date(),
  days: z.coerce.number().int().min(1).max(14).default(7),
});

/** Genuinely free slots only (same engine the booking transaction uses). Public: returns times and first names, never other customers. */
export const GET = route(
  { auth: "public", rate: { name: "avail", limit: 60, windowSeconds: 60 } },
  async ({ req, orgId }) => {
    const p = q.parse(Object.fromEntries(new URL(req.url).searchParams));
    const to = DateTime.fromISO(p.from)
      .plus({ days: p.days - 1 })
      .toISODate() as string;
    return withTx({ kind: "system", orgId, actor: "customer" }, async (tx) => {
      const { slots, grouped, staffNames } = await searchSlots(tx, {
        branchId: p.branchId,
        serviceId: p.serviceId,
        fromDate: p.from,
        toDate: to,
        staffId: p.staffId === "any" ? undefined : p.staffId,
        now: new Date(),
        enforceNotice: true,
        publicOnly: true,
      });
      const tz = (
        await tx.one<{ timezone: string }>("select timezone from branches where id = $1", [p.branchId])
      ).timezone;
      void slots;
      return {
        timezone: tz,
        slots: grouped.map((g) => ({
          startAt: g.startAt.toISOString(),
          endAt: g.endAt.toISOString(),
          local: formatLocal(g.startAt, tz, "h:mm a"),
          date: DateTime.fromJSDate(g.startAt, { zone: tz }).toISODate(),
          hour: DateTime.fromJSDate(g.startAt, { zone: tz }).hour,
          staff: g.staffIds.map((id) => ({ id, name: staffNames.get(id) ?? "" })),
        })),
      };
    });
  },
);
