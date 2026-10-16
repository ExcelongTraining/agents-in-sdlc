import { route } from "@/lib/http/route";
import { createException, exceptionSchema, listPendingAvailability } from "@/lib/services/availability-admin";

export const POST = route({ auth: "staff", body: exceptionSchema }, async ({ body, principal }) =>
  createException(principal!, body),
);
export const GET = route({ auth: "staff", permission: "availability.approve" }, async ({ principal }) =>
  listPendingAvailability(principal!),
);
