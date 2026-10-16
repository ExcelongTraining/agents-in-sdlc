import { z } from "zod";
import { route } from "@/lib/http/route";
import { respondAsNominee } from "@/lib/services/replacement";

export const POST = route<{ accept: boolean; comment?: string }, { id: string }>(
  { auth: "staff", body: z.object({ accept: z.boolean(), comment: z.string().max(300).optional() }) },
  async ({ params, body, principal }) => respondAsNominee(principal!, params.id, body.accept, body.comment),
);
