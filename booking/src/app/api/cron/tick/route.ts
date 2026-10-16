import { timingSafeEqual } from "node:crypto";
import { NextResponse, type NextRequest } from "next/server";
import { env } from "@/lib/config/env";
import { toResponse } from "@/lib/http/route";
import { AppError } from "@/lib/errors";
import { getOrgId } from "@/lib/services/org";
import { runScheduledJobs } from "@/lib/services/jobs";

export const dynamic = "force-dynamic";
export const maxDuration = 60;

function authorised(req: NextRequest): boolean {
  const secret = env().CRON_SECRET;
  const given = req.headers.get("authorization")?.replace(/^Bearer /, "") ?? "";
  if (!secret || given.length !== secret.length) return false;
  return timingSafeEqual(Buffer.from(given), Buffer.from(secret));
}

/** Called every minute by the scheduler (Vercel Cron sends Authorization: Bearer $CRON_SECRET). Retention runs once a day at ~03:00 KL. */
async function tick(req: NextRequest): Promise<NextResponse> {
  try {
    if (!authorised(req)) throw new AppError("FORBIDDEN", "Not authorised.");
    const hourKL = (new Date().getUTCHours() + 8) % 24;
    const minute = new Date().getUTCMinutes();
    const report = await runScheduledJobs(await getOrgId(), { runRetention: hourKL === 3 && minute < 5 });
    return NextResponse.json({ ok: true, ...report });
  } catch (e) {
    return toResponse(e, "cron");
  }
}
export const GET = tick;
export const POST = tick;
