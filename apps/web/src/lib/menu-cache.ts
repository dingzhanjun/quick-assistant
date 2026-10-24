import { availableMenuWithModifiers } from "./modifiers";

// Every phone call fetches the restaurant's WHOLE menu with its modifier groups. Menus change a few times a day, so
// each web process keeps the result for a few seconds per restaurant: 200 calls at once cost a handful of queries
// instead of hundreds. Edits made on THIS process invalidate immediately; other replicas pick them up when the entry
// expires (MENU_CACHE_SECONDS, default 10, 0 = off), so a sold-out toggle reaches the agent within that time.
type Menu = Awaited<ReturnType<typeof availableMenuWithModifiers>>;
type Entry = { at: number; value?: Menu; pending?: Promise<Menu> };

const g = globalThis as unknown as { __menuCache?: Map<string, Entry> };
const cache = (g.__menuCache ??= new Map<string, Entry>());

const ttlMs = () => {
  const n = Number(process.env.MENU_CACHE_SECONDS ?? 10);
  return (Number.isFinite(n) && n >= 0 ? n : 10) * 1000;
};

export async function cachedAgentMenu(tenantId: string, load: (id: string) => Promise<Menu> = availableMenuWithModifiers): Promise<Menu> {
  const ttl = ttlMs();
  if (ttl === 0) return load(tenantId);
  const now = Date.now();
  const hit = cache.get(tenantId);
  if (hit?.value && now - hit.at < ttl) return hit.value;
  if (hit?.pending) return hit.pending; // a burst of calls shares ONE query
  const pending = load(tenantId).then(
    (value) => {
      if (cache.get(tenantId)?.pending === pending) cache.set(tenantId, { at: Date.now(), value });
      return value;
    },
    (err) => {
      if (cache.get(tenantId)?.pending === pending) cache.delete(tenantId); // never cache a failure
      throw err;
    },
  );
  cache.set(tenantId, { at: hit?.at ?? 0, pending });
  return pending;
}

// Call after any change to a restaurant's menu items, modifier groups or options.
export function invalidateMenu(tenantId: string) {
  cache.delete(tenantId);
}

export function clearMenuCache() {
  cache.clear();
}
