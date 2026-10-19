import type { Context, Config } from "@netlify/functions";
import { isAuthorized } from "../lib/waiver.mts";
import { frontDeskStatus, setFrontDeskPassword, disableFrontDesk } from "../lib/auth.mts";

const json = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json", "cache-control": "no-store" } });

// Super Admin only.
// GET    /api/admin/staff-access           -> {enabled, updatedAt}
// PUT    /api/admin/staff-access {password} -> set or change the Front Desk password
// DELETE /api/admin/staff-access           -> turn Front Desk logins off
export default async (req: Request, context: Context) => {
  if (!isAuthorized(req)) return json({ error: "Only the Super Admin can do this." }, 403);
  try {
    if (req.method === "GET") return json(await frontDeskStatus());
    if (req.method === "PUT") {
      let b: any;
      try { b = await req.json(); } catch { return json({ error: "Invalid JSON" }, 400); }
      await setFrontDeskPassword((b.password || "").toString());
      return json({ success: true, ...(await frontDeskStatus()) });
    }
    if (req.method === "DELETE") {
      await disableFrontDesk();
      return json({ success: true, enabled: false });
    }
  } catch (err: any) {
    return json({ error: err?.message || "Something went wrong." }, 400);
  }
  return json({ error: "Method not allowed" }, 405);
};

export const config: Config = { path: "/api/admin/staff-access" };
