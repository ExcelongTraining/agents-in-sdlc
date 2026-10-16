import type { Metadata } from "next";
import { requireRole } from "@/lib/http/guard";
import { bookingFormData } from "@/lib/services/catalog";
import { BookingForm } from "@/components/BookingForm";

export const metadata: Metadata = { title: "Record a booking" };
export const dynamic = "force-dynamic";

export default async function NewDirect() {
  const p = await requireRole(["masseuse"]);
  const d = await bookingFormData(p);
  const mine = d.services.filter((s) => p.staffId && s.staffIds.includes(p.staffId));
  return (
    <div className="space-y-3">
      <h1 className="text-2xl font-bold">Record a booking a customer made with you</h1>
      <p className="text-sm text-muted">
        This goes through the same availability check as every other booking, so it cannot clash with the
        manager&rsquo;s schedule.
      </p>
      <BookingForm
        mode="staff"
        branchId={d.branchId}
        services={mine}
        staff={d.staff}
        selfStaffId={p.staffId ?? undefined}
      />
    </div>
  );
}
