import { route } from "@/lib/http/route";
import { requestReplacement, requestSchema } from "@/lib/services/replacement";
import { listMyReplacements } from "@/lib/services/schedule";

export const POST = route({ auth: "staff", body: requestSchema }, async ({ body, principal }) =>
  requestReplacement(principal!, body),
);
export const GET = route({ auth: "staff" }, async ({ principal }) => ({
  items: await listMyReplacements(principal!),
}));
