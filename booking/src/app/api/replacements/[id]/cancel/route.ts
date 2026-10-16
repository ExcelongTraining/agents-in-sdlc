import { route } from "@/lib/http/route";
import { cancelReplacement } from "@/lib/services/replacement";

export const POST = route<undefined, { id: string }>({ auth: "staff" }, async ({ params, principal }) =>
  cancelReplacement(principal!, params.id),
);
