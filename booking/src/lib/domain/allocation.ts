/**
 * Fair allocation for "any available masseuse".
 *
 * Transparent, deterministic and testable. Inputs are operational facts only (qualification and availability are
 * decided before this function; candidates passed in are already eligible). Personal characteristics of staff or
 * customers (gender, age, ethnicity, ...) are never inputs.
 *
 * Ranking, in order:
 *   0. Hard filter: drop anyone whose back-to-back chain (including this booking) would exceed maxConsecutiveMinutes.
 *   1. Optional customer preference (returning customer's preferred masseuse), if enabled and eligible.
 *   2. Lowest weighted load      = allocatedMinutes / fairnessWeight   (fewer hours so far in the window go first)
 *   3. Least recently assigned    (never assigned first)
 *   4. staffId ascending          (stable tie-break; no randomness so decisions can be reproduced)
 */
export interface AllocationCandidate {
  staffId: string;
  /** Scheduled+completed minutes in the allocation window (cancelled excluded). */
  allocatedMinutes: number;
  fairnessWeight: number;
  lastAssignedAt: Date | null;
  /** Minutes of contiguous work immediately before/after the proposed slot (gap <= tolerance). */
  adjacentChainMinutes: number;
  maxConsecutiveMinutes: number | null;
}

export interface AllocationOptions {
  serviceMinutes: number;
  preferredStaffId?: string | null;
  /** Default max chain when the staff profile has none. */
  defaultMaxConsecutiveMinutes?: number | null;
}

export interface RankedCandidate {
  staffId: string;
  rank: number;
  weightedLoad: number;
  reason: string;
}

export function rankCandidates(cands: AllocationCandidate[], opts: AllocationOptions): RankedCandidate[] {
  const eligible = cands.filter((c) => {
    const limit = c.maxConsecutiveMinutes ?? opts.defaultMaxConsecutiveMinutes ?? null;
    return limit === null || c.adjacentChainMinutes + opts.serviceMinutes <= limit;
  });
  const scored = eligible.map((c) => ({ c, load: c.allocatedMinutes / c.fairnessWeight }));
  scored.sort((a, b) => {
    const ap = a.c.staffId === opts.preferredStaffId ? 0 : 1;
    const bp = b.c.staffId === opts.preferredStaffId ? 0 : 1;
    if (ap !== bp) return ap - bp;
    if (a.load !== b.load) return a.load - b.load;
    const at = a.c.lastAssignedAt?.getTime() ?? -Infinity;
    const bt = b.c.lastAssignedAt?.getTime() ?? -Infinity;
    if (at !== bt) return at - bt;
    return a.c.staffId.localeCompare(b.c.staffId);
  });
  return scored.map(({ c, load }, i) => ({
    staffId: c.staffId,
    rank: i + 1,
    weightedLoad: Math.round(load * 10) / 10,
    reason:
      (c.staffId === opts.preferredStaffId ? "customer preference; " : "") +
      `weighted load ${Math.round(load)} min (${c.allocatedMinutes} min / weight ${c.fairnessWeight})` +
      (c.lastAssignedAt ? `; last assigned ${c.lastAssignedAt.toISOString()}` : "; never assigned"),
  }));
}
