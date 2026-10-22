import type { Context, Config } from "@netlify/functions";
import { roleFor } from "../lib/auth.mts";
import { moveToTrash } from "../lib/trash.mts";

const json = (d: unknown, status = 200) => new Response(JSON.stringify(d), { status, headers: { "content-type": "application/json" } });

// Moves a waiver to "Recently Deleted" (it can be restored). Super Admin only.
export default async (req: Request, context: Context) => {
  if (req.method !== "DELETE") return json({ error: "Method not allowed" }, 405);
  if ((await roleFor(req)) !== "admin") return json({ error: "Unauthorized" }, 401);
  const id = new URL(req.url).searchParams.get("id") || "";
  if (!id) return json({ error: "Missing id" }, 400);
  try {
    const ok = await moveToTrash(id, "Super Admin");
    return ok ? json({ success: true }) : json({ error: "Not found" }, 404);
  } catch (err: any) {
    console.error("delete failed", id, err);
    return json({ error: err?.message || "Delete failed" }, 500);
  }
};

export const config: Config = { path: "/api/admin/delete" };
