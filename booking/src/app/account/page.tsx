import type { Metadata } from "next";
import { requireRole } from "@/lib/http/guard";
import { PasswordForm } from "./PasswordForm";

export const metadata: Metadata = { title: "Account" };
export const dynamic = "force-dynamic";

export default async function Account() {
  const p = await requireRole(["masseuse", "manager", "administrator"], { allowPasswordChange: true });
  return (
    <main id="main" className="mx-auto max-w-md px-4 py-10">
      <h1 className="text-2xl font-bold">Change password</h1>
      {p.mustChangePassword && (
        <p className="alert alert-warn mt-3">Please choose your own password before continuing.</p>
      )}
      <PasswordForm />
    </main>
  );
}
