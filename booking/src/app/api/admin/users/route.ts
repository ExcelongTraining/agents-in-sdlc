import { z } from "zod";
import { route } from "@/lib/http/route";
import {
  createUser,
  listUsers,
  setUserStatus,
  updateStaffProfile,
  staffInput,
  userInput,
} from "@/lib/services/admin";

export const GET = route({ auth: "staff", permission: "users.manage" }, async ({ principal }) => ({
  items: await listUsers(principal!),
}));
export const POST = route(
  { auth: "staff", permission: "users.manage", body: userInput },
  async ({ body, principal }) => createUser(principal!, body),
);
export const PATCH = route(
  {
    auth: "staff",
    body: z.object({
      userId: z.uuid().optional(),
      status: z.enum(["active", "disabled"]).optional(),
      staff: staffInput.optional(),
    }),
  },
  async ({ body, principal }) => {
    if (body.userId && body.status) await setUserStatus(principal!, body.userId, body.status);
    if (body.staff) await updateStaffProfile(principal!, body.staff);
    return { ok: true };
  },
);
