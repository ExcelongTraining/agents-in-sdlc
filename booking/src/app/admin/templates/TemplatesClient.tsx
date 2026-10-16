"use client";
import { useState } from "react";
import { Alert, api } from "@/components/ui";
import { useAction } from "@/components/actions";

interface T {
  id: string;
  purpose: string;
  name: string;
  language: string;
  category: string;
  status: string;
  providerId: string;
  body: string;
}

export function TemplatesClient({ rows, canEdit }: { rows: T[]; canEdit: boolean }) {
  const { error, busy, run } = useAction();
  const [draft, setDraft] = useState<Record<string, Partial<T>>>({});
  return (
    <div className="space-y-2">
      {error && <Alert kind="error">{error}</Alert>}
      <div className="overflow-x-auto" tabIndex={0} role="region" aria-label="Templates (scrollable)">
        <table className="table">
          <caption className="sr-only">Templates</caption>
          <thead>
            <tr>
              <th scope="col">Purpose</th>
              <th scope="col">Registered name</th>
              <th scope="col">Lang</th>
              <th scope="col">Category</th>
              <th scope="col">Status</th>
              <th scope="col">Provider id</th>
              <th scope="col">Text (preview)</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => {
              const d = { ...r, ...draft[r.id] };
              const set = (p: Partial<T>) => setDraft({ ...draft, [r.id]: { ...draft[r.id], ...p } });
              return (
                <tr key={r.id}>
                  <th scope="row" className="font-normal">
                    {r.purpose}
                  </th>
                  <td>
                    {canEdit ? (
                      <input
                        aria-label={`Name for ${r.purpose}`}
                        className="input"
                        value={d.name}
                        onChange={(e) => set({ name: e.target.value })}
                      />
                    ) : (
                      r.name
                    )}
                  </td>
                  <td>{r.language}</td>
                  <td>{r.category}</td>
                  <td>
                    {canEdit ? (
                      <select
                        aria-label={`Status for ${r.purpose}`}
                        className="input"
                        value={d.status}
                        onChange={(e) => set({ status: e.target.value })}
                      >
                        {["draft", "submitted", "approved", "rejected", "paused", "disabled"].map((s) => (
                          <option key={s}>{s}</option>
                        ))}
                      </select>
                    ) : (
                      <span className="badge">{r.status}</span>
                    )}
                  </td>
                  <td>
                    {canEdit ? (
                      <input
                        aria-label={`Provider id for ${r.purpose}`}
                        className="input"
                        value={d.providerId}
                        onChange={(e) => set({ providerId: e.target.value })}
                      />
                    ) : (
                      r.providerId
                    )}
                  </td>
                  <td className="text-xs text-muted">
                    {r.body}
                    {canEdit && draft[r.id] && (
                      <button
                        className="btn mt-1 block"
                        disabled={busy}
                        onClick={() =>
                          void run(() =>
                            api("/api/admin/templates", {
                              method: "PATCH",
                              body: {
                                id: r.id,
                                status: d.status,
                                name: d.name,
                                providerTemplateId: d.providerId || null,
                              },
                            }),
                          )
                        }
                      >
                        Save
                      </button>
                    )}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}
