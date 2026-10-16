import { cookies } from "next/headers";
import { AppError } from "../errors";
import { accessFromManageToken, accessFromOtpToken, type CustomerAccess } from "../services/customer-access";

export const CUSTOMER_COOKIE = "bk_customer";

/** Customer identity comes from a verified manage-link token or the WhatsApp-OTP cookie, never from request fields. */
export async function resolveCustomerAccess(
  orgId: string,
  manageToken: string | null,
): Promise<CustomerAccess> {
  const access = manageToken
    ? await accessFromManageToken(orgId, manageToken)
    : await accessFromOtpToken(orgId, (await cookies()).get(CUSTOMER_COOKIE)?.value ?? "");
  if (!access) throw new AppError("NOT_FOUND", "This link is not valid or has expired.");
  return access;
}
