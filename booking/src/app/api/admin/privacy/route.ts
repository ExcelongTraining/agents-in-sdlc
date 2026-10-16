import { z } from "zod";
import { route } from "@/lib/http/route";
import {
  anonymiseCustomer,
  exportCustomerData,
  logDataRequest,
  dataRequestSchema,
} from "@/lib/services/privacy";

export const POST = route(
  {
    auth: "staff",
    permission: "privacy.manage",
    body: z.discriminatedUnion("action", [
      z.object({ action: z.literal("export"), customerId: z.uuid() }),
      z.object({ action: z.literal("anonymise"), customerId: z.uuid(), reason: z.string().min(5).max(300) }),
      z.object({ action: z.literal("log"), request: dataRequestSchema }),
    ]),
  },
  async ({ body, principal }) => {
    if (body.action === "export") return exportCustomerData(principal!, body.customerId);
    if (body.action === "anonymise") {
      await anonymiseCustomer(principal!, body.customerId, body.reason);
      return { ok: true };
    }
    return logDataRequest(principal!, body.request);
  },
);
