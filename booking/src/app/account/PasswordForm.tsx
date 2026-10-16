"use client";
import { useState } from "react";
import { useRouter } from "next/navigation";
import { Alert, TextField, api, errorMessage } from "@/components/ui";

export function PasswordForm() {
  const router = useRouter();
  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const [error, setError] = useState("");
  const [ok, setOk] = useState(false);
  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setError("");
    setOk(false);
    try {
      await api("/api/auth/password", { body: { current, next } });
      setOk(true);
      router.refresh();
      setTimeout(() => router.push("/"), 800);
    } catch (err) {
      setError(errorMessage(err));
    }
  }
  return (
    <form onSubmit={submit} className="card mt-4 space-y-4">
      {error && <Alert kind="error">{error}</Alert>}
      {ok && <Alert kind="ok">Password changed.</Alert>}
      <TextField
        label="Current password"
        type="password"
        required
        autoComplete="current-password"
        value={current}
        onChange={(e) => setCurrent(e.target.value)}
      />
      <TextField
        label="New password"
        type="password"
        required
        autoComplete="new-password"
        minLength={12}
        hint="At least 12 characters. A few random words work well."
        value={next}
        onChange={(e) => setNext(e.target.value)}
      />
      <button className="btn btn-primary">Change password</button>
    </form>
  );
}
