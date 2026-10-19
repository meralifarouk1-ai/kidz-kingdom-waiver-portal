import { randomBytes } from "node:crypto";
import { getStore } from "@netlify/blobs";
import { MT_TZ, MONTHS, getJSONWithRetry } from "./waiver.mts";
import {
  env,
  birthdaysForMonth,
  sentLogForMonth,
  optedOutHashes,
  emailHash,
  loadTemplate,
  buildEmail,
  sendEmail,
  markSent,
  unsubscribeUrl,
  SendError,
  type BirthdayChild,
} from "./email.mts";

// ---------------- Mountain Time helpers ----------------
// Staff pick dates and times in Edmonton time; everything is stored in UTC.

function mtParts(ms: number) {
  const f = new Intl.DateTimeFormat("en-CA", {
    timeZone: MT_TZ,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  });
  const p: Record<string, string> = {};
  for (const x of f.formatToParts(new Date(ms))) p[x.type] = x.value;
  return {
    date: `${p.year}-${p.month}-${p.day}`,
    year: Number(p.year),
    month: Number(p.month),
    day: Number(p.day),
    hour: Number(p.hour),
    minute: Number(p.minute),
    second: Number(p.second),
  };
}

// Minutes Edmonton is ahead of UTC at a given instant (-360 in summer, -420 in winter).
function mtOffsetMinutes(ms: number) {
  const p = mtParts(ms);
  const asUtc = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
  return Math.round((asUtc - Math.floor(ms / 1000) * 1000) / 60000);
}

const LOCAL_RE = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/;

// "2026-11-03T09:30" (Edmonton time) -> Date in UTC, or null if not a real time.
export function mtLocalToUtc(local: string): Date | null {
  const m = LOCAL_RE.exec((local || "").trim());
  if (!m) return null;
  const [y, mo, d, h, mi] = m.slice(1).map(Number);
  const guess = Date.UTC(y, mo - 1, d, h, mi);
  let ms = guess - mtOffsetMinutes(guess) * 60000;
  ms = guess - mtOffsetMinutes(ms) * 60000; // second pass settles daylight-saving edges
  const back = mtParts(ms);
  // Reject impossible dates (Feb 30) and the hour skipped when clocks spring forward.
  if (back.year !== y || back.month !== mo || back.day !== d || back.hour !== h || back.minute !== mi) return null;
  return new Date(ms);
}

export function mtLabel(iso: string | number | Date) {
  return new Date(iso).toLocaleString("en-CA", {
    timeZone: MT_TZ,
    weekday: "short",
    month: "short",
    day: "numeric",
    year: "numeric",
    hour: "numeric",
    minute: "2-digit",
  });
}

export const mtToday = (ms = Date.now()) => mtParts(ms);

// Checks a requested send time: in the future and within a year.
export function validateSendTime(local: string): { at: Date } | { error: string } {
  const at = mtLocalToUtc(local);
  if (!at) return { error: "Please pick a valid date and time." };
  if (at.getTime() < Date.now() + 60 * 1000) return { error: "Please pick a time in the future (Edmonton time)." };
  if (at.getTime() > Date.now() + 366 * 24 * 60 * 60 * 1000) return { error: "Please pick a time within the next year." };
  return { at };
}

// ---------------- Storage ----------------

const store = () => getStore({ name: "birthday-schedule", consistency: "strong" });
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export type BirthdayJob = {
  id: string;
  month: number;
  keys: string[];
  names: string[]; // for showing on the page
  scheduledAt: string; // UTC
  createdAt: string;
  siteUrl: string;
  status: "scheduled" | "sending" | "done" | "cancelled";
  results: Record<string, { result: "sent" | "skipped" | "failed"; reason?: string; at: string }>;
  finishedAt?: string;
  lastError?: string;
  lockUntil?: number;
};

export type AutoSettings = {
  enabled: boolean;
  hour: number; // 0-23, Edmonton time
  noDay: "first" | "skip"; // children with only a birth month on file
  updatedAt?: string;
};

type AutoState = { lastDoneDate?: string; lastRunAt?: string; lastSent?: number; lastError?: string };

const jobKey = (id: string) => `job-${id}`;
const JOB_ID_RE = /^[0-9]{8}-[a-f0-9]{10}$/;

export async function createBirthdayJob(month: number, children: BirthdayChild[], at: Date, siteUrl: string) {
  const id = new Date().toISOString().slice(0, 10).replace(/-/g, "") + "-" + randomBytes(5).toString("hex");
  const job: BirthdayJob = {
    id,
    month,
    keys: children.map((c) => c.key),
    names: children.map((c) => `${c.childFirstName} ${c.childLastName}`.trim()),
    scheduledAt: at.toISOString(),
    createdAt: new Date().toISOString(),
    siteUrl,
    status: "scheduled",
    results: {},
  };
  await store().setJSON(jobKey(id), job);
  return job;
}

export async function getBirthdayJob(id: string): Promise<BirthdayJob | null> {
  if (!JOB_ID_RE.test(id)) return null;
  return getJSONWithRetry(store(), jobKey(id), 4).catch(() => null);
}

const saveJob = (j: BirthdayJob) => store().setJSON(jobKey(j.id), j);

export async function listBirthdayJobs(): Promise<BirthdayJob[]> {
  const { blobs } = await store().list({ prefix: "job-" });
  const all = await Promise.all(blobs.map((b: any) => getJSONWithRetry(store(), b.key, 3).catch(() => null)));
  return (all.filter(Boolean) as BirthdayJob[]).sort((a, b) => (a.scheduledAt < b.scheduledAt ? -1 : 1));
}

export async function cancelBirthdayJob(id: string) {
  const j = await getBirthdayJob(id);
  if (!j) return null;
  if (j.status !== "scheduled") throw new SendError("This send has already started, so it can't be cancelled.");
  j.status = "cancelled";
  await saveJob(j);
  return j;
}

export async function loadAutoSettings(): Promise<AutoSettings> {
  const s: any = await store().get("auto-settings", { type: "json" }).catch(() => null);
  return {
    enabled: !!s?.enabled,
    hour: Number.isInteger(s?.hour) && s.hour >= 0 && s.hour <= 23 ? s.hour : 9,
    noDay: s?.noDay === "skip" ? "skip" : "first",
    updatedAt: s?.updatedAt,
  };
}

export async function loadAutoState(): Promise<AutoState> {
  return ((await store().get("auto-state", { type: "json" }).catch(() => null)) as AutoState) || {};
}

export async function saveAutoSettings(s: AutoSettings) {
  const prev = await loadAutoSettings();
  await store().setJSON("auto-settings", { enabled: s.enabled, hour: s.hour, noDay: s.noDay, updatedAt: new Date().toISOString() });
  if (s.enabled && !prev.enabled) {
    // Start from today: earlier days are never back-filled.
    const state = await loadAutoState();
    await store().setJSON("auto-state", { ...state, lastDoneDate: prevDate(mtToday().date), lastError: undefined });
  }
}

// ---------------- Sending birthday emails ----------------

type Deadline = { until: number };

// Sends to the given children (already filtered for the month), skipping
// anyone already emailed for this birthday, unsubscribed or without an email.
// Stops early when time runs out; whatever is left goes out on the next run.
async function sendBirthdays(
  month: number,
  wanted: BirthdayChild[],
  siteUrl: string,
  dl: Deadline,
  onResult: (key: string, result: "sent" | "skipped" | "failed", reason?: string) => void
): Promise<{ finished: boolean; sent: number }> {
  if (!wanted.length) return { finished: true, sent: 0 };
  const birthdayYear = wanted[0].birthdayYear;
  const [already, optedOut, template] = await Promise.all([sentLogForMonth(birthdayYear, month), optedOutHashes(), loadTemplate()]);
  let sent = 0;
  for (const c of wanted) {
    if (already.has(c.key)) { onResult(c.key, "skipped", "Already sent"); continue; }
    if (!EMAIL_RE.test(c.email)) { onResult(c.key, "skipped", "No valid email"); continue; }
    if (optedOut.has(emailHash(c.email))) { onResult(c.key, "skipped", "Unsubscribed"); continue; }
    if (Date.now() > dl.until) return { finished: false, sent };
    const unsub = unsubscribeUrl(siteUrl, c.email);
    const started = Date.now();
    try {
      await sendEmail(c.email, buildEmail(template, c, unsub, false, siteUrl), unsub);
      already.set(c.key, { sentAt: new Date().toISOString() });
      await markSent(c).catch((e) => console.error("markSent failed", c.key, e));
      onResult(c.key, "sent");
      sent++;
    } catch (err: any) {
      const reason = err instanceof SendError ? err.message : "Sending failed.";
      // A login, domain or plan-limit problem would fail every other email too.
      if (err instanceof SendError && err.stopAll) throw err;
      onResult(c.key, "failed", reason);
    }
    // Stay well under Resend's requests-per-second limit.
    const wait = 550 - (Date.now() - started);
    if (wait > 0) await sleep(wait);
  }
  return { finished: true, sent };
}

async function runBirthdayJob(j: BirthdayJob, dl: Deadline) {
  const now = Date.now();
  if (j.lockUntil && j.lockUntil > now) return;
  j.status = "sending";
  j.lockUntil = dl.until + 15000;
  await saveJob(j);
  try {
    const { children } = await birthdaysForMonth(j.month);
    const byKey = new Map(children.map((c) => [c.key, c]));
    const todo: BirthdayChild[] = [];
    for (const k of j.keys) {
      if (j.results[k]) continue;
      const c = byKey.get(k);
      if (!c) j.results[k] = { result: "skipped", reason: "No longer in this month's list", at: new Date().toISOString() };
      else todo.push(c);
    }
    const { finished } = await sendBirthdays(j.month, todo, j.siteUrl, dl, (key, result, reason) => {
      j.results[key] = { result, reason, at: new Date().toISOString() };
    });
    if (finished) {
      j.status = "done";
      j.finishedAt = new Date().toISOString();
    }
    j.lastError = undefined;
  } catch (err: any) {
    j.lastError = err instanceof SendError ? err.message : "Sending stopped unexpectedly; it will try again in a few minutes.";
    console.error("birthday job error", j.id, err);
  } finally {
    j.lockUntil = 0;
    await saveJob(j);
  }
}

function prevDate(date: string) {
  const d = new Date(date + "T12:00:00Z");
  d.setUTCDate(d.getUTCDate() - 1);
  return d.toISOString().slice(0, 10);
}
function nextDate(date: string) {
  const d = new Date(date + "T12:00:00Z");
  d.setUTCDate(d.getUTCDate() + 1);
  return d.toISOString().slice(0, 10);
}
const isLeap = (y: number) => (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0;

// Children whose birthday email belongs on this date (Edmonton calendar).
function dueOn(date: string, children: BirthdayChild[], noDay: AutoSettings["noDay"]) {
  const y = Number(date.slice(0, 4)), day = Number(date.slice(8, 10)), month = Number(date.slice(5, 7));
  return children.filter((c) => {
    if (!c.birthDay) return noDay === "first" && day === 1;
    // Feb 29 birthdays are celebrated on Feb 28 in other years.
    if (month === 2 && c.birthDay === 29 && !isLeap(y)) return day === 28;
    return c.birthDay === day;
  });
}

// Automatic mode: on each day, at the chosen hour, email every child whose
// birthday it is. Catches up on missed days (up to a week) if needed.
async function runAutoBirthdays(dl: Deadline) {
  const settings = await loadAutoSettings();
  if (!settings.enabled) return;
  const now = mtToday();
  const state = await loadAutoState();
  let date = state.lastDoneDate ? nextDate(state.lastDoneDate) : now.date;
  const weekAgo = (() => { let d = now.date; for (let i = 0; i < 7; i++) d = prevDate(d); return d; })();
  if (date < weekAgo) date = weekAgo;

  let sentTotal = 0;
  try {
    while (date <= now.date) {
      if (date === now.date && now.hour < settings.hour) break; // not time yet today
      const month = Number(date.slice(5, 7));
      const { children } = await birthdaysForMonth(month, Number(date.slice(0, 4)));
      const due = dueOn(date, children, settings.noDay);
      const { finished, sent } = await sendBirthdays(month, due, env("URL") || "https://kidzkingdomqr.com", dl, () => {});
      sentTotal += sent;
      if (!finished) break; // out of time; the next run carries on
      state.lastDoneDate = date;
      date = nextDate(date);
    }
    state.lastError = undefined;
  } catch (err: any) {
    state.lastError = err instanceof SendError ? err.message : "Automatic birthday emails hit a problem; retrying in a few minutes.";
    console.error("auto birthdays error", err);
  }
  state.lastRunAt = new Date().toISOString();
  if (sentTotal) state.lastSent = sentTotal;
  await store().setJSON("auto-state", state);
}

export async function runBirthdaySchedules(dl: Deadline) {
  const jobs = await listBirthdayJobs();
  const now = Date.now();
  for (const j of jobs) {
    if (Date.now() > dl.until) return;
    if (j.status === "scheduled" ? Date.parse(j.scheduledAt) <= now : j.status === "sending") {
      await runBirthdayJob(j, dl);
    }
  }
  if (Date.now() < dl.until) await runAutoBirthdays(dl);
}

// Upcoming automatic emails for the next N days, for the page.
export async function autoPreview(days = 14) {
  const settings = await loadAutoSettings();
  const out: { date: string; names: string[] }[] = [];
  const today = mtToday();
  let date = today.date;
  const byMonth = new Map<number, BirthdayChild[]>();
  for (let i = 0; i < days; i++) {
    const month = Number(date.slice(5, 7));
    if (!byMonth.has(month)) byMonth.set(month, (await birthdaysForMonth(month, Number(date.slice(0, 4)))).children);
    const due = dueOn(date, byMonth.get(month)!, settings.noDay);
    if (due.length) out.push({ date, names: due.map((c) => `${c.childFirstName} ${c.childLastName}`.trim()) });
    date = nextDate(date);
  }
  return out;
}

export function monthName(m: number) {
  return MONTHS[m - 1] || "";
}
