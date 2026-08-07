import type { Context, Config } from "@netlify/functions";
import { getStore } from "@netlify/blobs";

const REQUIRED_INITIALS = [
  "assumptionOfRisk",
  "releaseOfLiability",
  "rulesRegulations",
  "supervision",
  "emergencyMedical",
  "indemnity",
  "governingLaw",
  "surveillance",
];

export default async (req: Request, context: Context) => {
  if (req.method !== "POST") {
    return new Response(JSON.stringify({ error: "Method not allowed" }), { status: 405 });
  }

  let body: any;
  try {
    body = await req.json();
  } catch {
    return new Response(JSON.stringify({ error: "Invalid JSON body" }), { status: 400 });
  }

  const parentName = (body.parentName || "").toString().trim();
  const phone = (body.phone || "").toString().trim();
  const email = (body.email || "").toString().trim();
  const printedName = (body.printedName || "").toString().trim();
  const signature = (body.signature || "").toString();
  const children = Array.isArray(body.children)
    ? body.children.map((c: any) => (c || "").toString().trim()).filter(Boolean).slice(0, 4)
    : [];
  const initials = body.initials || {};
  const rulesAcknowledged = body.rulesAcknowledged === true;

  const missing: string[] = [];
  if (!parentName) missing.push("parentName");
  if (!phone) missing.push("phone");
  if (!email) missing.push("email");
  if (!printedName) missing.push("printedName");
  if (!signature.startsWith("data:image/")) missing.push("signature");
  if (children.length === 0) missing.push("children");
  if (!rulesAcknowledged) missing.push("rulesAcknowledged");
  for (const key of REQUIRED_INITIALS) {
    if (!initials[key] || !initials[key].toString().trim()) missing.push(`initials.${key}`);
  }

  if (missing.length > 0) {
    return new Response(JSON.stringify({ error: "Missing required fields", missing }), { status: 400 });
  }

  const id = crypto.randomUUID();
  const submittedAt = new Date().toISOString();

  const record = {
    id,
    submittedAt,
    parentName,
    phone,
    email,
    children,
    initials: Object.fromEntries(REQUIRED_INITIALS.map((k) => [k, initials[k].toString().trim()])),
    rulesAcknowledged,
    printedName,
    signature,
  };

  const submissionsStore = getStore("waiver-submissions");
  await submissionsStore.setJSON(id, record);

  const indexStore = getStore("waiver-index");
  const existingIndex = (await indexStore.get("index", { type: "json" })) || [];
  const summary = {
    id,
    submittedAt,
    parentName,
    phone,
    email,
    children,
  };
  existingIndex.push(summary);
  await indexStore.setJSON("index", existingIndex);

  return new Response(JSON.stringify({ success: true, id }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
};

export const config: Config = {
  path: "/api/submit",
};
