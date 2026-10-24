// Client-safe (no DB imports) so both server code and client components can use it.
export const lineUnitCents = (priceCents: number, modifiers: { priceDeltaCents: number }[]) =>
  priceCents + modifiers.reduce((s, m) => s + m.priceDeltaCents, 0);
