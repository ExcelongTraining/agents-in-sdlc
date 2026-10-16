/** Pure helpers (no database): used by unit tests. */
export const at = (date: string, time: string): Date => new Date(`${date}T${time}:00+08:00`);
