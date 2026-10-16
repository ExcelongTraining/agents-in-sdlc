import { z } from "zod";
import { cookies } from "next/headers";
import { route } from "@/lib/http/route";
import { changeOwnPassword, SESSION_COOKIE } from "@/lib/services/auth";

export const POST = route(
  { auth: "staff", body: z.object({ current: z.string().max(128), next: z.string().max(128) }) },
  async ({ body, principal }) => {
    await changeOwnPassword(
      principal!,
      body.current,
      body.next,
      (await cookies()).get(SESSION_COOKIE)?.value,
    );
    return { ok: true };
  },
);
