"use client";
import { useState } from "react";
import { Alert, TextAreaField, api } from "@/components/ui";
import { useAction } from "@/components/actions";
import type { HandoffRow } from "@/lib/services/whatsapp-inbox";

function Conversation({ row }: { row: HandoffRow }) {
  const { error, busy, run } = useAction();
  const [text, setText] = useState("");
  return (
    <section className="card space-y-3" aria-label={`Chat with ${row.contactName ?? row.phoneMasked}`}>
      <h2 className="font-semibold">
        {row.contactName ?? "Customer"} <span className="text-muted">{row.phoneMasked}</span>
      </h2>
      <ul className="space-y-1 text-sm">
        {row.messages.map((m, i) => (
          <li key={i} className={m.direction === "inbound" ? "" : "text-right text-muted"}>
            {m.body ?? "(message removed after retention period)"}
          </li>
        ))}
      </ul>
      {error && <Alert kind="error">{error}</Alert>}
      {row.windowOpen ? (
        <form
          onSubmit={(e) => {
            e.preventDefault();
            void run(async () => {
              await api("/api/admin/inbox", { body: { action: "reply", conversationId: row.id, text } });
              setText("");
            });
          }}
          className="space-y-2"
        >
          <TextAreaField
            label="Reply"
            required
            maxLength={1000}
            value={text}
            onChange={(e) => setText(e.target.value)}
          />
          <button className="btn btn-primary" disabled={busy}>
            Send reply
          </button>
        </form>
      ) : (
        <Alert kind="warn">The 24-hour window is closed. Phone the customer instead.</Alert>
      )}
      <button
        className="btn"
        disabled={busy}
        onClick={() =>
          void run(() => api("/api/admin/inbox", { body: { action: "resolve", conversationId: row.id } }))
        }
      >
        Mark resolved (hand back to the assistant)
      </button>
    </section>
  );
}
export function InboxClient({ rows }: { rows: HandoffRow[] }) {
  return (
    <div className="space-y-3">
      {rows.map((r) => (
        <Conversation key={r.id} row={r} />
      ))}
    </div>
  );
}
