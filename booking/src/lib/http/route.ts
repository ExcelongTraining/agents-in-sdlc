import { NextResponse, type NextRequest } from "next/server";
import { createHash, randomUUID } from "node:crypto";
import { ZodError, type ZodType } from "zod";
import { AppError, isAppError } from "../errors";
import { env } from "../config/env";
import { log } from "../log";
import { can, type Permission, type Principal } from "../domain/rbac";
import { currentPrincipal } from "./session";
import { withTx } from "../db/tx";
import { rateLimit } from "../services/rate-limit";
import { getOrgId } from "../services/org";

export interface RouteCtx<P extends Record<string, string> = Record<string, string>> {
  req: NextRequest;
  params: P;
  principal: Principal | null;
  orgId: string;
  ip: string;
  requestId: string;
}

interface Options<B> {
  /** staff: needs a session (and optionally a permission). public: no login, but rate limited. */
  auth: "staff" | "public";
  permission?: Permission;
  body?: ZodType<B>;
  rate?: { name: string; limit: number; windowSeconds: number };
}

/** Client IP for rate limiting only; hashed so no raw address is stored. */
export function clientIp(req: NextRequest): string {
  const raw =
    req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() ?? req.headers.get("x-real-ip") ?? "unknown";
  return createHash("sha256").update(raw).digest("hex").slice(0, 16);
}

/** CSRF defence in depth (cookies are also SameSite=Lax): state-changing requests must come from our own origin. */
export function assertSameOrigin(req: NextRequest): void {
  if (["GET", "HEAD", "OPTIONS"].includes(req.method)) return;
  const origin = req.headers.get("origin");
  const site = req.headers.get("sec-fetch-site");
  const allowed = new URL(env().APP_BASE_URL).host;
  if (origin) {
    if (new URL(origin).host === allowed || new URL(origin).host === req.headers.get("host")) return;
  } else if (site === "same-origin" || site === "none" || (!site && env().NODE_ENV !== "production")) return;
  throw new AppError("FORBIDDEN", "Cross-site requests are not allowed.", {
    internal: `origin=${origin} site=${site}`,
  });
}

export function toResponse(e: unknown, requestId: string): NextResponse {
  if (e instanceof ZodError) {
    const issues = e.issues.map((i) => ({ path: i.path.join("."), message: i.message }));
    return NextResponse.json(
      { error: { code: "VALIDATION", message: issues[0]?.message ?? "Invalid input.", issues, requestId } },
      { status: 400 },
    );
  }
  if (isAppError(e)) {
    if (e.status >= 500 || e.internal)
      log(e.status >= 500 ? "error" : "warn", "app_error", { code: e.code, internal: e.internal, requestId });
    return NextResponse.json(
      { error: { code: e.code, message: e.message, details: e.details, requestId } },
      { status: e.status },
    );
  }
  // Unknown errors: log details server-side, return nothing internal to the client.
  log("error", "unhandled_error", {
    message: (e as Error)?.message,
    stack: (e as Error)?.stack?.split("\n").slice(0, 4).join(" | "),
    requestId,
  });
  return NextResponse.json(
    { error: { code: "INTERNAL", message: "Something went wrong. Please try again.", requestId } },
    { status: 500 },
  );
}

export function route<B = undefined, P extends Record<string, string> = Record<string, string>>(
  opts: Options<B>,
  fn: (ctx: RouteCtx<P> & { body: B }) => Promise<unknown>,
) {
  return async (req: NextRequest, segment: { params: Promise<P> }): Promise<NextResponse> => {
    const requestId = randomUUID();
    try {
      assertSameOrigin(req);
      const orgId = await getOrgId();
      const ip = clientIp(req);
      let principal: Principal | null = null;
      if (opts.auth === "staff") {
        principal = await currentPrincipal();
        if (!principal) throw new AppError("UNAUTHENTICATED", "Please sign in.");
        if (opts.permission && !can(principal, opts.permission))
          throw new AppError("FORBIDDEN", "You do not have permission to do that.", {
            internal: `needs ${opts.permission}`,
          });
      }
      if (opts.rate) {
        const r = opts.rate;
        await withTx({ kind: "system", orgId }, (tx) =>
          rateLimit(tx, `${r.name}:${principal?.userId ?? ip}`, r.limit, r.windowSeconds),
        );
      }
      let body = undefined as B;
      if (opts.body) {
        const text = await req.text();
        if (text.length > 100_000) throw new AppError("VALIDATION", "Request is too large.");
        body = opts.body.parse(text ? JSON.parse(text) : {});
      }
      const result = await fn({ req, params: await segment.params, principal, orgId, ip, requestId, body });
      if (result instanceof NextResponse) return result;
      return NextResponse.json(result ?? { ok: true }, { headers: { "Cache-Control": "no-store" } });
    } catch (e) {
      if (e instanceof SyntaxError) return toResponse(new AppError("VALIDATION", "Invalid JSON."), requestId);
      return toResponse(e, requestId);
    }
  };
}
