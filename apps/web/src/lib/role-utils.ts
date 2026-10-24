// Client-safe role helpers (no server imports). Server-side guard is in roles.ts.
export const isOwner = (role: string) => role === "owner";
export const roleLabel = (role: string) => (isOwner(role) ? "Owner" : "Staff");
