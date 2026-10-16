import { route } from "@/lib/http/route";
import { businessHoursInput, getBusinessHours, saveBusinessHours } from "@/lib/services/admin";

export const GET = route({ auth: "staff", permission: "services.manage" }, async ({ principal }) => ({
  windows: await getBusinessHours(principal!),
}));
export const PUT = route(
  { auth: "staff", permission: "services.manage", body: businessHoursInput },
  async ({ body, principal }) => {
    await saveBusinessHours(principal!, body);
    return { ok: true };
  },
);
