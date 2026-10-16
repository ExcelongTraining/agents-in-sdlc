import { AppShell } from "@/components/AppShell";
import { requireRole } from "@/lib/http/guard";

export const dynamic = "force-dynamic";

export default async function StaffLayout({ children }: { children: React.ReactNode }) {
  const p = await requireRole(["masseuse"]);
  return (
    <AppShell
      principal={p}
      title="My schedule"
      nav={[
        { href: "/staff", label: "Today & upcoming" },
        { href: "/staff/new", label: "Record a booking" },
        { href: "/staff/replacements", label: "Replacements" },
        { href: "/staff/availability", label: "My availability" },
        { href: "/staff/kpi", label: "My hours & KPIs" },
      ]}
    >
      {children}
    </AppShell>
  );
}
