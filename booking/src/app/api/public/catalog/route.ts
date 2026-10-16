import { route } from "@/lib/http/route";
import { withTx } from "@/lib/db/tx";
import { loadSettings } from "@/lib/services/settings";

/** What an anonymous visitor may see: bookable services and the first names of qualified masseuses. No schedules, no customers. */
export const GET = route(
  { auth: "public", rate: { name: "catalog", limit: 120, windowSeconds: 60 } },
  async ({ orgId }) =>
    withTx({ kind: "system", orgId, actor: "customer" }, async (tx) => {
      const branches = await tx.query(
        "select id, name, address, timezone from branches where active order by name",
      );
      const services = await tx.query(
        `select s.id, s.name, s.description, s.kind, s.duration_minutes "durationMinutes", case when s.show_price then s.price_myr end "priceMyr", s.branch_id "branchId",
              coalesce((select json_agg(json_build_object('id', sp.id, 'name', sp.display_name) order by sp.display_name)
                          from staff_services ss join staff_profiles sp on sp.id = ss.staff_id where ss.service_id = s.id and sp.active and sp.archived_at is null), '[]') staff
         from services s where s.active and s.online_bookable order by s.kind desc, s.name`,
      );
      const settings = await loadSettings(tx);
      return {
        branches,
        services,
        policy: {
          holdMinutes: settings.booking.holdMinutes,
          changeCutoffHours: settings.booking.changeCutoffHours,
          minNoticeMinutes: settings.booking.minNoticeMinutes,
          maxAdvanceDays: settings.booking.maxAdvanceDays,
        },
      };
    }),
);
