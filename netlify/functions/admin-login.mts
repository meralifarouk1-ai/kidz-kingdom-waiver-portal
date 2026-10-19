import type { Context, Config } from "@netlify/functions";
import { roleForPassword } from "../lib/auth.mts";

const json = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json", "cache-control": "no-store" } });

// POST /api/admin/login {password} -> {success, role: "admin" | "frontdesk"}
export default async (req: Request, context: Context) => {
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);
  let body: any;
  try { body = await req.json(); } catch { return json({ error: "Invalid JSON body" }, 400); }

  const role = await roleForPassword((body.password || "").toString());
  if (!role) {
    await new Promise((r) => setTimeout(r, 600)); // slows down password guessing
    return json({ error: "Invalid password" }, 401);
  }
  return json({ success: true, role });
};

export const config: Config = { path: "/api/admin/login" };
