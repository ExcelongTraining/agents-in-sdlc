"use client";
import { useRouter } from "next/navigation";
import { api } from "./ui";

export function LogoutButton() {
  const router = useRouter();
  return (
    <button
      className="btn"
      onClick={async () => {
        await api("/api/auth/logout", { method: "POST", body: {} }).catch(() => undefined);
        router.push("/login");
        router.refresh();
      }}
    >
      Sign out
    </button>
  );
}
