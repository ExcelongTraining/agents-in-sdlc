import { route } from "@/lib/http/route";

export const GET = route({ auth: "staff" }, async ({ principal }) => ({
  displayName: principal!.displayName,
  roles: principal!.roles,
  staffId: principal!.staffId,
}));
