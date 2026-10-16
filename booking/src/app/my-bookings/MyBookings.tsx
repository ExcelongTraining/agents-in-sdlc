"use client";
import { useState } from "react";
import { Alert, TextField, api, errorMessage } from "@/components/ui";
import { BookingList } from "../manage/[token]/ManageClient";

export function MyBookings() {
  const [phone, setPhone] = useState("");
  const [code, setCode] = useState("");
  const [stage, setStage] = useState<"phone" | "code" | "in">("phone");
  const [msg, setMsg] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  async function request(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError("");
    try {
      const r = await api<{ message: string }>("/api/public/otp/request", { body: { phone } });
      setMsg(r.message);
      setStage("code");
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }
  async function verify(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError("");
    try {
      await api("/api/public/otp/verify", { body: { phone, code } });
      setStage("in");
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  if (stage === "in") return <BookingList token={null} />;
  return (
    <div className="mt-4 space-y-4">
      {error && <Alert kind="error">{error}</Alert>}
      {stage === "phone" ? (
        <form onSubmit={request} className="card space-y-4">
          <p>Enter the mobile number you booked with. We will send a 6-digit code on WhatsApp.</p>
          <TextField
            label="Mobile number"
            type="tel"
            required
            autoComplete="tel"
            inputMode="tel"
            value={phone}
            onChange={(e) => setPhone(e.target.value)}
          />
          <button className="btn btn-primary" disabled={busy}>
            Send code
          </button>
        </form>
      ) : (
        <form onSubmit={verify} className="card space-y-4">
          {msg && <Alert kind="info">{msg}</Alert>}
          <TextField
            label="6-digit code"
            required
            inputMode="numeric"
            autoComplete="one-time-code"
            pattern="\d{6}"
            maxLength={6}
            value={code}
            onChange={(e) => setCode(e.target.value)}
          />
          <div className="flex gap-2">
            <button type="button" className="btn" onClick={() => setStage("phone")}>
              Back
            </button>
            <button className="btn btn-primary" disabled={busy}>
              View my bookings
            </button>
          </div>
        </form>
      )}
    </div>
  );
}
