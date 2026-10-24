import { isOwner } from "./role-utils";
import { requireTenant } from "./tenant";

export { isOwner, roleLabel } from "./role-utils";
export const FORBIDDEN = { ok: false as const, error: "Only the restaurant owner can do this" };

// Roles inside a restaurant: "owner" manages everything; anyone else ("member", shown as Staff) only works
// the orders board and can mark dishes sold out. Phone numbers are platform-admin only anyway.
// For server actions: the active restaurant if the caller is an owner there, else null (reply FORBIDDEN).
export async function requireOwner() {
  const t = await requireTenant();
  return isOwner(t.role) ? t : null;
}
