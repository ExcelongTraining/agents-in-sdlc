import { getPool } from "../db/pool";
import { env } from "../config/env";
import { AppError } from "../errors";

const cache = new Map<string, string>();

/** Resolve the organisation served by this deployment (ORG_SLUG). organisations is readable by both app roles. */
export async function getOrgId(slug: string = env().ORG_SLUG): Promise<string> {
  const hit = cache.get(slug);
  if (hit) return hit;
  const res = await getPool().query<{ id: string }>("select id from organisations where slug = $1", [slug]);
  const id = res.rows[0]?.id;
  if (!id) throw new AppError("INTERNAL", "Service is not configured.", { internal: `organisation ${slug} not found` });
  cache.set(slug, id);
  return id;
}
export const clearOrgCacheForTests = (): void => cache.clear();
