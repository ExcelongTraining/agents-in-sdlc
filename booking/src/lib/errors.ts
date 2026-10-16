/** Structured application errors. `message` is always safe to show to end users; `internal` never leaves the server. */
export type ErrorCode =
  | "VALIDATION"
  | "UNAUTHENTICATED"
  | "FORBIDDEN"
  | "NOT_FOUND"
  | "SLOT_TAKEN"
  | "ROOM_TAKEN"
  | "NOT_QUALIFIED"
  | "OUTSIDE_WORKING_HOURS"
  | "OUTSIDE_BUSINESS_HOURS"
  | "STAFF_UNAVAILABLE"
  | "LEAVE_CONFLICTS_WITH_BOOKING"
  | "INVALID_TRANSITION"
  | "OVERRIDE_REASON_REQUIRED"
  | "HOLD_EXPIRED"
  | "MIN_NOTICE"
  | "MAX_ADVANCE"
  | "CANCELLATION_WINDOW"
  | "IDEMPOTENCY_CONFLICT"
  | "RATE_LIMITED"
  | "VERSION_CONFLICT"
  | "NOT_ALLOWED"
  | "PROVIDER_ERROR"
  | "INTERNAL";

const HTTP_STATUS: Record<ErrorCode, number> = {
  VALIDATION: 400,
  UNAUTHENTICATED: 401,
  FORBIDDEN: 403,
  NOT_FOUND: 404,
  SLOT_TAKEN: 409,
  ROOM_TAKEN: 409,
  NOT_QUALIFIED: 422,
  OUTSIDE_WORKING_HOURS: 422,
  OUTSIDE_BUSINESS_HOURS: 422,
  STAFF_UNAVAILABLE: 409,
  LEAVE_CONFLICTS_WITH_BOOKING: 409,
  INVALID_TRANSITION: 409,
  OVERRIDE_REASON_REQUIRED: 422,
  HOLD_EXPIRED: 410,
  MIN_NOTICE: 422,
  MAX_ADVANCE: 422,
  CANCELLATION_WINDOW: 422,
  IDEMPOTENCY_CONFLICT: 422,
  RATE_LIMITED: 429,
  VERSION_CONFLICT: 409,
  NOT_ALLOWED: 409,
  PROVIDER_ERROR: 502,
  INTERNAL: 500,
};

export class AppError extends Error {
  readonly code: ErrorCode;
  readonly status: number;
  readonly details?: Record<string, unknown>;
  readonly internal?: string;

  constructor(code: ErrorCode, message: string, opts: { details?: Record<string, unknown>; internal?: string; cause?: unknown } = {}) {
    super(message, { cause: opts.cause });
    this.name = "AppError";
    this.code = code;
    this.status = HTTP_STATUS[code];
    this.details = opts.details;
    this.internal = opts.internal;
  }
}

export const isAppError = (e: unknown): e is AppError => e instanceof AppError;
