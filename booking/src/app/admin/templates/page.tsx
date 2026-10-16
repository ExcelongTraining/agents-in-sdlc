import type { Metadata } from "next";
import { requireRole } from "@/lib/http/guard";
import { listTemplates } from "@/lib/services/admin";
import { TemplatesClient } from "./TemplatesClient";

export const metadata: Metadata = { title: "WhatsApp templates" };
export const dynamic = "force-dynamic";

export default async function Templates() {
  const p = await requireRole(["administrator", "manager"]);
  const rows = await listTemplates(p);
  return (
    <div className="space-y-3">
      <h1 className="text-2xl font-bold">WhatsApp message templates</h1>
      <p className="text-sm text-muted">
        Templates must be created and approved in Meta Business Manager. Record the registered name, language
        and status here. Only <strong>approved</strong> templates are used for business-initiated messages.
      </p>
      <TemplatesClient
        canEdit={p.roles.includes("administrator")}
        rows={rows.map((r) => ({
          id: r.id,
          purpose: r.purpose,
          name: r.name,
          language: r.language,
          category: r.category,
          status: r.status,
          providerId: r.provider_template_id ?? "",
          body: r.body_preview,
        }))}
      />
    </div>
  );
}
