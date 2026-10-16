import type { Metadata } from "next";
import { MyBookings } from "./MyBookings";

export const metadata: Metadata = { title: "My bookings", robots: { index: false } };

export default function Page() {
  return (
    <main id="main" className="mx-auto max-w-2xl px-4 py-6">
      <h1 className="text-2xl font-bold">My bookings</h1>
      <MyBookings />
    </main>
  );
}
