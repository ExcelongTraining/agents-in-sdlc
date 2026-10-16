import { route } from "@/lib/http/route";
import { acknowledgeAssignments } from "@/lib/services/schedule";

export const POST = route({ auth: "staff" }, async ({ principal }) => ({
  acknowledged: await acknowledgeAssignments(principal!),
}));
