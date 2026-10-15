// Shared helpers for the waiver functions. Lives outside netlify/functions so
// it is bundled into each function rather than deployed as its own endpoint.

export const MT_TZ = "America/Edmonton";

export const MONTHS = [
  "January", "February", "March", "April", "May", "June",
  "July", "August", "September", "October", "November", "December",
];

export type ChildDetail = {
  firstName: string;
  lastName: string;
  birthMonth: number; // 1-12
  birthYear: number;
};

// Current waiver wording version. Version 1 = original wording (before
// 2026-10-15). Version 2 = wording that covers both the parent/guardian and
// the children. Records keep the version they were signed under so the PDF
// always reproduces the exact text that family agreed to.
export const CURRENT_WAIVER_VERSION = 2;

export function waiverVersionOf(record: any): number {
  return Number(record?.waiverVersion) || 1;
}

export function childDetailsOf(record: any): ChildDetail[] {
  return Array.isArray(record?.childDetails) ? record.childDetails : [];
}

export function childFullName(c: ChildDetail): string {
  return `${c.firstName} ${c.lastName}`.trim();
}

export function birthLabel(c: ChildDetail): string {
  const m = MONTHS[(c.birthMonth || 0) - 1];
  return m && c.birthYear ? `${m} ${c.birthYear}` : "";
}

// Index summary written for every submission (used by list / export / birthdays).
export function buildSummary(record: any) {
  return {
    id: record.id,
    submittedAt: record.submittedAt,
    waiverVersion: waiverVersionOf(record),
    parentName: record.parentName,
    parentFirstName: record.parentFirstName || "",
    parentLastName: record.parentLastName || "",
    phone: record.phone,
    email: record.email,
    children: record.children || [],
    childDetails: childDetailsOf(record),
  };
}

export function isAuthorized(req: Request): boolean {
  const expected = Netlify.env.get("ADMIN_PASSWORD") || "";
  const provided = req.headers.get("x-admin-password") || "";
  return Boolean(expected) && provided === expected;
}

// Reads every per-submission index entry, newest first.
export async function loadIndex(indexStore: any): Promise<any[]> {
  const { blobs } = await indexStore.list();
  const index: any[] = [];
  const BATCH_SIZE = 150;
  for (let i = 0; i < blobs.length; i += BATCH_SIZE) {
    const batch = blobs.slice(i, i + BATCH_SIZE);
    const results = await Promise.all(
      batch.map(({ key }: any) => indexStore.get(key, { type: "json" }).catch(() => null))
    );
    for (const entry of results) {
      if (entry && (entry as any).id) index.push(entry);
    }
  }
  index.sort((a, b) => (a.submittedAt < b.submittedAt ? 1 : -1));
  return index;
}

// ---------------- Waiver wording, by version ----------------

export const RULES = [
  "Children must wear grip socks at all times; adults must wear socks.",
  "Adults are not permitted on the play structure.",
  "No food or beverages are permitted within the soft play area.",
  "All participants must sanitize hands prior to entering the play area.",
  "Wristbands must be retained for same-day re-entry.",
  "Parent/guardian must supervise children at all times unless participating in a supervised program.",
  "If a parent/guardian cannot be located, mall security will be contacted.",
];

const SURVEILLANCE =
  "I acknowledge that Kidz Kingdom Inc. uses video and audio surveillance for safety and security purposes. Recordings are handled in accordance with applicable Alberta privacy laws, and footage may be blurred, muted, or redacted where required to protect the privacy of others.";

type Clause = { num: number; key: string; title: string; body?: string; rules?: string[] };

const CLAUSES_V1: Clause[] = [
  { num: 2, key: "assumptionOfRisk", title: "Assumption of Risk",
    body: "I acknowledge that participation in activities at Kidz Kingdom INC involves inherent risks including slips, falls, collisions, and injuries. I voluntarily assume all risks." },
  { num: 3, key: "releaseOfLiability", title: "Release of Liability",
    body: "To the fullest extent permitted under Alberta law, I release and hold harmless Kidz Kingdom INC, its owners, employees, affiliates, and all locations from any claims arising from participation." },
  { num: 4, key: "rulesRegulations", title: "Rules & Regulations", rules: RULES },
  { num: 5, key: "supervision", title: "Supervision",
    body: "I am responsible for the supervision of my child unless enrolled in a supervised program." },
  { num: 6, key: "emergencyMedical", title: "Emergency Medical Consent",
    body: "I authorize staff to administer basic first aid and contact emergency services if required." },
  { num: 7, key: "indemnity", title: "Indemnity",
    body: "I agree to indemnify and hold harmless Kidz Kingdom INC, its owners, employees, affiliates, and all locations from any claims, demands, or actions arising from my child's participation." },
  { num: 8, key: "governingLaw", title: "Governing Law",
    body: "This agreement shall be governed by and interpreted in accordance with the laws of the Province of Alberta." },
  { num: 9, key: "surveillance", title: "Photo, Video & Audio Surveillance", body: SURVEILLANCE },
];

const CLAUSES_V2: Clause[] = [
  { num: 2, key: "assumptionOfRisk", title: "Assumption of Risk",
    body: "I acknowledge that being present at and participating in activities at Kidz Kingdom INC involves inherent risks, including slips, falls, collisions, and injuries, both for me as the parent/guardian and for the children listed above. On behalf of myself and those children, I voluntarily assume all risks." },
  { num: 3, key: "releaseOfLiability", title: "Release of Liability",
    body: "To the fullest extent permitted under Alberta law, on behalf of myself and the children listed above, I release and hold harmless Kidz Kingdom INC, its owners, employees, affiliates, and all locations from any claims arising from our presence at or participation in activities at Kidz Kingdom, including any injury to me as the parent/guardian or to the children." },
  { num: 4, key: "rulesRegulations", title: "Rules & Regulations", rules: RULES },
  { num: 5, key: "supervision", title: "Supervision",
    body: "I am responsible for my own safety and for the supervision of the children listed above unless they are enrolled in a supervised program." },
  { num: 6, key: "emergencyMedical", title: "Emergency Medical Consent",
    body: "I authorize staff to administer basic first aid to me or to the children listed above, and to contact emergency services if required." },
  { num: 7, key: "indemnity", title: "Indemnity",
    body: "I agree to indemnify and hold harmless Kidz Kingdom INC, its owners, employees, affiliates, and all locations from any claims, demands, or actions arising from my own or the children's presence at or participation in activities at Kidz Kingdom." },
  { num: 8, key: "governingLaw", title: "Governing Law",
    body: "This agreement shall be governed by and interpreted in accordance with the laws of the Province of Alberta, Canada." },
  { num: 9, key: "surveillance", title: "Photo, Video & Audio Surveillance", body: SURVEILLANCE },
];

const FINAL_V1 =
  "I have read and understand this agreement, I have had the opportunity to ask questions, and I voluntarily agree to all terms. This agreement shall be governed by and interpreted in accordance with the laws of the Province of Alberta.";

const FINAL_V2 =
  "I have read and understood this agreement fully. I have also had an opportunity to ask questions, and this waiver applies to us both: the parent/guardian and the children. This agreement is governed by the laws of Alberta, Canada.";

export function wordingFor(version: number): { clauses: Clause[]; finalStatement: string } {
  return version >= 2
    ? { clauses: CLAUSES_V2, finalStatement: FINAL_V2 }
    : { clauses: CLAUSES_V1, finalStatement: FINAL_V1 };
}
