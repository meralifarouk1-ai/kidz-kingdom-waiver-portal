import type { Context, Config } from "@netlify/functions";
import { getStore } from "@netlify/blobs";

function isAuthorized(req: Request): boolean {
  const expected = Netlify.env.get("ADMIN_PASSWORD") || "";
  const provided = req.headers.get("x-admin-password") || "";
  return Boolean(expected) && provided === expected;
}

// Rebuilds the "index" blob from scratch by reading every record in the
// waiver-submissions store (the source of truth). This repairs any gaps left
// behind by the index-append race condition that existed before the
// optimistic-concurrency fix in submit.mts / delete-submission.mts. Safe to
// call any time - it never touches the underlying submission records.
export default async (req: Request, context: Context) => {
  if (req.method !== "POST") {
    return new Response(JSON.stringify({ error: "Method not allowed" }), { status: 405 });
  }

  if (!isAuthorized(req)) {
    return new Response(JSON.stringify({ error: "Unauthorized" }), { status: 401 });
  }

  const submissionsStore = getStore("waiver-submissions");
  const indexStore = getStore("waiver-index");

  const { blobs } = await submissionsStore.list();

  const rebuilt: any[] = [];
  const errors: string[] = [];

  for (const { key } of blobs) {
    try {
      const record = await submissionsStore.get(key, { type: "json" });
      if (!record) continue;
      rebuilt.push({
        id: record.id,
        submittedAt: record.submittedAt,
        parentName: record.parentName,
        phone: record.phone,
        email: record.email,
        children: record.children,
      });
    } catch {
      errors.push(key);
    }
  }

  const before = (await indexStore.get("index", { type: "json" })) || [];
  await indexStore.setJSON("index", rebuilt);

  return new Response(
    JSON.stringify({
      success: true,
      totalSubmissionRecords: blobs.length,
      indexEntriesBefore: before.length,
      indexEntriesAfter: rebuilt.length,
      recovered: rebuilt.length - before.length,
      readErrors: errors,
    }),
    { status: 200, headers: { "content-type": "application/json" } }
  );
};

export const config: Config = {
  path: "/api/admin/reindex",
};
