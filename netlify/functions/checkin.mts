import type { Context, Config } from "@netlify/functions";
import { roleFor } from "../lib/auth.mts";
import { createCheckIn, deleteCheckIn } from "../lib/checkin.mts";

const json = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json", "cache-control": "no-store" } });

// POST   /api/admin/checkin  {waiverId, children?: string[]}  -> check a family in now
// DELETE /api/admin/checkin?id=<check-in id>                -> undo a check-in
const UNDO_WINDOW_MS = 10 * 60 * 1000;

export default async (req: Request, context: Context) => {
  const role = await roleFor(req);
  if (!role) return json({ error: "Unauthorized" }, 401);
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
      const id = new URL(req.url).searchParams.get("id") || "";
      if (role !== "admin") {
        const madeAt = Number((id.split("/")[1] || "").split("-")[0]);
        if (!madeAt || Date.now() - madeAt > UNDO_WINDOW_MS) {
          return json({ error: "Front desk can only undo a check-in within 10 minutes. Please ask a manager." }, 403);
        }
      }
      await deleteCheckIn(id);
      return json({ success: true });
    }
  } catch (err: any) {
    console.error("checkin failed", err);
    return json({ error: err?.message || "Check-in failed. Please try again." }, 400);
  }
  return json({ error: "Method not allowed" }, 405);
};

export const config: Config = { path: "/api/admin/checkin" };
