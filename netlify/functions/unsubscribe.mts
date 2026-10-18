import type { Context, Config } from "@netlify/functions";
import { verifyUnsubscribe, optOut } from "../lib/email.mts";

function page(title: string, message: string, status = 200) {
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>${title} | Kidz Kingdom</title>
<style>body{margin:0;font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;background:#faf7ff;color:#2a1a3d;display:flex;min-height:100vh;align-items:center;justify-content:center;padding:16px}
.card{background:#fff;border:1px solid #e7ddf7;border-radius:18px;padding:32px 26px;max-width:420px;text-align:center;box-shadow:0 4px 18px rgba(124,58,237,.08)}
img{height:64px}h1{font-size:1.25rem;color:#5b21b6;margin:12px 0 8px}p{color:#7a6f8c;line-height:1.5;margin:0}</style></head>
<body><div class="card"><img src="/assets/logo.png" alt="Kidz Kingdom"><h1>${title}</h1><p>${message}</p></div></body></html>`;
  return new Response(html, { status, headers: { "content-type": "text/html; charset=utf-8" } });
}

// GET  /api/unsubscribe?e=<email>&t=<token>  (link in the email footer)
// POST /api/unsubscribe?e=<email>&t=<token>  (one-click unsubscribe from the mail app)
export default async (req: Request, context: Context) => {
  const url = new URL(req.url);
  const email = (url.searchParams.get("e") || "").trim();
  const token = url.searchParams.get("t") || "";

  if (!email || !verifyUnsubscribe(email, token)) {
    return page("Link not valid", "This unsubscribe link isn't valid. Please reply to the email and we'll remove you.", 400);
  }
  await optOut(email);
  if (req.method === "POST") return new Response("Unsubscribed", { status: 200 });
  return page("You're unsubscribed", "You won't receive birthday emails from Kidz Kingdom any more.");
};

export const config: Config = { path: "/api/unsubscribe" };
