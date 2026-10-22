import type { Context, Config } from "@netlify/functions";
import { roleFor } from "../lib/auth.mts";
import { listTrash, restoreFromTrash, auditLog, searchBackups, writeDailyBackup } from "../lib/trash.mts";

const json = (d: unknown, status = 200) =>
  new Response(JSON.stringify(d), { status, headers: { "content-type": "application/json", "cache-control": "no-store" } });

// GET  /api/admin/trash              deleted waivers + audit log
// GET  /api/admin/trash?backup=q     search daily backups for a name / phone
// POST /api/admin/trash {id}         restore a deleted waiver
export default async (req: Request, context: Context) => {
  if ((await roleFor(req)) !== "admin") return json({ error: "Unauthorized" }, 401);
  try {
    if (req.method === "GET") {
      const q = new URL(req.url).searchParams.get("backup");
      if (q) return json(await searchBackups(q));
      const [deleted, log] = await Promise.all([listTrash(), auditLog(100)]);
      return json({ deleted, log });
    }
    if (req.method === "POST") {
      const b: any = await req.json().catch(() => ({}));
      if (b.action === "backup") return json({ backup: await writeDailyBackup() });
      const ok = await restoreFromTrash((b.id || "").toString(), "Super Admin");
      return ok ? json({ success: true }) : json({ error: "Not found" }, 404);
    }
  } catch (err) {
    console.error("trash failed", err);
    return json({ error: "Something went wrong. Please try again." }, 500);
  }
  return json({ error: "Method not allowed" }, 405);
};

export const config: Config = { path: "/api/admin/trash" };
