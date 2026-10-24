// Sending text messages (SMS). The provider is chosen with SMS_PROVIDER:
//   twilio  TWILIO_ACCOUNT_SID, TWILIO_AUTH_TOKEN, SMS_FROM (a Twilio number or messaging service sid "MG...")
//   plivo   PLIVO_AUTH_ID, PLIVO_AUTH_TOKEN, SMS_FROM (a Plivo number or sender id)
//   log     prints the message to the server console (development; nothing is sent)
//   (unset) texting is OFF: the phone agent does not offer to text orders.
// Whichever you use, US numbers need carrier registration (A2P 10DLC / toll-free verification) before messages are delivered.
export type SmsProvider = "twilio" | "plivo" | "log";

export function smsProvider(env: Env = process.env): SmsProvider | null {
  const p = (env.SMS_PROVIDER ?? "").trim().toLowerCase();
  if (p === "log") return "log";
  if (p === "twilio" && env.TWILIO_ACCOUNT_SID && env.TWILIO_AUTH_TOKEN && env.SMS_FROM) return "twilio";
  if (p === "plivo" && env.PLIVO_AUTH_ID && env.PLIVO_AUTH_TOKEN && env.SMS_FROM) return "plivo";
  return null;
}

export const smsConfigured = (env: Env = process.env) => smsProvider(env) !== null;

type Fetch = typeof fetch;
type Env = Record<string, string | undefined>;

// Throws on any failure so the job worker retries (and finally records a system.job_failed audit entry).
export async function sendSms(to: string, text: string, env: Env = process.env, doFetch: Fetch = fetch): Promise<void> {
  const provider = smsProvider(env);
  if (!provider) throw new Error("SMS is not configured (SMS_PROVIDER)");
  if (provider === "log") {
    console.log(`[sms:dev] to=${to}\n${text}`);
    return;
  }
  const basic = (user: string, pass: string) => `Basic ${Buffer.from(`${user}:${pass}`).toString("base64")}`;
  let res: Response;
  if (provider === "twilio") {
    const sid = env.TWILIO_ACCOUNT_SID!;
    const from = env.SMS_FROM!;
    const form = new URLSearchParams({ To: to, Body: text });
    form.set(from.startsWith("MG") ? "MessagingServiceSid" : "From", from);
    res = await doFetch(`https://api.twilio.com/2010-04-01/Accounts/${encodeURIComponent(sid)}/Messages.json`, {
      method: "POST",
      headers: { authorization: basic(sid, env.TWILIO_AUTH_TOKEN!), "content-type": "application/x-www-form-urlencoded" },
      body: form,
      signal: AbortSignal.timeout(15_000),
    });
  } else {
    const id = env.PLIVO_AUTH_ID!;
    res = await doFetch(`https://api.plivo.com/v1/Account/${encodeURIComponent(id)}/Message/`, {
      method: "POST",
      headers: { authorization: basic(id, env.PLIVO_AUTH_TOKEN!), "content-type": "application/json" },
      // Plivo wants numbers as digits with the country code (no "+")
      body: JSON.stringify({ src: env.SMS_FROM!.replace(/^\+(?=\d)/, ""), dst: to.replace(/^\+/, ""), text }),
      signal: AbortSignal.timeout(15_000),
    });
  }
  if (!res.ok) throw new Error(`${provider} answered ${res.status}: ${(await res.text().catch(() => "")).slice(0, 200)}`);
}
