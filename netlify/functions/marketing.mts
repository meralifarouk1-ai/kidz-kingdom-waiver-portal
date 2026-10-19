import type { Context, Config } from "@netlify/functions";
import { isAuthorized } from "../lib/waiver.mts";
import { emailProvider, TEST_EMAIL } from "../lib/email.mts";
import {
  loadDraft,
  saveDraft,
  loadSettings,
  saveSettings,
  buildAudience,
  listCampaigns,
  getCampaign,
  marketingFrom,
  publicCampaign,
} from "../lib/marketing.mts";

const json = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json", "cache-control": "no-store" } });

// GET /api/admin/marketing            -> draft, settings, audience size, past campaigns
// GET /api/admin/marketing?campaign=ID -> one campaign's progress (incl. failures)
// PUT /api/admin/marketing            -> save draft {subject, body} and footer settings
export default async (req: Request, context: Context) => {
  if (!isAuthorized(req)) return json({ error: "Unauthorized" }, 401);

  if (req.method === "GET") {
    const id = new URL(req.url).searchParams.get("campaign");
    if (id) {
      const c = await getCampaign(id);
      return c ? json({ campaign: { ...publicCampaign(c), body: c.body } }) : json({ error: "Not found" }, 404);
    }
    try {
      const [draft, settings, audience, campaigns] = await Promise.all([
        loadDraft(),
        loadSettings(),
        buildAudience(),
        listCampaigns(),
      ]);
      return json({
        draft,
        settings,
        audience: {
          count: audience.recipients.length,
          excluded: audience.excluded,
          failedReads: audience.failedReads,
          waivers: audience.waivers,
        },
        campaigns,
        provider: emailProvider(),
        sender: marketingFrom(),
        testEmail: TEST_EMAIL,
      });
    } catch (err) {
      console.error("marketing load failed", err);
      return json({ error: "Could not load. Please try again." }, 503);
    }
  }

  if (req.method === "PUT") {
    let b: any;
    try { b = await req.json(); } catch { return json({ error: "Invalid JSON" }, 400); }
    const subject = (b.subject ?? "").toString().slice(0, 200);
    const body = (b.body ?? "").toString().replace(/\r\n/g, "\n").slice(0, 20000);
    await saveDraft({ subject, body });
    if (b.footerAddress !== undefined || b.contactLine !== undefined) {
      const footerAddress = (b.footerAddress ?? "").toString().trim().slice(0, 300);
      const contactLine = (b.contactLine ?? "").toString().trim().slice(0, 300);
      if (!footerAddress || !contactLine) return json({ error: "Please fill in the business address and contact line for the footer." }, 400);
      await saveSettings({ footerAddress, contactLine });
    }
    return json({ success: true, savedAt: new Date().toISOString() });
  }

  return json({ error: "Method not allowed" }, 405);
};

export const config: Config = { path: "/api/admin/marketing" };
