import type { Metadata } from "next";
import { requireRole } from "@/lib/http/guard";
import { listHandoffs } from "@/lib/services/whatsapp-inbox";
import { InboxClient } from "./InboxClient";

export const metadata: Metadata = { title: "WhatsApp inbox" };
export const dynamic = "force-dynamic";

export default async function Inbox() {
  const p = await requireRole(["manager"]);
  const rows = await listHandoffs(p);
  return (
    <div className="space-y-3">
      <h1 className="text-2xl font-bold">WhatsApp chats waiting for a person</h1>
      {rows.length === 0 ? <p>No chats are waiting.</p> : <InboxClient rows={rows} />}
    </div>
  );
}
