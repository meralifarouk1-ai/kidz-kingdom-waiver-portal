import { getStore } from "@netlify/blobs";

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

// ---------------- Loading the waiver list ----------------
//
// The submissions store ("waiver-submissions") is the source of truth: one
// full record per waiver. "waiver-index" holds a small summary per waiver.
// Reading hundreds of summaries one by one is slow and some reads get
// throttled, so:
//   * every read is retried, and a read that still fails is reported, never
//     silently dropped;
//   * a combined snapshot of all summaries is cached, so a normal load only
//     reads the waivers added since the last load;
//   * a waiver with no summary (e.g. the summary write failed) is rebuilt
//     from its full record and its summary repaired;
//   * strong consistency, so a waiver shows up as soon as it's submitted.

const STRONG = { consistency: "strong" as const };

export function stores() {
  return {
    submissions: getStore({ name: "waiver-submissions", ...STRONG }),
    index: getStore({ name: "waiver-index", ...STRONG }),
    cache: getStore({ name: "waiver-index-cache", ...STRONG }),
  };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// Retries a read with backoff. Gives up early if `deadline` (epoch ms) would
// be passed, so a function never runs into Netlify's time limit.
export async function getJSONWithRetry(
  store: any,
  key: string,
  tries = 5,
  deadline = Number.POSITIVE_INFINITY
): Promise<any> {
  let lastErr: unknown;
  for (let i = 0; i < tries; i++) {
    try {
      return await store.get(key, { type: "json" });
    } catch (err) {
      lastErr = err;
      const wait = 200 * 2 ** i + Math.random() * 200;
      if (i === tries - 1 || Date.now() + wait > deadline) break;
      await sleep(wait);
    }
  }
  throw lastErr;
}

async function listKeys(store: any): Promise<string[]> {
  let lastErr: unknown;
  for (let i = 0; i < 4; i++) {
    try {
      const { blobs } = await store.list();
      return blobs.map((b: any) => b.key);
    } catch (err) {
      lastErr = err;
      await sleep(300 * 2 ** i);
    }
  }
  throw lastErr;
}

async function mapLimit<T>(items: T[], limit: number, fn: (item: T) => Promise<void>) {
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const item = items[next++];
      await fn(item);
    }
  });
  await Promise.all(workers);
}

export type IndexLoad = { entries: any[]; total: number; failed: number };

// Returns every waiver summary, newest first. `failed` counts waivers that
// could not be read even after retries; callers must not treat a load with
// failed > 0 as complete.
export async function loadIndex(budgetMs = 8000): Promise<IndexLoad> {
  const deadline = Date.now() + budgetMs;
  const s = stores();
  const [subKeys, idxKeys, snapshot] = await Promise.all([
    listKeys(s.submissions),
    listKeys(s.index),
    getJSONWithRetry(s.cache, "snapshot", 3, deadline).catch(() => null),
  ]);

  const submissionIds = new Set(subKeys);
  const indexIds = new Set(idxKeys);
  const byId = new Map<string, any>();

  // 1. Cached summaries (dropping any whose waiver has since been deleted).
  let staleInCache = false;
  for (const e of snapshot?.entries || []) {
    if (e && submissionIds.has(e.id)) byId.set(e.id, e);
    else staleInCache = true;
  }

  const failedIds = new Set<string>();

  // 2. Summaries added since the snapshot was built.
  const newIndexIds = subKeys.filter((id) => !byId.has(id) && indexIds.has(id));
  await mapLimit(newIndexIds, 20, async (id) => {
    if (Date.now() > deadline) return void failedIds.add(id);
    try {
      const e = await getJSONWithRetry(s.index, id, 5, deadline);
      if (e && e.id) byId.set(e.id, e);
    } catch {
      failedIds.add(id);
    }
  });

  // 3. Waivers with no usable summary: rebuild from the full record.
  const orphanIds = subKeys.filter((id) => !byId.has(id) && !failedIds.has(id));
  await mapLimit(orphanIds, 8, async (id) => {
    if (Date.now() > deadline) return void failedIds.add(id);
    try {
      const record = await getJSONWithRetry(s.submissions, id, 5, deadline);
      if (!record || !record.id) return;
      const summary = buildSummary(record);
      byId.set(record.id, summary);
      await s.index.setJSON(record.id, summary).catch(() => {});
    } catch {
      failedIds.add(id);
    }
  });

  const entries = [...byId.values()].sort((a, b) => (a.submittedAt < b.submittedAt ? 1 : -1));

  // Save whatever was read, even if some reads failed: the cache only holds
  // valid summaries, and anything missing is simply read again next time.
  const changed = staleInCache || newIndexIds.length > 0 || orphanIds.length > 0 || !snapshot;
  if (changed && entries.length > 0) {
    await s.cache
      .setJSON("snapshot", { builtAt: new Date().toISOString(), entries })
      .catch(() => {});
  }

  return { entries, total: submissionIds.size, failed: failedIds.size };
}

export async function clearIndexCache() {
  await stores().cache.delete("snapshot").catch(() => {});
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
