import type { Metadata } from "next";
import { requireRole } from "@/lib/http/guard";
import { bookingFormData } from "@/lib/services/catalog";
import { BookingForm } from "@/components/BookingForm";

export const metadata: Metadata = { title: "New booking" };
export const dynamic = "force-dynamic";

export default async function NewBooking() {
  const p = await requireRole(["manager"]);
  const d = await bookingFormData(p);
  return (
    <div className="space-y-3">
      <h1 className="text-2xl font-bold">New booking (telephone / walk-in)</h1>
      <BookingForm mode="manager" {...d} />
    </div>
  );
}
