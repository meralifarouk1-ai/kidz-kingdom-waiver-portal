import type { Context, Config } from "@netlify/functions";
import { getStore } from "@netlify/blobs";

// Removes the entry with `id` from the "index" blob using optimistic concurrency
// (etag-conditioned writes) so a concurrent submit/delete can't silently clobber
// this update (Netlify Blobs has no built-in concurrency control - last write wins).
async function removeFromIndex(indexStore: ReturnType<typeof getStore>, id: string) {
  for (let attempt = 0; attempt < 10; attempt++) {
    const existing = await indexStore.getWithMetadata("index", { type: "json" });
    const currentIndex = existing?.data || [];
    const nextIndex = currentIndex.filter((item: any) => item.id !== id);
    const writeOptions = existing?.etag ? { onlyIfMatch: existing.etag } : { onlyIfNew: true };
    const { modified } = await indexStore.setJSON("index", nextIndex, writeOptions);
    if (modified) return;
    await new Promise((resolve) => setTimeout(resolve, 40 + Math.random() * 120));
  }
  const existingIndex = (await indexStore.get("index", { type: "json" })) || [];
  await indexStore.setJSON("index", existingIndex.filter((item: any) => item.id !== id));
}

function isAuthorized(req: Request): boolean {
  const expected = Netlify.env.get("ADMIN_PASSWORD") || "";
  const provided = req.headers.get("x-admin-password") || "";
  return Boolean(expected) && provided === expected;
}

export default async (req: Request, context: Context) => {
  if (req.method !== "DELETE") {
    return new Response(JSON.stringify({ error: "Method not allowed" }), { status: 405 });
  }

  if (!isAuthorized(req)) {
    return new Response(JSON.stringify({ error: "Unauthorized" }), { status: 401 });
  }

  const url = new URL(req.url);
  const id = url.searchParams.get("id") || "";
  if (!id) {
    return new Response(JSON.stringify({ error: "Missing id" }), { status: 400 });
  }

  const submissionsStore = getStore("waiver-submissions");
  await submissionsStore.delete(id);

  const indexStore = getStore("waiver-index");
  await removeFromIndex(indexStore, id);

  return new Response(JSON.stringify({ success: true }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
};

export const config: Config = {
  path: "/api/admin/delete",
};
