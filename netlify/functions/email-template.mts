import type { Context, Config } from "@netlify/functions";
import { isAuthorized } from "../lib/waiver.mts";
import { loadTemplate, saveTemplate, DEFAULT_TEMPLATE, PLACEHOLDERS, normalizeImageFields } from "../lib/email.mts";

const json = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json", "cache-control": "no-store" },
  });

// GET  /api/admin/email-template  -> saved template (or the default)
// PUT  /api/admin/email-template  {subject, body, footerAddress}
export default async (req: Request, context: Context) => {
  if (!isAuthorized(req)) return json({ error: "Unauthorized" }, 401);

  if (req.method === "GET") {
    return json({ template: await loadTemplate(), defaults: DEFAULT_TEMPLATE, placeholders: PLACEHOLDERS });
  }

  if (req.method === "PUT") {
    let body: any;
    try {
      body = await req.json();
    } catch {
      return json({ error: "Invalid JSON" }, 400);
    }
    const subject = (body.subject ?? "").toString().trim().slice(0, 200);
    const text = (body.body ?? "").toString().replace(/\r\n/g, "\n").slice(0, 10000);
    const footerAddress = (body.footerAddress ?? "").toString().trim().slice(0, 300);
    if (!subject || !text.trim()) return json({ error: "The subject and message can't be empty." }, 400);
    if (!footerAddress) return json({ error: "Please enter the business name and address for the email footer." }, 400);
    const template = { subject, body: text, footerAddress, ...normalizeImageFields(body) };
    await saveTemplate(template);
    return json({ success: true, template });
  }

  return json({ error: "Method not allowed" }, 405);
};

export const config: Config = { path: "/api/admin/email-template" };
