import { randomBytes } from "node:crypto";
import { getStore } from "@netlify/blobs";
import { MT_TZ, loadIndex, getJSONWithRetry } from "./waiver.mts";

// One blob per check-in, keyed "<YYYY-MM-DD>/<time>-<random>" in Mountain
// Time, so a day's check-ins are listed by prefix and devices checking people
// in at the same moment never overwrite each other.

export type CheckIn = {
  id: string; // the blob key
  waiverId: string;
  date: string; // YYYY-MM-DD, Mountain Time
  checkedInAt: string; // ISO timestamp
  parentName: string;
  phone: string;
  email: string;
  children: string[]; // children who came in
  kids: number;
  newWaiverToday: boolean; // the family signed their waiver the same day
};

const store = () => getStore({ name: "checkins", consistency: "strong" });

export function mtDate(d: Date = new Date()): string {
  return d.toLocaleDateString("en-CA", { timeZone: MT_TZ });
}

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
export const isDate = (s: string) => DATE_RE.test(s) && !Number.isNaN(Date.parse(s + "T12:00:00Z"));
const ID_RE = /^\d{4}-\d{2}-\d{2}\/\d{13}-[a-f0-9]{8}$/;

async function mapLimit<T>(items: T[], limit: number, fn: (x: T) => Promise<void>) {
  let i = 0;
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (i < items.length) await fn(items[i++]);
  }));
}

export async function checkInsForDate(date: string): Promise<CheckIn[]> {
  const s = store();
  const { blobs } = await s.list({ prefix: `${date}/` });
  const out: CheckIn[] = [];
  await mapLimit(blobs, 20, async (b: any) => {
    const v = await getJSONWithRetry(s, b.key, 4).catch(() => null);
    if (v) out.push(v);
  });
  return out.sort((a, b) => (a.checkedInAt < b.checkedInAt ? 1 : -1));
}

function waiverDate(w: any) {
  return mtDate(new Date(w.submittedAt));
}

function childNames(w: any): string[] {
  const details = Array.isArray(w.childDetails) ? w.childDetails : [];
  if (details.length) return details.map((c: any) => `${c.firstName} ${c.lastName}`.trim());
  return Array.isArray(w.children) ? w.children : [];
}

export async function createCheckIn(waiverId: string, children: string[] | null) {
  const { entries } = await loadIndex();
  const w = entries.find((e: any) => e.id === waiverId);
  if (!w) throw new Error("That waiver wasn't found. Refresh and try again.");

  const now = new Date();
  const date = mtDate(now);
  const all = childNames(w);
  // Only names that are on the waiver; default to every child on it.
  const chosen = children === null ? all : all.filter((n) => children.includes(n));
  if (!chosen.length && all.length) throw new Error("Pick at least one child who is coming in.");

  // A double tap (or two devices at once) within 2 minutes returns the existing check-in.
  const today = await checkInsForDate(date);
  const recent = today.find((c) => c.waiverId === waiverId && now.getTime() - Date.parse(c.checkedInAt) < 120000);
  if (recent) return { checkIn: recent, duplicate: true };

  const id = `${date}/${now.getTime()}-${randomBytes(4).toString("hex")}`;
  const c: CheckIn = {
    id,
    waiverId,
    date,
    checkedInAt: now.toISOString(),
    parentName: w.parentName || "",
    phone: w.phone || "",
    email: w.email || "",
    children: chosen,
    kids: chosen.length,
    newWaiverToday: waiverDate(w) === date,
  };
  await store().setJSON(id, c);
  return { checkIn: c, duplicate: false };
}

export async function deleteCheckIn(id: string) {
  if (!ID_RE.test(id)) throw new Error("Invalid check-in");
  await store().delete(id);
}

// The numbers for one day.
// Total entries = new waivers signed that day + check-ins of families who
// signed on an earlier day. A family that signs a new waiver and is also
// checked in on the same day counts once (using the children checked in).
export async function daySummary(date: string) {
  const [checkIns, { entries, failed }] = await Promise.all([checkInsForDate(date), loadIndex()]);
  return { ...summarize(date, checkIns, entries), failedReads: failed };
}

export function summarize(date: string, checkIns: CheckIn[], entries: any[]) {
  const newWaivers = entries.filter((w: any) => waiverDate(w) === date);

  // Latest check-in per family for the day (a family checked in twice is one entry).
  const byWaiver = new Map<string, CheckIn>();
  for (const c of checkIns) if (!byWaiver.has(c.waiverId)) byWaiver.set(c.waiverId, c);
  const newIds = new Set(newWaivers.map((w: any) => w.id));

  let returningFamilies = 0, returningKids = 0;
  for (const c of byWaiver.values()) {
    if (!newIds.has(c.waiverId)) { returningFamilies++; returningKids += c.kids; }
  }
  let newKids = 0, newAlsoCheckedIn = 0;
  for (const w of newWaivers) {
    const c = byWaiver.get(w.id);
    if (c) newAlsoCheckedIn++;
    newKids += c ? c.kids : childNames(w).length;
  }

  const checkedInKids = [...byWaiver.values()].reduce((s, c) => s + c.kids, 0);
  return {
    date,
    checkedIn: { families: byWaiver.size, kids: checkedInKids, scans: checkIns.length },
    newWaivers: {
      families: newWaivers.length,
      kids: newWaivers.reduce((s: number, w: any) => s + childNames(w).length, 0),
      kidsEntered: newKids, // kids actually counted as entries (check-in count if they checked in)
      alsoCheckedIn: newAlsoCheckedIn,
    },
    // Families who checked in on an older waiver. Returning + new = total entries.
    returning: { families: returningFamilies, kids: returningKids },
    totalEntries: { families: newWaivers.length + returningFamilies, kids: newKids + returningKids },
    checkIns,
    newWaiverList: newWaivers.map((w: any) => ({
      waiverId: w.id,
      submittedAt: w.submittedAt,
      parentName: w.parentName,
      phone: w.phone,
      children: childNames(w),
      checkedIn: byWaiver.has(w.id),
    })),
  };
}

// History for a date range: every check-in plus each day's totals.
export async function historyBetween(from: string, to: string) {
  const [checkIns, { entries, failed }] = await Promise.all([checkInsBetween(from, to), loadIndex()]);
  const byDay = new Map<string, CheckIn[]>();
  for (const c of checkIns) {
    if (!byDay.has(c.date)) byDay.set(c.date, []);
    byDay.get(c.date)!.push(c);
  }
  const days = datesBetween(from, to).reverse().map((d) => {
    const s = summarize(d, byDay.get(d) || [], entries);
    return { date: d, checkedIn: s.checkedIn, newWaivers: s.newWaivers, returning: s.returning, totalEntries: s.totalEntries };
  });
  return { from, to, checkIns, days, failedReads: failed };
}

export function datesBetween(from: string, to: string): string[] {
  const out: string[] = [];
  let d = new Date(from + "T12:00:00Z");
  const end = new Date(to + "T12:00:00Z");
  while (d <= end && out.length < 93) {
    out.push(d.toISOString().slice(0, 10));
    d = new Date(d.getTime() + 86400000);
  }
  return out;
}

export async function checkInsBetween(from: string, to: string) {
  const days = datesBetween(from, to);
  const perDay: CheckIn[][] = [];
  await mapLimit(days.map((d, i) => [d, i] as const), 6, async ([d, i]) => {
    perDay[i] = await checkInsForDate(d);
  });
  return perDay.flat().sort((a, b) => (a.checkedInAt < b.checkedInAt ? 1 : -1));
}
