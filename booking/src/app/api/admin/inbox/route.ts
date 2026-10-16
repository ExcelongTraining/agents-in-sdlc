import { z } from "zod";
import { route } from "@/lib/http/route";
import { replyToConversation, resolveHandoff } from "@/lib/services/whatsapp-inbox";

export const POST = route(
  {
    auth: "staff",
    permission: "customers.read",
    body: z.discriminatedUnion("action", [
      z.object({ action: z.literal("reply"), conversationId: z.uuid(), text: z.string().max(1000) }),
      z.object({ action: z.literal("resolve"), conversationId: z.uuid() }),
    ]),
  },
  async ({ body, principal }) => {
    if (body.action === "reply") await replyToConversation(principal!, body.conversationId, body.text);
    else await resolveHandoff(principal!, body.conversationId);
    return { ok: true };
  },
);
