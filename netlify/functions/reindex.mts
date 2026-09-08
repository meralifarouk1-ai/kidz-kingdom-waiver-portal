import type { Context, Config } from "@netlify/functions";
import { getStore } from "@netlify/blobs";

function isAuthorized(req: Request): boolean {
  const expected = Netlify.env.get("ADMIN_PASSWORD") || "";
  const provided = req.headers.get("x-admin-password") || "";
  return Boolean(expected) && provided === expected;
}

// Rebuilds per-submission index entries (one blob per id, in "waiver-index")
// from the waiver-submissions store (the source of truth). This repairs any
// gaps and also migrates away from the old single shared "index" blob format
// (which caused a read-modify-write bottleneck under concurrent submissions).
// Safe to call any time - it never touches the underlying submission records.
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

  let written = 0;
  const errors: string[] = [];

  // Read + write concurrently in batches (this store can hold thousands of
  // submissions - doing this one at a time can exceed the function's
  // execution time limit).
  const BATCH_SIZE = 100;
  for (let i = 0; i < blobs.length; i += BATCH_SIZE) {
    const batch = blobs.slice(i, i + BATCH_SIZE);
    await Promise.all(
      batch.map(async ({ key }) => {
        try {
          const record = await submissionsStore.get(key, { type: "json" });
          if (!record) return;
          await indexStore.setJSON(record.id, {
            id: record.id,
            submittedAt: record.submittedAt,
            parentName: record.parentName,
            phone: record.phone,
            email: record.email,
            children: record.children,
          });
          written++;
        } catch {
          errors.push(key);
        }
      })
    );
  }

  // Clean up the old single-blob "index" key from the previous storage
  // format, if it's still there - list.mts already ignores it, but removing
  // it keeps the store tidy.
  try {
    await indexStore.delete("index");
  } catch {}

  return new Response(
    JSON.stringify({
      success: true,
      totalSubmissionRecords: blobs.length,
      indexEntriesWritten: written,
      readErrors: errors,
    }),
    { status: 200, headers: { "content-type": "application/json" } }
  );
};

export const config: Config = {
  path: "/api/admin/reindex",
};
