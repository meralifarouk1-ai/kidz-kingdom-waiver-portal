import type { Context, Config } from "@netlify/functions";
import { getStore } from "@netlify/blobs";
import { buildSummary, CURRENT_WAIVER_VERSION, type ChildDetail } from "../lib/waiver.mts";

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

  const str = (v: any) => (v ?? "").toString().trim();

  // New form sends first/last names and childDetails (waiver version 2).
  // A parent who still has the old page open sends parentName + children;
  // accept that as a version 1 waiver, since that's the wording they saw.
  const isLegacy = !Array.isArray(body.childDetails) && Array.isArray(body.children);
  const waiverVersion = isLegacy ? 1 : CURRENT_WAIVER_VERSION;

  const parentFirstName = isLegacy ? "" : str(body.parentFirstName);
  const parentLastName = isLegacy ? "" : str(body.parentLastName);
  const parentName = isLegacy ? str(body.parentName) : `${parentFirstName} ${parentLastName}`.trim();

  const thisYear = new Date().getFullYear();
  let childDetails: ChildDetail[] = [];
  let childErrors = false;
  if (!isLegacy && Array.isArray(body.childDetails)) {
    childDetails = body.childDetails.slice(0, 4).map((c: any) => ({
      firstName: str(c?.firstName),
      lastName: str(c?.lastName),
      birthMonth: Number(c?.birthMonth),
      // Day was added later; an older cached form may not send it.
      ...(c?.birthDay !== undefined && c?.birthDay !== "" ? { birthDay: Number(c.birthDay) } : {}),
      birthYear: Number(c?.birthYear),
    }));
    childErrors = childDetails.some(
      (c) =>
        !c.firstName || !c.lastName ||
        !Number.isInteger(c.birthMonth) || c.birthMonth < 1 || c.birthMonth > 12 ||
        !Number.isInteger(c.birthYear) || c.birthYear < thisYear - 25 || c.birthYear > thisYear ||
        (c.birthDay !== undefined &&
          (!Number.isInteger(c.birthDay) || c.birthDay < 1 ||
            c.birthDay > new Date(Date.UTC(c.birthYear, c.birthMonth, 0)).getUTCDate()))
    );
  }

  const phone = (body.phone || "").toString().trim();
  const email = (body.email || "").toString().trim();
  const printedName = (body.printedName || "").toString().trim();
  const signature = (body.signature || "").toString();
  const children: string[] = isLegacy
    ? body.children.map((c: any) => str(c)).filter(Boolean).slice(0, 4)
    : childDetails.map((c) => `${c.firstName} ${c.lastName}`);
  const initials = body.initials || {};
  const rulesAcknowledged = body.rulesAcknowledged === true;

  const missing: string[] = [];
  if (isLegacy) {
    if (!parentName) missing.push("parentName");
  } else {
    if (!parentFirstName) missing.push("parentFirstName");
    if (!parentLastName) missing.push("parentLastName");
    if (childErrors) missing.push("childDetails");
  }
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
    waiverVersion,
    parentName,
    parentFirstName,
    parentLastName,
    phone,
    email,
    children,
    childDetails,
    initials: Object.fromEntries(REQUIRED_INITIALS.map((k) => [k, initials[k].toString().trim()])),
    rulesAcknowledged,
    printedName,
    signature,
  };

  // The full record is what matters: if this fails the parent sees an error
  // and can resubmit. The summary below is a convenience; if it fails the
  // admin list rebuilds it from the full record.
  const submissionsStore = getStore("waiver-submissions");
  await submissionsStore.setJSON(id, record);

  const summary = buildSummary(record);

  // Each submission's index entry is its own blob, keyed by id - no shared
  // mutable state to read-modify-write, so concurrent submissions never
  // contend with each other and this write is always O(1).
  const indexStore = getStore("waiver-index");
  try {
    await indexStore.setJSON(id, summary);
  } catch (err) {
    console.error("submit: summary write failed (record saved)", id, err);
  }

  return new Response(JSON.stringify({ success: true, id }), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
};

export const config: Config = {
  path: "/api/submit",
};
