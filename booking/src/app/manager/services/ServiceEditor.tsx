"use client";
import { useState } from "react";
import { Alert, Check, SelectField, TextField, api } from "@/components/ui";
import { useAction } from "@/components/actions";

interface Svc {
  id?: string;
  name: string;
  description: string;
  kind: string;
  durationMinutes: number;
  bufferBeforeMinutes: number;
  bufferAfterMinutes: number;
  priceMyr: number | null;
  showPrice: boolean;
  onlineBookable: boolean;
  countsTowardKpi: boolean;
  requiresRoom: boolean;
  active: boolean;
  staffIds: string[];
}
const blank: Svc = {
  name: "",
  description: "",
  kind: "service",
  durationMinutes: 60,
  bufferBeforeMinutes: 0,
  bufferAfterMinutes: 10,
  priceMyr: null,
  showPrice: false,
  onlineBookable: true,
  countsTowardKpi: true,
  requiresRoom: false,
  active: true,
  staffIds: [],
};

export function ServiceEditor({
  services,
  staff,
}: {
  services: Svc[];
  staff: { id: string; name: string }[];
}) {
  const [edit, setEdit] = useState<Svc | null>(null);
  const { error, busy, run } = useAction();
  return (
    <div className="space-y-4">
      <button className="btn btn-primary" onClick={() => setEdit({ ...blank })}>
        Add a service
      </button>
      <ul className="grid gap-2 sm:grid-cols-2">
        {services.map((s) => (
          <li key={s.id} className="card flex items-start justify-between gap-2">
            <div>
              <p className="font-semibold">
                {s.name} {!s.active && <span className="badge badge-warn">inactive</span>}
              </p>
              <p className="text-sm text-muted">
                {s.kind} · {s.durationMinutes} min + {s.bufferAfterMinutes} min cleanup
                {s.priceMyr ? ` · RM${s.priceMyr}` : ""} · {s.staffIds.length} qualified
              </p>
            </div>
            <button className="btn" onClick={() => setEdit(s)} aria-label={`Edit ${s.name}`}>
              Edit
            </button>
          </li>
        ))}
      </ul>
      {edit && (
        <form
          className="card max-w-2xl space-y-3"
          onSubmit={(e) => {
            e.preventDefault();
            void run(async () => {
              await api("/api/admin/services", { body: edit });
              setEdit(null);
            });
          }}
        >
          <h2 className="text-lg font-semibold">{edit.id ? "Edit service" : "New service"}</h2>
          {error && <Alert kind="error">{error}</Alert>}
          <TextField
            label="Name"
            required
            value={edit.name}
            onChange={(e) => setEdit({ ...edit, name: e.target.value })}
          />
          <TextField
            label="Description"
            value={edit.description}
            onChange={(e) => setEdit({ ...edit, description: e.target.value })}
          />
          <div className="grid gap-3 sm:grid-cols-4">
            <SelectField
              label="Type"
              value={edit.kind}
              onChange={(e) => setEdit({ ...edit, kind: e.target.value })}
            >
              <option value="service">Service</option>
              <option value="trial">First-time trial</option>
              <option value="consultation">Consultation</option>
            </SelectField>
            <TextField
              label="Duration (min)"
              type="number"
              min={5}
              max={600}
              required
              value={edit.durationMinutes}
              onChange={(e) => setEdit({ ...edit, durationMinutes: Number(e.target.value) })}
            />
            <TextField
              label="Prep before (min)"
              type="number"
              min={0}
              max={120}
              value={edit.bufferBeforeMinutes}
              onChange={(e) => setEdit({ ...edit, bufferBeforeMinutes: Number(e.target.value) })}
            />
            <TextField
              label="Cleanup after (min)"
              type="number"
              min={0}
              max={120}
              value={edit.bufferAfterMinutes}
              onChange={(e) => setEdit({ ...edit, bufferAfterMinutes: Number(e.target.value) })}
            />
          </div>
          <TextField
            label="Price (RM, optional)"
            type="number"
            min={0}
            step="0.01"
            value={edit.priceMyr ?? ""}
            onChange={(e) =>
              setEdit({ ...edit, priceMyr: e.target.value === "" ? null : Number(e.target.value) })
            }
          />
          <div className="grid gap-2 sm:grid-cols-2">
            <Check
              checked={edit.showPrice}
              onChange={(e) => setEdit({ ...edit, showPrice: e.target.checked })}
              label="Show price to customers"
            />
            <Check
              checked={edit.onlineBookable}
              onChange={(e) => setEdit({ ...edit, onlineBookable: e.target.checked })}
              label="Customers can book online"
            />
            <Check
              checked={edit.countsTowardKpi}
              onChange={(e) => setEdit({ ...edit, countsTowardKpi: e.target.checked })}
              label="Counts towards KPI hours"
            />
            <Check
              checked={edit.requiresRoom}
              onChange={(e) => setEdit({ ...edit, requiresRoom: e.target.checked })}
              label="Needs a room"
            />
            <Check
              checked={edit.active}
              onChange={(e) => setEdit({ ...edit, active: e.target.checked })}
              label="Active"
            />
          </div>
          <fieldset>
            <legend className="label">Qualified masseuses</legend>
            <div className="flex flex-wrap gap-4">
              {staff.map((s) => (
                <Check
                  key={s.id}
                  checked={edit.staffIds.includes(s.id)}
                  onChange={(e) =>
                    setEdit({
                      ...edit,
                      staffIds: e.target.checked
                        ? [...edit.staffIds, s.id]
                        : edit.staffIds.filter((x) => x !== s.id),
                    })
                  }
                  label={s.name}
                />
              ))}
            </div>
          </fieldset>
          <div className="flex gap-2">
            <button className="btn btn-primary" disabled={busy}>
              Save
            </button>
            <button type="button" className="btn" onClick={() => setEdit(null)}>
              Cancel
            </button>
          </div>
        </form>
      )}
    </div>
  );
}
