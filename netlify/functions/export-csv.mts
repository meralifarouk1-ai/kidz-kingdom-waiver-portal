import type { Context, Config } from "@netlify/functions";
import { getStore } from "@netlify/blobs";

function isAuthorized(req: Request): boolean {
  const expected = Netlify.env.get("ADMIN_PASSWORD") || "";
  const provided = req.headers.get("x-admin-password") || "";
  return Boolean(expected) && provided === expected;
}

function csvEscape(value: string): string {
  const str = (value ?? "").toString();
  if (/[",\r\n]/.test(str)) {
    return `"${str.replace(/"/g, '""')}"`;
  }
  return str;
}

export default async (req: Request, context: Context) => {
  if (req.method !== "GET") {
    return new Response(JSON.stringify({ error: "Method not allowed" }), { status: 405 });
  }

  if (!isAuthorized(req)) {
    return new Response(JSON.stringify({ error: "Unauthorized" }), { status: 401 });
  }

  const url = new URL(req.url);
  const dateFilter = url.searchParams.get("date") || "";

  // Each submission has its own index entry blob (keyed by id) — same layout
  // that submit.mts writes and list.mts reads. Read in concurrent batches.
  const indexStore = getStore("waiver-index");
  const { blobs } = await indexStore.list();

  let index: any[] = [];
  const BATCH_SIZE = 150;
  for (let i = 0; i < blobs.length; i += BATCH_SIZE) {
    const batch = blobs.slice(i, i + BATCH_SIZE);
    const results = await Promise.all(
      batch.map(({ key }) => indexStore.get(key, { type: "json" }).catch(() => null))
    );
    for (const entry of results) {
      if (entry && (entry as any).id) index.push(entry);
    }
  }
  index.sort((a: any, b: any) => (a.submittedAt < b.submittedAt ? 1 : -1));

  if (dateFilter) {
    index = index.filter((item: any) => {
      const mtDate = new Date(item.submittedAt).toLocaleDateString("en-CA", { timeZone: "America/Edmonton" });
      return mtDate === dateFilter;
    });
  }

  const header = ["Parent/Guardian Name", "Email", "Phone", "Children", "Submitted (Mountain Time)"];
  const rows = index.map((item: any) => [
    item.parentName,
    item.email,
    item.phone,
    (item.children || []).join("; "),
    new Date(item.submittedAt).toLocaleString("en-CA", { timeZone: "America/Edmonton" }),
  ]);

  const csv = [header, ...rows].map((row) => row.map(csvEscape).join(",")).join("\r\n");
  const filename = dateFilter ? `kidz-kingdom-waivers-${dateFilter}.csv` : "kidz-kingdom-waivers.csv";

  // UTF-8 BOM so Excel shows accented names correctly.
  return new Response("\uFEFF" + csv, {
    status: 200,
    headers: {
      "content-type": "text/csv; charset=utf-8",
      "content-disposition": `attachment; filename="${filename}"`,
    },
  });
};

export const config: Config = {
  path: "/api/admin/export",
};
