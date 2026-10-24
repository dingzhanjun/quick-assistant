// Phone carriers and SIP gateways do not agree on how to write the dialed number, so the agent API accepts
// the common forms and maps them onto the E.164 numbers stored in `phone_numbers`.
//   +14155550100 | 14155550100 | 4155550100 | +1 (415) 555-0100 | sip:+14155550100@host;user=phone | tel:+1...
export function phoneCandidates(raw: string): string[] {
  let s = raw.trim().replace(/^(sips?|tel):/i, "");
  s = s.split("@")[0].split(";")[0];
  const digits = s.replace(/\D/g, "");
  if (digits.length < 7 || digits.length > 15) return [];
  const out = new Set<string>(["+" + digits]); // already has its country code (with or without the "+")
  if (digits.length === 10) out.add("+1" + digits); // US/Canada number written without the country code
  return [...out];
}

// Strip formatting and require E.164 (+ then 8-15 digits) so a stored number matches LiveKit's SIP number.
export function normalizeE164(raw: string): string | null {
  const cleaned = raw.replace(/[\s().-]/g, "");
  return /^\+[1-9]\d{7,14}$/.test(cleaned) ? cleaned : null;
}
