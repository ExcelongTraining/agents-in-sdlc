import type { Metadata } from "next";
import { requireRole } from "@/lib/http/guard";
import { PrivacyClient } from "./PrivacyClient";

export const metadata: Metadata = { title: "Privacy requests" };
export const dynamic = "force-dynamic";

export default async function PrivacyAdmin() {
  await requireRole(["manager"]);
  return (
    <div className="space-y-4">
      <h1 className="text-2xl font-bold">Privacy requests</h1>
      <p className="text-sm text-muted">
        Verify the requester&rsquo;s identity first. Access gives you a file of everything held; deletion
        anonymises the person (bookings stay, without identifiers).
      </p>
      <PrivacyClient />
    </div>
  );
}
