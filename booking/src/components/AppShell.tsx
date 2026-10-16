import Link from "next/link";
import type { Principal } from "@/lib/domain/rbac";
import { LogoutButton } from "./LogoutButton";

export interface NavItem {
  href: string;
  label: string;
}

export function AppShell({
  principal,
  title,
  nav,
  children,
}: {
  principal: Principal;
  title: string;
  nav: NavItem[];
  children: React.ReactNode;
}) {
  return (
    <div className="min-h-screen">
      <header className="border-b border-line bg-surface">
        <div className="mx-auto flex max-w-6xl flex-wrap items-center justify-between gap-2 px-4 py-2">
          <p className="font-bold">{title}</p>
          <p className="flex items-center gap-3 text-sm">
            <span>{principal.displayName}</span>
            <LogoutButton />
          </p>
        </div>
        <nav aria-label="Main" className="mx-auto max-w-6xl overflow-x-auto px-4">
          <ul className="flex gap-1 pb-2">
            {nav.map((n) => (
              <li key={n.href}>
                <Link href={n.href} className="btn border-transparent whitespace-nowrap">
                  {n.label}
                </Link>
              </li>
            ))}
          </ul>
        </nav>
      </header>
      <main id="main" className="mx-auto max-w-6xl px-4 py-5">
        {children}
      </main>
    </div>
  );
}
