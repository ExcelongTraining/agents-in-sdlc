import Link from "next/link";

export default function Home() {
  return (
    <main id="main" className="mx-auto max-w-2xl px-4 py-10">
      <h1 className="text-3xl font-bold">
        Lotus Wellness Centre <span className="text-muted text-lg">(demo)</span>
      </h1>
      <p className="mt-3 text-lg">
        See real-time availability and book a massage, a first-time trial, or a consultation. No account
        needed.
      </p>
      <div className="mt-6 flex flex-wrap gap-3">
        <Link href="/book" className="btn btn-primary">
          Book now
        </Link>
        <Link href="/my-bookings" className="btn">
          View my bookings
        </Link>
        <Link href="/login" className="btn">
          Staff sign in
        </Link>
      </div>
      <section className="card mt-8" aria-labelledby="how">
        <h2 id="how" className="text-lg font-semibold">
          How it works
        </h2>
        <ol className="mt-2 list-decimal space-y-1 pl-5">
          <li>Choose a service, or a short consultation first.</li>
          <li>Pick a masseuse, or &ldquo;any available&rdquo;. Only genuinely free times are shown.</li>
          <li>We hold your time for a few minutes while you enter your details.</li>
          <li>You get a confirmation on WhatsApp (if you agree) and a link to change or cancel.</li>
        </ol>
      </section>
      <p className="hint mt-6">
        <Link href="/privacy" className="underline">
          Privacy notice
        </Link>{" "}
        · Demo system with fictional data.
      </p>
    </main>
  );
}
