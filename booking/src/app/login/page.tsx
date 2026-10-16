import type { Metadata } from "next";
import { redirect } from "next/navigation";
import { currentPrincipal } from "@/lib/http/session";
import { homeFor } from "@/lib/http/nav";
import { LoginForm } from "./LoginForm";

export const metadata: Metadata = { title: "Staff sign in" };
export const dynamic = "force-dynamic";

export default async function LoginPage() {
  const p = await currentPrincipal();
  if (p) redirect(homeFor(p));
  return (
    <main id="main" className="mx-auto max-w-md px-4 py-10">
      <h1 className="text-2xl font-bold">Staff sign in</h1>
      <LoginForm />
    </main>
  );
}
