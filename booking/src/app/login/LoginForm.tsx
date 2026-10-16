"use client";
import { useState } from "react";
import { useRouter } from "next/navigation";
import { Alert, TextField, api, errorMessage } from "@/components/ui";

export function LoginForm() {
  const router = useRouter();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError("");
    try {
      const r = await api<{ user: { roles: string[] } }>("/api/auth/login", { body: { email, password } });
      router.push(
        r.user.roles.includes("manager")
          ? "/manager"
          : r.user.roles.includes("masseuse")
            ? "/staff"
            : "/admin",
      );
      router.refresh();
    } catch (err) {
      setError(errorMessage(err));
      setBusy(false);
    }
  }
  return (
    <form onSubmit={submit} className="card mt-4 space-y-4">
      {error && <Alert kind="error">{error}</Alert>}
      <TextField
        label="E-mail"
        type="email"
        required
        autoComplete="username"
        value={email}
        onChange={(e) => setEmail(e.target.value)}
      />
      <TextField
        label="Password"
        type="password"
        required
        autoComplete="current-password"
        value={password}
        onChange={(e) => setPassword(e.target.value)}
      />
      <button className="btn btn-primary w-full" disabled={busy}>
        {busy ? "Signing in…" : "Sign in"}
      </button>
    </form>
  );
}
