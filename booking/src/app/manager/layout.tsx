import { AppShell } from "@/components/AppShell";
import { requireRole } from "@/lib/http/guard";

export const dynamic = "force-dynamic";

export default async function ManagerLayout({ children }: { children: React.ReactNode }) {
  const p = await requireRole(["manager"]);
  return (
    <AppShell
      principal={p}
      title="Manager"
      nav={[
        { href: "/manager", label: "Dashboard" },
        { href: "/manager/calendar", label: "Master schedule" },
        { href: "/manager/new", label: "New booking" },
        { href: "/manager/replacements", label: "Replacements" },
        { href: "/manager/inbox", label: "WhatsApp inbox" },
        { href: "/manager/availability", label: "Availability & leave" },
        { href: "/manager/reports", label: "Reports & KPIs" },
        { href: "/manager/kpi", label: "KPI targets" },
        { href: "/manager/services", label: "Services" },
        { href: "/manager/team", label: "Team" },
        { href: "/manager/settings", label: "Settings" },
        { href: "/manager/templates", label: "WhatsApp templates" },
        { href: "/manager/audit", label: "Audit log" },
        { href: "/manager/privacy", label: "Privacy" },
      ]}
    >
      {children}
    </AppShell>
  );
}
