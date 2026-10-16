import type { Metadata } from "next";
import { ManageClient } from "./ManageClient";

export const metadata: Metadata = { title: "Manage your booking", robots: { index: false } };

export default async function ManagePage({ params }: { params: Promise<{ token: string }> }) {
  const { token } = await params;
  return (
    <main id="main" className="mx-auto max-w-2xl px-4 py-6">
      <h1 className="text-2xl font-bold">Your booking</h1>
      <ManageClient token={token} />
    </main>
  );
}
