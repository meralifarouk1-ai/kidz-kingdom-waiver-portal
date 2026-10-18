import type { Context, Config } from "@netlify/functions";
import { isAuthorized } from "../lib/waiver.mts";
import { emailProvider, siteUrlFrom, SendError, TEST_EMAIL } from "../lib/email.mts";
import {
  buildMarketingEmail,
  sendBatch,
  createCampaign,
  continueCampaign,
  pauseCampaign,
  publicCampaign,
  loadSettings,
  saveDraft,
} from "../lib/marketing.mts";

const json = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json", "cache-control": "no-store" } });

// POST /api/admin/marketing-send
//   {action:"test", subject, body}            one email to the Kidz Kingdom inbox
//   {action:"start", subject, body, confirm}  freeze the audience and create a campaign
//   {action:"continue", campaignId}           send the next few batches
//   {action:"pause", campaignId}
export default async (req: Request, context: Context) => {
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);
  if (!isAuthorized(req)) return json({ error: "Unauthorized" }, 401);
  if (emailProvider() !== "resend") {
    return json({ error: "Marketing emails need Resend. Add RESEND_API_KEY in Netlify." }, 503);
  }

  let b: any;
  try { b = await req.json(); } catch { return json({ error: "Invalid JSON" }, 400); }
  const siteUrl = siteUrlFrom(req);
  const subject = (b.subject ?? "").toString().trim().slice(0, 200);
  const body = (b.body ?? "").toString().replace(/\r\n/g, "\n").slice(0, 20000);

  try {
    if (b.action === "test") {
      if (!subject || !body.trim()) return json({ error: "Please write a subject and a message first." }, 400);
      const settings = await loadSettings();
      const email = buildMarketingEmail({ subject, body }, settings, { email: TEST_EMAIL, firstName: "Amina", name: "Amina Khan" }, siteUrl, true);
      // Same batch route as the real send, so a successful test proves the real one works.
      const r = await sendBatch([email], `kk-mkt-test/${Date.now()}`);
      if (!r.ok) return json({ error: `Resend couldn't send the test: ${r.detail || r.status}` }, 502);
      return json({ success: true, to: TEST_EMAIL });
    }

    if (b.action === "start") {
      if (!subject || !body.trim()) return json({ error: "Please write a subject and a message first." }, 400);
      if ((b.confirm || "").toString().trim().toUpperCase() !== "SEND") return json({ error: "Type SEND to confirm." }, 400);
      await saveDraft({ subject, body });
      const c = await createCampaign({ subject, body }, await loadSettings(), siteUrl);
      if (!c.total) return json({ error: "There's nobody to send to." }, 400);
      return json({ campaign: publicCampaign(c) });
    }

    if (b.action === "continue") {
      const c = await continueCampaign((b.campaignId || "").toString());
      return json({ campaign: publicCampaign(c) });
    }

    if (b.action === "pause") {
      const c = await pauseCampaign((b.campaignId || "").toString());
      return c ? json({ campaign: publicCampaign(c) }) : json({ error: "Not found" }, 404);
    }
  } catch (err: any) {
    console.error("marketing-send failed", err);
    const msg = err instanceof SendError ? err.message : "Something went wrong. Please try again.";
    return json({ error: msg }, err instanceof SendError ? 409 : 500);
  }
  return json({ error: "Unknown action" }, 400);
};

export const config: Config = { path: "/api/admin/marketing-send" };
