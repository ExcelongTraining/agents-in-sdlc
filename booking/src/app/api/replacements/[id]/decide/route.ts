import { z } from "zod";
import { route } from "@/lib/http/route";
import { decideAsManager } from "@/lib/services/replacement";

export const POST = route<{ approve: boolean; note?: string }, { id: string }>(
  { auth: "staff", body: z.object({ approve: z.boolean(), note: z.string().max(300).optional() }) },
  async ({ params, body, principal }) => decideAsManager(principal!, params.id, body.approve, body.note),
);
