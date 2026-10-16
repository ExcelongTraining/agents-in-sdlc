import type { Metadata } from "next";
import { BookingWizard } from "./BookingWizard";

export const metadata: Metadata = { title: "Book an appointment" };

export default function BookPage() {
  return (
    <main id="main" className="mx-auto max-w-2xl px-4 py-6">
      <h1 className="text-2xl font-bold">Book an appointment</h1>
      <BookingWizard />
    </main>
  );
}
