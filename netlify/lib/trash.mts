import { getStore } from "@netlify/blobs";
import { stores, buildSummary, getJSONWithRetry, clearIndexCache, loadIndex } from "./waiver.mts";

// Deleted waivers are never destroyed: they move to a bin and can be put back.
// Every delete and restore is written to an audit log.
const trash = () => getStore({ name: "waiver-trash", consistency: "strong" });
const audit = () => getStore({ name: "audit-log", consistency: "strong" });
const backups = () => getStore({ name: "waiver-backups", consistency: "strong" });

export async function logAudit(action: string, details: Record<string, unknown>) {
  const at = new Date().toISOString();
  await audit().setJSON(`${at}-${Math.random().toString(16).slice(2, 8)}`, { at, action, ...details }).catch(() => {});
}

export async function moveToTrash(id: string, who: string) {
  const s = stores();
  const record: any = await getJSONWithRetry(s.submissions, id, 4);
  if (!record) return false;
  // Saved to the bin first; only then removed from the live list.
  await trash().setJSON(id, { deletedAt: new Date().toISOString(), deletedBy: who, record });
  const check: any = await trash().get(id, { type: "json" });
  if (!check?.record) throw new Error("Could not move the waiver to Recently Deleted; nothing was deleted.");
  await s.submissions.delete(id);
  await s.index.delete(id).catch(() => {});
  await logAudit("delete", { id, who, parentName: record.parentName, phone: record.phone, submittedAt: record.submittedAt });
  return true;
}

export async function listTrash() {
  const { blobs } = await trash().list();
  const all = await Promise.all(blobs.map((b: any) => getJSONWithRetry(trash(), b.key, 3).catch(() => null)));
  return all
    .filter(Boolean)
    .map((t: any) => ({ id: t.record.id, deletedAt: t.deletedAt, deletedBy: t.deletedBy, ...buildSummary(t.record) }))
    .sort((a: any, b: any) => (a.deletedAt < b.deletedAt ? 1 : -1));
}

export async function restoreFromTrash(id: string, who: string) {
  const t: any = await getJSONWithRetry(trash(), id, 4);
  if (!t?.record) return false;
  const s = stores();
  await s.submissions.setJSON(id, t.record);
  await s.index.setJSON(id, buildSummary(t.record));
  await trash().delete(id);
  await clearIndexCache();
  await logAudit("restore", { id, who, parentName: t.record.parentName });
  return true;
}

export async function auditLog(limit = 200) {
  const { blobs } = await audit().list();
  const keys = blobs.map((b: any) => b.key).sort().reverse().slice(0, limit);
  return (await Promise.all(keys.map((k: string) => audit().get(k, { type: "json" }).catch(() => null)))).filter(Boolean);
}

// ---- Daily backups of the waiver list (names, phones, emails, children) ----

export async function writeDailyBackup() {
  const { entries, failed, total } = await loadIndex(20000);
  if (failed > 0 || !entries.length) {
    console.error("backup skipped: incomplete load", failed, total);
    return null;
  }
  const date = new Date().toLocaleDateString("en-CA", { timeZone: "America/Edmonton" });
  const rows = entries.map((e: any) => ({ id: e.id, submittedAt: e.submittedAt, parentName: e.parentName, phone: e.phone, email: e.email, children: e.children }));
  await backups().setJSON(date, { date, count: rows.length, rows });
  // Keep 90 days.
  const { blobs } = await backups().list();
  const cutoff = new Date(Date.now() - 90 * 86400000).toISOString().slice(0, 10);
  for (const b of blobs) if (b.key < cutoff) await backups().delete(b.key).catch(() => {});
  return { date, count: rows.length };
}

// Searches every backup for a phone number or name, to answer "was this
// waiver ever in the list, and when did it disappear?"
export async function searchBackups(q: string) {
  const digits = q.replace(/\D/g, "");
  const words = q.toLowerCase().split(/\s+/).filter((w) => w && !/^\d+$/.test(w));
  const { blobs } = await backups().list();
  const dates = blobs.map((b: any) => b.key).sort();
  const found = new Map<string, { row: any; firstSeen: string; lastSeen: string }>();
  for (const date of dates) {
    const b: any = await backups().get(date, { type: "json" }).catch(() => null);
    for (const r of b?.rows || []) {
      const hay = `${r.parentName} ${(r.children || []).join(" ")} ${r.email}`.toLowerCase();
      const ok = (digits.length >= 4 && (r.phone || "").replace(/\D/g, "").includes(digits)) || (words.length && words.every((w) => hay.includes(w)));
      if (!ok) continue;
      const f = found.get(r.id);
      if (f) f.lastSeen = date;
      else found.set(r.id, { row: r, firstSeen: date, lastSeen: date });
    }
  }
  return { backupDays: dates.length, from: dates[0] || null, to: dates[dates.length - 1] || null, matches: [...found.values()] };
}
