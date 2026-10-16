import { AppShell } from "@/components/AppShell";
import { requireRole } from "@/lib/http/guard";

export const dynamic = "force-dynamic";

export default async function AdminLayout({ children }: { children: React.ReactNode }) {
  const p = await requireRole(["administrator"]);
  return (
    <AppShell
      principal={p}
      title="Administrator"
      nav={[
        { href: "/admin", label: "Integrations" },
        { href: "/admin/templates", label: "WhatsApp templates" },
        { href: "/admin/audit", label: "Audit log" },
      ]}
    >
      {children}
    </AppShell>
  );
}
