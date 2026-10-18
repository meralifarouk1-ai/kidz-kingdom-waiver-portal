import type { Context, Config } from "@netlify/functions";
import { isAuthorized, MONTHS } from "../lib/waiver.mts";
import {
  birthdaysForMonth,
  sentLogForMonth,
  optedOutHashes,
  emailHash,
  emailConfigured,
  emailProvider,
  senderAddress,
  TEST_EMAIL,
} from "../lib/email.mts";

const json = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json", "cache-control": "no-store" },
  });

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

// GET /api/admin/birthdays?month=10
export default async (req: Request, context: Context) => {
  if (req.method !== "GET") return json({ error: "Method not allowed" }, 405);
  if (!isAuthorized(req)) return json({ error: "Unauthorized" }, 401);

  const month = Number(new URL(req.url).searchParams.get("month"));
  if (!(month >= 1 && month <= 12)) return json({ error: "Pick a month" }, 400);

  try {
    const { children, birthdayYear, failed } = await birthdaysForMonth(month);
    const [sent, optedOut] = await Promise.all([sentLogForMonth(birthdayYear, month), optedOutHashes()]);

    const rows = children.map((c) => {
      const s = sent.get(c.key);
      let status = "ready";
      if (!EMAIL_RE.test(c.email)) status = "no-email";
      else if (optedOut.has(emailHash(c.email))) status = "unsubscribed";
      else if (s) status = "sent";
      return { ...c, status, sentAt: s?.sentAt || null };
    });

    return json({
      month,
      monthName: MONTHS[month - 1],
      birthdayYear,
      children: rows,
      failed,
      emailConfigured: emailConfigured(),
      provider: emailProvider(),
      sender: emailConfigured() ? senderAddress() : null,
      testEmail: TEST_EMAIL,
    });
  } catch (err) {
    console.error("birthdays failed", err);
    return json({ error: "Could not load birthdays. Please try again." }, 503);
  }
};

export const config: Config = { path: "/api/admin/birthdays" };
