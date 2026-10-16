import { NextResponse, type NextRequest } from "next/server";
import { toResponse } from "@/lib/http/route";
import { receiveWhatsAppWebhook, verifyWebhookHandshake } from "@/lib/services/whatsapp-webhook";

export const dynamic = "force-dynamic";

/** Meta verification handshake: echo hub.challenge as plain text. */
export async function GET(req: NextRequest): Promise<NextResponse> {
  const sp = new URL(req.url).searchParams;
  try {
    const challenge = verifyWebhookHandshake({
      mode: sp.get("hub.mode"),
      token: sp.get("hub.verify_token"),
      challenge: sp.get("hub.challenge"),
    });
    return new NextResponse(challenge, { status: 200, headers: { "Content-Type": "text/plain" } });
  } catch (e) {
    return toResponse(e, "webhook-verify");
  }
}

/** Deliveries: verify X-Hub-Signature-256 over the RAW body, store idempotently, process, always answer fast. */
export async function POST(req: NextRequest): Promise<NextResponse> {
  const raw = await req.text();
  try {
    const r = await receiveWhatsAppWebhook(raw, req.headers.get("x-hub-signature-256"));
    return NextResponse.json({ ok: true, ...r });
  } catch (e) {
    return toResponse(e, "webhook");
  }
}
