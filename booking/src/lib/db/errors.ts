import { AppError } from "../errors";

interface PgError extends Error {
  code?: string;
  constraint?: string;
  table?: string;
}

/** Translate PostgreSQL errors (including our BKxxx codes from triggers) to structured AppErrors. */
export function mapDbError(err: unknown): unknown {
  const e = err as PgError;
  if (!e || typeof e !== "object" || typeof e.code !== "string") return err;
  switch (e.code) {
    case "23P01":
      if (e.constraint === "appointments_room_no_overlap")
        return new AppError("ROOM_TAKEN", "That room is already booked at this time.", { cause: err });
      return new AppError("SLOT_TAKEN", "That time has just been taken. Please choose another time.", {
        cause: err,
      });
    case "BK001":
      return new AppError("NOT_QUALIFIED", "That masseuse is not qualified for this service.", {
        cause: err,
      });
    case "BK002":
      return new AppError("OUTSIDE_WORKING_HOURS", "That time is outside the masseuse's working hours.", {
        cause: err,
      });
    case "BK003":
      return new AppError("STAFF_UNAVAILABLE", "That masseuse is unavailable at this time.", { cause: err });
    case "BK004":
      return new AppError("OUTSIDE_BUSINESS_HOURS", "That time is outside business hours.", { cause: err });
    case "BK005":
      return new AppError("INVALID_TRANSITION", "That status change is not allowed.", {
        cause: err,
        internal: e.message,
      });
    case "BK006":
      return new AppError("NOT_ALLOWED", "That field cannot be changed.", {
        cause: err,
        internal: e.message,
      });
    case "BK007":
      return new AppError(
        "LEAVE_CONFLICTS_WITH_BOOKING",
        "Existing bookings overlap this period. Reassign or cancel them first.",
        { cause: err },
      );
    case "BK008":
      return new AppError("OVERRIDE_REASON_REQUIRED", "An override needs a written reason.", { cause: err });
    case "23505":
      return new AppError("NOT_ALLOWED", "That record already exists.", {
        cause: err,
        internal: e.constraint,
      });
    case "23503":
      return new AppError("VALIDATION", "A referenced record does not exist.", {
        cause: err,
        internal: e.constraint,
      });
    case "23514":
    case "22P02":
    case "22007":
      return new AppError("VALIDATION", "Some of the submitted values are not valid.", {
        cause: err,
        internal: e.constraint ?? e.message,
      });
    case "42501":
      return new AppError("FORBIDDEN", "You do not have permission to do that.", { cause: err });
    default:
      return err;
  }
}

export const isRetryableDbError = (err: unknown): boolean => {
  const code = (err as PgError | undefined)?.code;
  return code === "40001" || code === "40P01";
};

/** True when a booking attempt failed in a way that trying another staff member/room could fix. */
export const isCandidateConflict = (err: unknown): boolean => {
  const code = (err as PgError | undefined)?.code;
  return code === "23P01" || code === "BK001" || code === "BK002" || code === "BK003" || code === "BK004";
};
