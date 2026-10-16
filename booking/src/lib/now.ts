/** Wall-clock milliseconds. Kept behind a function so UI code can read the clock inside event handlers and timers. */
export const nowMs = (): number => Date.now();
