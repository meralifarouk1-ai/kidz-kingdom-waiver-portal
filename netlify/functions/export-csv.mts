import type { Context, Config } from "@netlify/functions";
import { getStore } from "@netlify/blobs";

function isAuthorized(req: Request): boolean {
  const expected = Netlify.env.get("ADMIN_PASSWORD") || "";
  const provided = req.headers.get("x-admin-password") || "";
  return Boolean(expected) && provided === expected;
}

function csvEscape(value: string): string {
  const str = (value ?? "").toString();
  if (/[",\n]/.test(str)) {
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

  const indexStore = getStore("waiver-index");
  let index = (await indexStore.get("index", { type: "json" })) || [];
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

  return new Response(csv, {
    status: 200,
    headers: {
      "content-type": "text/csv",
      "content-disposition": `attachment; filename="${filename}"`,
    },
  });
};

export const config: Config = {
  path: "/api/admin/export",
};
