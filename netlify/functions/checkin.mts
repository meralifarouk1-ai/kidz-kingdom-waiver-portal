import type { Context, Config } from "@netlify/functions";
import { isAuthorized } from "../lib/waiver.mts";
import { createCheckIn, deleteCheckIn } from "../lib/checkin.mts";

const json = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json", "cache-control": "no-store" } });

// POST   /api/admin/checkin  {waiverId, children?: string[]}  -> check a family in now
// DELETE /api/admin/checkin?id=<check-in id>                -> undo a check-in
export default async (req: Request, context: Context) => {
  if (!isAuthorized(req)) return json({ error: "Unauthorized" }, 401);
  try {
    if (req.method === "POST") {
      let b: any;
      try { b = await req.json(); } catch { return json({ error: "Invalid JSON" }, 400); }
      const waiverId = (b.waiverId || "").toString();
      if (!waiverId) return json({ error: "Missing waiver" }, 400);
      const children = Array.isArray(b.children) ? b.children.map(String) : null;
      return json(await createCheckIn(waiverId, children));
    }
    if (req.method === "DELETE") {
      await deleteCheckIn(new URL(req.url).searchParams.get("id") || "");
      return json({ success: true });
    }
  } catch (err: any) {
    console.error("checkin failed", err);
    return json({ error: err?.message || "Check-in failed. Please try again." }, 400);
  }
  return json({ error: "Method not allowed" }, 405);
};

export const config: Config = { path: "/api/admin/checkin" };
