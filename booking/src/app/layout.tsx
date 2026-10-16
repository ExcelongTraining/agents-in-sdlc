import type { Metadata, Viewport } from "next";
import "./globals.css";
import { ServiceWorkerRegistration } from "@/components/ServiceWorkerRegistration";

export const metadata: Metadata = {
  title: {
    default: "Lotus Wellness Centre (demo) — Book a massage",
    template: "%s · Lotus Wellness Centre (demo)",
  },
  description: "Book a massage or consultation online. See real-time availability.",
  manifest: "/manifest.webmanifest",
  robots: { index: false, follow: false }, // demo deployment; remove when going live
  appleWebApp: { capable: true, title: "Lotus Wellness", statusBarStyle: "default" },
};
export const viewport: Viewport = { width: "device-width", initialScale: 1, themeColor: "#0f6b62" };

export default function RootLayout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>
        <a href="#main" className="sr-only-focusable btn btn-primary left-2 top-2 z-50">
          Skip to main content
        </a>
        {children}
        <ServiceWorkerRegistration />
      </body>
    </html>
  );
}
