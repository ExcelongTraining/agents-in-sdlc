/**
 * Normalise Malaysian (and international) phone input to E.164.
 * Accepts "012-345 6789", "0123456789", "60123456789", "+60 12-345 6789". Returns null if not plausible.
 * Default country is Malaysia (+60); numbers already carrying another country code are kept as given.
 */
export function normalisePhone(input: string, defaultCountry = "60"): string | null {
  let s = input.trim().replace(/[\s\-().]/g, "");
  if (!/^\+?\d+$/.test(s)) return null;
  if (s.startsWith("+")) {
    s = s.slice(1);
  } else if (s.startsWith("00")) {
    s = s.slice(2);
  } else if (s.startsWith("0")) {
    s = defaultCountry + s.slice(1);
  } else if (!s.startsWith(defaultCountry)) {
    return null; // ambiguous without a leading 0 or country code
  }
  if (!/^[1-9]\d{7,14}$/.test(s)) return null;
  if (s.startsWith("60") && (s.length < 10 || s.length > 12)) return null; // MY numbers: 60 + 8..10 digits
  return "+" + s;
}

/** For logs and UI where the full number must not appear: +60•••••6789. */
export function maskPhone(e164: string | null | undefined): string {
  if (!e164) return "";
  const digits = e164.replace(/\D/g, "");
  if (digits.length <= 6) return "•".repeat(digits.length);
  return `+${digits.slice(0, 2)}${"•".repeat(digits.length - 6)}${digits.slice(-4)}`;
}

/** WhatsApp ids are phone digits without "+". */
export const waIdToE164 = (waId: string): string => "+" + waId.replace(/\D/g, "");
export const e164ToWaId = (e164: string): string => e164.replace(/\D/g, "");

/** Mask anything that looks like a phone number inside free text (error messages, payload snippets). */
export function maskPhonesInText(text: string): string {
  return text.replace(/\+?\d[\d\s\-()]{7,}\d/g, (m) => maskPhone(m.replace(/[^\d+]/g, "").replace(/^(?!\+)/, "+")));
}
