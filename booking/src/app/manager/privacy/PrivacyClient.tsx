"use client";
import { useState } from "react";
import { Alert, TextField, api, errorMessage } from "@/components/ui";

interface C {
  id: string;
  display_name: string;
  phone_e164: string;
}

export function PrivacyClient() {
  const [q, setQ] = useState("");
  const [rows, setRows] = useState<C[]>([]);
  const [msg, setMsg] = useState("");
  const [error, setError] = useState("");
  const [reason, setReason] = useState("");

  async function search(e: React.FormEvent) {
    e.preventDefault();
    setError("");
    setMsg("");
    try {
      setRows((await api<{ items: C[] }>(`/api/admin/customers?q=${encodeURIComponent(q)}`)).items);
    } catch (err) {
      setError(errorMessage(err));
    }
  }
  async function exportData(c: C) {
    setError("");
    try {
      const data = await api("/api/admin/privacy", { body: { action: "export", customerId: c.id } });
      const url = URL.createObjectURL(
        new Blob([JSON.stringify(data, null, 2)], { type: "application/json" }),
      );
      const a = document.createElement("a");
      a.href = url;
      a.download = `customer-data-${c.id}.json`;
      a.click();
      URL.revokeObjectURL(url);
      await api("/api/admin/privacy", {
        body: { action: "log", request: { customerId: c.id, kind: "access", note: "Exported by manager" } },
      });
      setMsg("Export downloaded and logged.");
    } catch (err) {
      setError(errorMessage(err));
    }
  }
  async function anonymise(c: C) {
    if (!confirm(`Permanently remove the identity of ${c.display_name}? This cannot be undone.`)) return;
    setError("");
    try {
      await api("/api/admin/privacy", { body: { action: "anonymise", customerId: c.id, reason } });
      setMsg("Customer anonymised.");
      setRows(rows.filter((r) => r.id !== c.id));
    } catch (err) {
      setError(errorMessage(err));
    }
  }
  return (
    <div className="space-y-4">
      {error && <Alert kind="error">{error}</Alert>}
      {msg && <Alert kind="ok">{msg}</Alert>}
      <form onSubmit={search} className="card flex max-w-xl items-end gap-2">
        <div className="flex-1">
          <TextField
            label="Find a customer (name or phone)"
            value={q}
            onChange={(e) => setQ(e.target.value)}
          />
        </div>
        <button className="btn">Search</button>
      </form>
      <TextField
        label="Reference for deletion (request number)"
        value={reason}
        onChange={(e) => setReason(e.target.value)}
      />
      <ul className="space-y-2">
        {rows.map((c) => (
          <li key={c.id} className="card flex flex-wrap items-center justify-between gap-2">
            <span>
              {c.display_name} · {c.phone_e164}
            </span>
            <span className="flex gap-2">
              <button className="btn" onClick={() => void exportData(c)}>
                Export data
              </button>
              <button
                className="btn btn-danger"
                disabled={reason.trim().length < 5}
                onClick={() => void anonymise(c)}
              >
                Delete (anonymise)
              </button>
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
}
