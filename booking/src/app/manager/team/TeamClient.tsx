"use client";
import { useState } from "react";
import { Alert, Check, SelectField, TextField, api } from "@/components/ui";
import { useAction } from "@/components/actions";

interface U {
  id: string;
  name: string;
  email: string;
  status: string;
  roles: string[];
  staffId: string | null;
  lastLogin: string | null;
}
interface P {
  id: string;
  active: boolean;
  can_take_direct_bookings: boolean;
  kpi_reminders_enabled: boolean;
  fairness_weight: number;
  max_consecutive_minutes: number | null;
  phone_e164: string | null;
}

export function TeamClient({
  users,
  profiles,
  currentUserId,
}: {
  users: U[];
  profiles: P[];
  currentUserId: string;
}) {
  const { error, busy, run } = useAction();
  const [f, setF] = useState({ displayName: "", email: "", role: "masseuse", phone: "", password: "" });
  const [edit, setEdit] = useState<P | null>(null);
  return (
    <div className="space-y-6">
      {error && <Alert kind="error">{error}</Alert>}
      <div className="overflow-x-auto" tabIndex={0} role="region" aria-label="Users (scrollable)">
        <table className="table">
          <caption className="sr-only">Users</caption>
          <thead>
            <tr>
              <th scope="col">Name</th>
              <th scope="col">E-mail</th>
              <th scope="col">Role</th>
              <th scope="col">Status</th>
              <th scope="col">Actions</th>
            </tr>
          </thead>
          <tbody>
            {users.map((u) => (
              <tr key={u.id}>
                <th scope="row" className="font-normal">
                  {u.name}
                </th>
                <td>{u.email}</td>
                <td>{u.roles.join(", ")}</td>
                <td>
                  <span className={`badge ${u.status === "active" ? "badge-ok" : "badge-warn"}`}>
                    {u.status}
                  </span>
                </td>
                <td className="space-x-2">
                  {u.staffId && (
                    <button
                      className="btn"
                      onClick={() => setEdit(profiles.find((p) => p.id === u.staffId) ?? null)}
                    >
                      Staff settings
                    </button>
                  )}
                  {u.id !== currentUserId && (
                    <button
                      className="btn"
                      disabled={busy}
                      onClick={() =>
                        void run(() =>
                          api("/api/admin/users", {
                            method: "PATCH",
                            body: { userId: u.id, status: u.status === "active" ? "disabled" : "active" },
                          }),
                        )
                      }
                    >
                      {u.status === "active" ? "Disable" : "Enable"}
                    </button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {edit && (
        <form
          className="card max-w-xl space-y-3"
          onSubmit={(e) => {
            e.preventDefault();
            void run(async () => {
              await api("/api/admin/users", {
                method: "PATCH",
                body: {
                  staff: {
                    id: edit.id,
                    phone: edit.phone_e164 || null,
                    active: edit.active,
                    canTakeDirectBookings: edit.can_take_direct_bookings,
                    kpiRemindersEnabled: edit.kpi_reminders_enabled,
                    fairnessWeight: edit.fairness_weight,
                    maxConsecutiveMinutes: edit.max_consecutive_minutes,
                  },
                },
              });
              setEdit(null);
            });
          }}
        >
          <h2 className="text-lg font-semibold">Staff settings</h2>
          <TextField
            label="WhatsApp number (E.164, e.g. +60123456789)"
            value={edit.phone_e164 ?? ""}
            onChange={(e) => setEdit({ ...edit, phone_e164: e.target.value })}
          />
          <Check
            checked={edit.active}
            onChange={(e) => setEdit({ ...edit, active: e.target.checked })}
            label="Active (can receive bookings)"
          />
          <Check
            checked={edit.can_take_direct_bookings}
            onChange={(e) => setEdit({ ...edit, can_take_direct_bookings: e.target.checked })}
            label="May record direct bookings"
          />
          <Check
            checked={edit.kpi_reminders_enabled}
            onChange={(e) => setEdit({ ...edit, kpi_reminders_enabled: e.target.checked })}
            label="Send KPI progress reminders"
          />
          <TextField
            label="Fair-allocation weight"
            type="number"
            step="0.1"
            min={0.1}
            max={5}
            hint="1 = normal share. 0.5 receives about half as many 'any available' bookings; 2 about twice as many."
            value={edit.fairness_weight}
            onChange={(e) => setEdit({ ...edit, fairness_weight: Number(e.target.value) })}
          />
          <TextField
            label="Max consecutive minutes (optional)"
            type="number"
            min={30}
            max={720}
            value={edit.max_consecutive_minutes ?? ""}
            onChange={(e) =>
              setEdit({ ...edit, max_consecutive_minutes: e.target.value ? Number(e.target.value) : null })
            }
          />
          <div className="flex gap-2">
            <button className="btn btn-primary" disabled={busy}>
              Save
            </button>
            <button type="button" className="btn" onClick={() => setEdit(null)}>
              Close
            </button>
          </div>
        </form>
      )}

      <form
        className="card max-w-xl space-y-3"
        onSubmit={(e) => {
          e.preventDefault();
          void run(async () => {
            await api("/api/admin/users", { body: f });
            setF({ displayName: "", email: "", role: "masseuse", phone: "", password: "" });
          });
        }}
      >
        <h2 className="text-lg font-semibold">Add a user</h2>
        <TextField
          label="Name"
          required
          value={f.displayName}
          onChange={(e) => setF({ ...f, displayName: e.target.value })}
        />
        <TextField
          label="E-mail"
          type="email"
          required
          value={f.email}
          onChange={(e) => setF({ ...f, email: e.target.value })}
        />
        <SelectField label="Role" value={f.role} onChange={(e) => setF({ ...f, role: e.target.value })}>
          <option value="masseuse">Masseuse</option>
          <option value="manager">Manager</option>
          <option value="administrator">Administrator</option>
        </SelectField>
        <TextField
          label="WhatsApp number (optional)"
          value={f.phone}
          onChange={(e) => setF({ ...f, phone: e.target.value })}
        />
        <TextField
          label="Temporary password"
          type="password"
          required
          minLength={12}
          autoComplete="new-password"
          hint="At least 12 characters. They must change it at first sign-in."
          value={f.password}
          onChange={(e) => setF({ ...f, password: e.target.value })}
        />
        <button className="btn btn-primary" disabled={busy}>
          Create user
        </button>
      </form>
    </div>
  );
}
