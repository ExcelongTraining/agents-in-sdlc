import type { Metadata } from "next";
import Link from "next/link";

export const metadata: Metadata = { title: "Privacy notice" };

/**
 * DRAFT notice text for the business and a qualified Malaysian privacy adviser to review and adopt.
 * It is not legal advice and compliance is not claimed. Bump NOTICE_VERSION in whatsapp-conversation.ts and the booking
 * form when the wording changes so consent records stay accurate.
 */
export default function Privacy() {
  return (
    <main id="main" className="mx-auto max-w-2xl px-4 py-10">
      <p>
        <Link href="/" className="underline">
          ← Home
        </Link>
      </p>
      <h1 className="mt-2 text-3xl font-bold">
        Privacy notice <span className="text-muted text-base">(draft, version 2026-01)</span>
      </h1>
      <div className="mt-4 space-y-4">
        <p className="alert alert-warn">
          This is draft wording for review by the business and a qualified Malaysian privacy adviser before
          going live.
        </p>
        <section>
          <h2 className="text-xl font-semibold">What we collect and why</h2>
          <p>
            Your name, phone number, optional e-mail, and the details of your booking (service, time,
            masseuse). We use them to arrange and run your appointment, to contact you about it, and to keep
            our schedule accurate.
          </p>
        </section>
        <section>
          <h2 className="text-xl font-semibold">WhatsApp messages</h2>
          <p>
            If you tick the WhatsApp box we send booking confirmations, changes and reminders to your number.
            Reply STOP at any time to stop. Marketing messages are separate and off unless you opt in.
          </p>
        </section>
        <section>
          <h2 className="text-xl font-semibold">Health information</h2>
          <p>
            Please do not put health details in booking notes. If something matters for your treatment, tell
            your therapist in person.
          </p>
        </section>
        <section>
          <h2 className="text-xl font-semibold">Who sees your data</h2>
          <p>
            Our manager sees all bookings. Your masseuse sees your first name and booking details for her own
            appointments. Our technical administrator cannot see customer details. Our hosting and messaging
            providers process data on our behalf.
          </p>
        </section>
        <section>
          <h2 className="text-xl font-semibold">How long we keep it</h2>
          <p>
            Booking records are kept while you remain an active customer and are anonymised after a period of
            inactivity (the business sets this period; default 36 months). WhatsApp message text is removed
            after about 90 days.
          </p>
        </section>
        <section>
          <h2 className="text-xl font-semibold">Your rights</h2>
          <p>
            You can ask to see, correct or delete the data we hold about you. Contact the centre and we will
            verify your identity and respond within the period the business has set (default 21 days).
          </p>
        </section>
        <section>
          <h2 className="text-xl font-semibold">Cancellation policy</h2>
          <p>
            You can change or cancel online free of charge up to 24 hours before your appointment (the
            business can change this). After that, please contact us directly.
          </p>
        </section>
      </div>
    </main>
  );
}
