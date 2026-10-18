import type { Context, Config } from "@netlify/functions";
import { isAuthorized } from "../lib/waiver.mts";
import {
  birthdaysForMonth,
  sentLogForMonth,
  optedOutHashes,
  emailHash,
  emailConfigured,
  SendError,
  loadTemplate,
  buildEmail,
  sendEmail,
  markSent,
  unsubscribeUrl,
  siteUrlFrom,
  SAMPLE_CHILD,
  TEST_EMAIL,
  normalizeImageFields,
  type EmailTemplate,
} from "../lib/email.mts";

const json = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json", "cache-control": "no-store" },
  });

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const MAX_PER_REQUEST = 5; // keeps each call well inside the function time limit

function friendlyError(err: any): string {
  if (err instanceof SendError) return err.message;
  const msg = (err?.response || err?.message || "").toString();
  if (/Invalid login|Username and Password not accepted|535/i.test(msg)) {
    return "Gmail rejected the login. Check the app password saved as SMTP_PASS in Netlify.";
  }
  if (/Daily user sending limit|550 5\.4\.5|quota/i.test(msg)) {
    return "Gmail's daily sending limit was reached. Try the rest tomorrow.";
  }
  if (/timeout|ETIMEDOUT|ECONNECTION|ESOCKET/i.test(msg)) return "Could not reach Gmail. Please try again.";
  return "Sending failed. Please try again.";
}

// POST /api/admin/birthday-send
//   { month, keys: [childKey...], test?: boolean, template?: {...}, resend?: boolean }
// test: sends ONE email, filled in for the first selected child (or a sample
//       child), to the Kidz Kingdom test inbox only. Uses the template passed
//       in, so unsaved edits can be previewed.
// otherwise: sends to each selected child's parent using the SAVED template,
//       skipping anyone already emailed for this birthday (unless resend),
//       unsubscribed, or without a valid email.
export default async (req: Request, context: Context) => {
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);
  if (!isAuthorized(req)) return json({ error: "Unauthorized" }, 401);
  if (!emailConfigured()) {
    return json({ error: "Email isn't set up yet: add RESEND_API_KEY in Netlify." }, 503);
  }

  let body: any;
  try {
    body = await req.json();
  } catch {
    return json({ error: "Invalid JSON" }, 400);
  }
  const month = Number(body.month);
  const keys: string[] = Array.isArray(body.keys) ? body.keys.map(String) : [];
  const siteUrl = siteUrlFrom(req);

  // ---- Test email ----
  if (body.test) {
    let child = SAMPLE_CHILD;
    if (month >= 1 && month <= 12 && keys.length) {
      const { children } = await birthdaysForMonth(month);
      child = children.find((c) => c.key === keys[0]) || child;
    }
    const saved = await loadTemplate();
    const t: EmailTemplate = {
      subject: (body.template?.subject ?? saved.subject).toString(),
      body: (body.template?.body ?? saved.body).toString(),
      footerAddress: (body.template?.footerAddress ?? saved.footerAddress).toString(),
      ...normalizeImageFields(body.template ?? saved),
    };
    const unsub = unsubscribeUrl(siteUrl, TEST_EMAIL);
    try {
      await sendEmail(TEST_EMAIL, buildEmail(t, child, unsub, true, siteUrl), unsub);
      return json({ success: true, to: TEST_EMAIL, filledFor: `${child.childFirstName} ${child.childLastName}` });
    } catch (err) {
      console.error("test send failed", err);
      return json({ error: friendlyError(err) }, 502);
    }
  }

  // ---- Real send ----
  if (!(month >= 1 && month <= 12)) return json({ error: "Pick a month" }, 400);
  if (!keys.length) return json({ error: "No children selected" }, 400);
  if (keys.length > MAX_PER_REQUEST) return json({ error: `Send at most ${MAX_PER_REQUEST} at a time` }, 400);

  const { children, birthdayYear } = await birthdaysForMonth(month);
  const [sent, optedOut, template] = await Promise.all([
    sentLogForMonth(birthdayYear, month),
    optedOutHashes(),
    loadTemplate(),
  ]);
  const byKey = new Map(children.map((c) => [c.key, c]));

  const results: any[] = [];
  for (const key of keys) {
    const c = byKey.get(key);
    if (!c) { results.push({ key, result: "skipped", reason: "Not in this month's list" }); continue; }
    if (!EMAIL_RE.test(c.email)) { results.push({ key, result: "skipped", reason: "No valid email" }); continue; }
    if (optedOut.has(emailHash(c.email))) { results.push({ key, result: "skipped", reason: "Unsubscribed" }); continue; }
    if (sent.has(key) && !body.resend) { results.push({ key, result: "skipped", reason: "Already sent" }); continue; }

    const unsub = unsubscribeUrl(siteUrl, c.email);
    try {
      await sendEmail(c.email, buildEmail(template, c, unsub, false, siteUrl), unsub);
      await markSent(c).catch((e) => console.error("markSent failed", key, e));
      results.push({ key, result: "sent", sentAt: new Date().toISOString() });
    } catch (err) {
      console.error("send failed", key, err);
      const reason = friendlyError(err);
      results.push({ key, result: "failed", reason });
      // A login, domain or quota problem will fail every remaining email too.
      if ((err instanceof SendError && err.stopAll) || /rejected the login|daily sending limit/.test(reason)) {
        for (const rest of keys.slice(keys.indexOf(key) + 1)) results.push({ key: rest, result: "failed", reason });
        break;
      }
    }
  }
  return json({ results });
};

export const config: Config = { path: "/api/admin/birthday-send" };
