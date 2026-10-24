import { randomBytes } from "node:crypto";

// The public "your order" page the customer is texted (/orders/<token>). The token is the only secret: 128 random bits, so it cannot be
// guessed, and the page shows no phone numbers.
export const ORDER_LINK_DAYS = 30; // after this the link says it has expired

export const newOrderToken = () => randomBytes(16).toString("base64url");
export const validOrderToken = (t: string) => /^[A-Za-z0-9_-]{22}$/.test(t);

export const orderLinkUrl = (token: string, base = process.env.BETTER_AUTH_URL ?? "http://localhost:3000") =>
  `${base.replace(/\/$/, "")}/orders/${token}`;

export const orderLinkExpired = (createdAt: Date, now = new Date()) => now.getTime() - createdAt.getTime() > ORDER_LINK_DAYS * 86_400_000;

// The text message, worded as the restaurant asked.
export function orderSmsText(o: { orderNumber: number; url: string }): string {
  return `Thanks for your order, to view your order #${o.orderNumber}, tap this link: ${o.url}`;
}

// The text when the restaurant moves the pickup time.
export function pickupChangeSmsText(o: { orderNumber: number; when: string; url: string }): string {
  return `Your pickup time for order #${o.orderNumber} is now ${o.when}. Details: ${o.url}`;
}

// The text when an order is cancelled.
export function cancelSmsText(o: { orderNumber: number; url: string }): string {
  return `Your order #${o.orderNumber} has been cancelled. Details: ${o.url}`;
}

// A phone number the customer SAID (digits, maybe a leading 1 or +) -> E.164, or null. North American numbers have 10
// digits (or 11 starting with 1); anything with a "+" is taken as international.
export function parseTextNumber(raw: string): string | null {
  const s = raw.trim();
  const digits = s.replace(/\D/g, "");
  if (s.startsWith("+")) return /^[1-9]\d{7,14}$/.test(digits) ? `+${digits}` : null;
  if (digits.length === 10 && /^[2-9]/.test(digits)) return `+1${digits}`;
  if (digits.length === 11 && digits.startsWith("1") && /^[2-9]/.test(digits.slice(1))) return `+${digits}`;
  return null;
}
