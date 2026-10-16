import { route } from "@/lib/http/route";
import { withTx } from "@/lib/db/tx";
import { staffCtx } from "@/lib/services/schedule";

/** Manager-only customer lookup (RLS enforces; administrators get nothing). */
export const GET = route({ auth: "staff", permission: "customers.read" }, async ({ req, principal }) => {
  const term = (new URL(req.url).searchParams.get("q") ?? "").trim();
  if (term.length < 2) return { items: [] };
  return {
    items: await withTx(staffCtx(principal!), (tx) =>
      tx.query(
        "select id, display_name, phone_e164, source, created_at from customers where anonymised_at is null and (display_name ilike $1 or phone_e164 like $2) order by display_name limit 25",
        [`%${term}%`, `%${term.replace(/\D/g, "")}%`],
      ),
    ),
  };
});
