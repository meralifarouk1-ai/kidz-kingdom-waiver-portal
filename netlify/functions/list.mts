import type { Context, Config } from "@netlify/functions";
import { getStore } from "@netlify/blobs";

function isAuthorized(req: Request): boolean {
  const expected = Netlify.env.get("ADMIN_PASSWORD") || "";
  const provided = req.headers.get("x-admin-password") || "";
  return Boolean(expected) && provided === expected;
}

export default async (req: Request, context: Context) => {
  if (req.method !== "GET") {
    return new Response(JSON.stringify({ error: "Method not allowed" }), { status: 405 });
  }

  if (!isAuthorized(req)) {
    return new Response(JSON.stringify({ error: "Unauthorized" }), { status: 401 });
  }

  // Each submission has its own index entry blob (keyed by id), so listing
  // means enumerating and reading them all. Read in concurrent batches to
  // stay fast even with thousands of entries.
  const indexStore = getStore("waiver-index");
  const { blobs } = await indexStore.list();

  const index: any[] = [];
  const BATCH_SIZE = 150;
  for (let i = 0; i < blobs.length; i += BATCH_SIZE) {
    const batch = blobs.slice(i, i + BATCH_SIZE);
    const results = await Promise.all(
      batch.map(({ key }) => indexStore.get(key, { type: "json" }).catch(() => null))
    );
    for (const entry of results) {
      if (entry && entry.id) index.push(entry);
    }
  }

  index.sort((a: any, b: any) => (a.submittedAt < b.submittedAt ? 1 : -1));

  return new Response(JSON.stringify({ submissions: index }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
};

export const config: Config = {
  path: "/api/admin/list",
};
