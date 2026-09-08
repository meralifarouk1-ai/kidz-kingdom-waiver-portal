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

  // Read records concurrently in batches (this store can hold thousands of
  // submissions - reading them one at a time can exceed the function's
  // execution time limit).
  const BATCH_SIZE = 100;
  for (let i = 0; i < blobs.length; i += BATCH_SIZE) {
    const batch = blobs.slice(i, i + BATCH_SIZE);
    const results = await Promise.all(
      batch.map(async ({ key }) => {
        try {
          const record = await submissionsStore.get(key, { type: "json" });
          return { key, record };
        } catch {
          return { key, record: null, error: true };
        }
      })
    );
    for (const { key, record, error } of results) {
      if (error) {
        errors.push(key);
        continue;
      }
      if (!record) continue;
      rebuilt.push({
        id: record.id,
        submittedAt: record.submittedAt,
        parentName: record.parentName,
        phone: record.phone,
        email: record.email,
        children: record.children,
      });
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
