import type { Context, Config } from "@netlify/functions";
import { loadIndex } from "../lib/waiver.mts";
import { roleFor } from "../lib/auth.mts";

export default async (req: Request, context: Context) => {
  if (req.method !== "GET") {
    return new Response(JSON.stringify({ error: "Method not allowed" }), { status: 405 });
  }

  if (!(await roleFor(req))) {
    return new Response(JSON.stringify({ error: "Unauthorized" }), { status: 401 });
  }

  try {
    const { entries, total, failed } = await loadIndex();
    if (failed > 0) {
      console.warn(`list: ${failed} of ${total} waivers could not be read`);
    }
    return new Response(JSON.stringify({ submissions: entries, total, failed }), {
      status: 200,
      headers: { "content-type": "application/json", "cache-control": "no-store" },
    });
  } catch (err) {
    console.error("list failed", err);
    return new Response(JSON.stringify({ error: "Could not load waivers. Please try again." }), {
      status: 503,
      headers: { "content-type": "application/json" },
    });
  }
};

export const config: Config = {
  path: "/api/admin/list",
};
