import type { Metadata } from "next";
import { requireRole } from "@/lib/http/guard";
import { listServices } from "@/lib/services/admin";
import { listStaff } from "@/lib/services/schedule";
import { ServiceEditor } from "./ServiceEditor";

export const metadata: Metadata = { title: "Services" };
export const dynamic = "force-dynamic";

export default async function Services() {
  const p = await requireRole(["manager"]);
  const [services, staff] = await Promise.all([listServices(p), listStaff(p)]);
  return (
    <div className="space-y-4">
      <h1 className="text-2xl font-bold">Services</h1>
      <ServiceEditor
        staff={staff}
        services={services.map((s) => ({
          id: s.id,
          name: s.name,
          description: s.description ?? "",
          kind: s.kind,
          durationMinutes: s.duration_minutes,
          bufferBeforeMinutes: s.buffer_before_minutes,
          bufferAfterMinutes: s.buffer_after_minutes,
          priceMyr: s.price_myr,
          showPrice: s.show_price,
          onlineBookable: s.online_bookable,
          countsTowardKpi: s.counts_toward_kpi,
          requiresRoom: s.requires_room,
          active: s.active,
          staffIds: s.staff_ids,
        }))}
      />
    </div>
  );
}
