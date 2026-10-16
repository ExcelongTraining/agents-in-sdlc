import { route } from "@/lib/http/route";
import { listServices, saveService, serviceInput } from "@/lib/services/admin";

export const GET = route({ auth: "staff" }, async ({ principal }) => ({
  items: await listServices(principal!),
}));
export const POST = route(
  { auth: "staff", permission: "services.manage", body: serviceInput },
  async ({ body, principal }) => saveService(principal!, body),
);
