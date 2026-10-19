import { randomBytes } from "node:crypto";
import { getStore } from "@netlify/blobs";
import { loadIndex, getJSONWithRetry } from "./waiver.mts";
import {
  env,
  resendKey,
  escapeHtml,
  emailHash,
  optedOutHashes,
  unsubscribeUrl,
  imageUrl,
  IMAGE_ID_RE,
  loadTemplate,
  TEST_EMAIL,
  SendError,
} from "./email.mts";

// ---------------- Settings ----------------

export const MARKETING_FROM = "noreply@kidzkingdomqr.com";
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
// Canada's anti-spam law (CASL): a purchase gives implied consent for two
// years, so families whose latest waiver is older than that are left out.
const CONSENT_DAYS = 730;
const BATCH_SIZE = 100; // Resend's batch limit
const BATCHES_PER_CALL = 3; // keeps each call well inside the function time limit

export function marketingFrom(): string {
  return env("MARKETING_FROM", MARKETING_FROM);
}

const store = () => getStore({ name: "marketing", consistency: "strong" });

export type MarketingSettings = { footerAddress: string; contactLine: string };
export type Draft = { subject: string; body: string; updatedAt?: string };

export async function loadSettings(): Promise<MarketingSettings> {
  const saved: any = await store().get("settings", { type: "json" }).catch(() => null);
  const birthday = await loadTemplate().catch(() => null);
  return {
    footerAddress: saved?.footerAddress || birthday?.footerAddress || "Kidz Kingdom INC, Southgate Centre, Edmonton, Alberta, Canada",
    contactLine: saved?.contactLine || `Questions? Email us at ${TEST_EMAIL}`,
  };
}

export async function saveSettings(s: MarketingSettings) {
  await store().setJSON("settings", s);
}

export const DEFAULT_DRAFT: Draft = {
  subject: "Something fun is happening at Kidz Kingdom! 🎉",
  body: [
    "Hi {parent_first_name},",
    "",
    "Write your news or promotion here.",
    "",
    "See you soon,",
    "The Kidz Kingdom Team",
  ].join("\n"),
};

export async function loadDraft(): Promise<Draft> {
  const d: any = await store().get("draft", { type: "json" }).catch(() => null);
  return { subject: d?.subject ?? DEFAULT_DRAFT.subject, body: d?.body ?? DEFAULT_DRAFT.body, updatedAt: d?.updatedAt };
}

export async function saveDraft(d: Draft) {
  await store().setJSON("draft", { subject: d.subject, body: d.body, updatedAt: new Date().toISOString() });
}

// ---------------- Audience ----------------

export type Recipient = { email: string; firstName: string; name: string };

// Every unique email from the waivers, newest details first, minus anyone
// unsubscribed, with an invalid email, or whose latest waiver is too old.
export async function buildAudience() {
  const { entries, failed, total } = await loadIndex();
  const optedOut = await optedOutHashes();
  const cutoff = Date.now() - CONSENT_DAYS * 24 * 60 * 60 * 1000;

  const seen = new Set<string>();
  const recipients: Recipient[] = [];
  let unsubscribed = 0, invalid = 0, tooOld = 0;
  const invalidSeen = new Set<string>();

  for (const item of entries) {
    const raw = (item.email || "").trim();
    const email = raw.toLowerCase();
    if (!EMAIL_RE.test(email)) {
      if (!invalidSeen.has(email)) { invalidSeen.add(email); invalid++; }
      continue;
    }
    if (seen.has(email)) continue;
    seen.add(email);
    if (new Date(item.submittedAt).getTime() < cutoff) { tooOld++; continue; }
    if (optedOut.has(emailHash(email))) { unsubscribed++; continue; }
    const name = (item.parentName || "").trim();
    recipients.push({ email: raw, firstName: item.parentFirstName || name.split(" ")[0] || "", name });
  }
  return { recipients, excluded: { unsubscribed, invalid, tooOld }, failedReads: failed, waivers: total };
}

// ---------------- Building the email ----------------

const IMAGE_TOKEN = /^\s*\[\[image:([a-f0-9]{32})\]\]\s*$/;

function fill(text: string, r: { firstName: string; name: string }) {
  const values: Record<string, string> = {
    parent_first_name: r.firstName || "there",
    parent_name: r.name || r.firstName || "",
  };
  return text.replace(/\{([a-z_]+)\}/gi, (m, k) => (k.toLowerCase() in values ? values[k.toLowerCase()] : m));
}

function linkify(escaped: string) {
  return escaped.replace(
    /\b(https?:\/\/[^\s<]+[^\s<.,;:!?)\]])/g,
    (u) => `<a href="${u}" style="color:#7c3aed;font-weight:600">${u}</a>`
  );
}

export function buildMarketingEmail(
  draft: { subject: string; body: string },
  settings: MarketingSettings,
  r: Recipient,
  siteUrl: string,
  isTest = false
) {
  const unsub = unsubscribeUrl(siteUrl, r.email);
  const subject = (isTest ? "[TEST] " : "") + fill(draft.subject, r).replace(/[\r\n]+/g, " ").trim();
  const body = fill(draft.body.replace(/\r\n/g, "\n"), r);

  // Split into paragraphs and pictures. A picture is a line of its own: [[image:<id>]]
  const blocks: { type: "p" | "img"; value: string }[] = [];
  let para: string[] = [];
  const flush = () => {
    if (para.join("").trim()) blocks.push({ type: "p", value: para.join("\n").trim() });
    para = [];
  };
  for (const line of body.split("\n")) {
    const m = IMAGE_TOKEN.exec(line);
    if (m) { flush(); blocks.push({ type: "img", value: m[1] }); }
    else if (!line.trim()) flush();
    else para.push(line);
  }
  flush();

  const htmlBlocks = blocks
    .map((b) => {
      if (b.type === "img") {
        const src = imageUrl(siteUrl, b.value);
        return src
          ? `<tr><td style="padding:6px 26px 14px"><img src="${escapeHtml(src)}" alt="" width="508" style="display:block;width:100%;max-width:508px;height:auto;border:0;border-radius:12px"></td></tr>`
          : "";
      }
      return `<tr><td style="padding:0 26px 14px;font-size:16px;line-height:1.55">${linkify(escapeHtml(b.value)).replace(/\n/g, "<br>")}</td></tr>`;
    })
    .join("\n");

  const text =
    blocks.filter((b) => b.type === "p").map((b) => b.value).join("\n\n") +
    `\n\n--\n${settings.footerAddress}\n${settings.contactLine}\n` +
    `This is an automated email. Please don't reply to it.\n` +
    `You're receiving this because you registered your family at Kidz Kingdom.\nUnsubscribe: ${unsub}`;

  const logo = `${siteUrl}/assets/logo.png`;
  const html = `<!doctype html><html><body style="margin:0;background:#faf7ff;font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;color:#2a1a3d">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#faf7ff;padding:24px 12px"><tr><td align="center">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;background:#ffffff;border-radius:18px;border:1px solid #e7ddf7">
<tr><td style="padding:22px 26px 12px;text-align:center"><img src="${escapeHtml(logo)}" alt="Kidz Kingdom" height="56" style="height:56px;border:0"></td></tr>
<tr><td style="height:4px;background:linear-gradient(90deg,#7c3aed,#ec4899);font-size:0;line-height:0">&nbsp;</td></tr>
<tr><td style="height:18px;font-size:0;line-height:0">&nbsp;</td></tr>
${htmlBlocks}
<tr><td style="padding:14px 26px 24px;border-top:1px solid #f0eaf9;font-size:12px;line-height:1.5;color:#7a6f8c">
${escapeHtml(settings.footerAddress)}<br>${escapeHtml(settings.contactLine)}<br>
This is an automated email. Please don't reply to it.<br>
You're receiving this because you registered your family at Kidz Kingdom.<br>
<a href="${escapeHtml(unsub)}" style="color:#7a6f8c">Unsubscribe from these emails</a></td></tr>
</table></td></tr></table></body></html>`;

  return {
    from: `${env("EMAIL_FROM_NAME", "Kidz Kingdom")} <${marketingFrom()}>`,
    to: [r.email],
    subject,
    text,
    html,
    headers: {
      "List-Unsubscribe": `<${unsub}>`,
      "List-Unsubscribe-Post": "List-Unsubscribe=One-Click",
    },
  };
}

export function imageIdsIn(body: string): string[] {
  return body.split("\n").map((l) => IMAGE_TOKEN.exec(l)?.[1]).filter((x): x is string => !!x && IMAGE_ID_RE.test(x));
}

// ---------------- Sending through Resend's batch API ----------------

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function classify(status: number, detail: string): SendError | null {
  if (status === 401 || /api key/i.test(detail)) return new SendError("Resend rejected the API key. Check RESEND_API_KEY in Netlify.", true);
  if (status === 403 || /not verified|verify/i.test(detail)) return new SendError("The kidzkingdomqr.com domain isn't verified in Resend.", true);
  // Resend reports both "too fast" and "plan limit reached" as 429, so tell
  // them apart by the error name (daily_quota_exceeded / monthly_quota_exceeded).
  if (/quota/i.test(detail)) {
    return new SendError("Resend's sending limit for your plan was reached. Sending is paused; press Resume once the limit resets or after upgrading the Resend plan.", true);
  }
  return null;
}

// Sends up to 100 emails in one call. The idempotency key means a retried
// batch is never delivered twice (Resend remembers keys for 24 hours).
export async function sendBatch(emails: any[], idempotencyKey: string): Promise<{ ok: true } | { ok: false; status: number; detail: string }> {
  for (let attempt = 0; attempt < 4; attempt++) {
    const res = await fetch("https://api.resend.com/emails/batch", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${resendKey()}`,
        "Content-Type": "application/json",
        "Idempotency-Key": idempotencyKey,
      },
      body: JSON.stringify(emails),
    });
    if (res.ok) return { ok: true };
    const data: any = await res.json().catch(() => ({}));
    const detail = `${data?.name || ""} ${data?.message || ""}`.trim();
    console.error("resend batch error", res.status, detail);
    const fatal = classify(res.status, detail);
    if (fatal) throw fatal;
    if (res.status === 429 || res.status >= 500) {
      await sleep(800 * 2 ** attempt);
      continue;
    }
    return { ok: false, status: res.status, detail };
  }
  // Not a permanent problem, so scheduled sends simply try again on the next run.
  throw new SendError("Resend is busy right now. Sending is paused; press Resume in a minute.", false);
}

// ---------------- Campaigns ----------------

export type Campaign = {
  id: string;
  subject: string;
  body: string;
  settings: MarketingSettings;
  siteUrl: string;
  createdAt: string;
  startedAt?: string;
  finishedAt?: string;
  status: "scheduled" | "sending" | "paused" | "done" | "cancelled";
  scheduledAt?: string; // UTC; set for scheduled campaigns
  estimate?: number; // audience size when it was scheduled
  auto?: boolean; // sent by the background scheduler (no page needs to stay open)
  userPaused?: boolean;
  total: number;
  cursor: number; // recipients handled so far (sent or failed)
  sent: number;
  failed: number;
  skipped: number; // unsubscribed after the campaign started
  failures: { email: string; reason: string }[];
  lastError?: string;
  lockUntil?: number;
};

const campaignKey = (id: string) => `campaign-${id}`;
const recipientsKey = (id: string) => `recipients-${id}`;

const newCampaignId = () => new Date().toISOString().slice(0, 10).replace(/-/g, "") + "-" + randomBytes(5).toString("hex");

// A campaign to go out later. The audience is worked out when it starts, so
// families who sign a waiver (or unsubscribe) in the meantime are counted.
export async function scheduleCampaign(draft: Draft, settings: MarketingSettings, siteUrl: string, at: Date) {
  const { recipients } = await buildAudience();
  const c: Campaign = {
    id: newCampaignId(),
    subject: draft.subject,
    body: draft.body,
    settings,
    siteUrl,
    createdAt: new Date().toISOString(),
    scheduledAt: at.toISOString(),
    estimate: recipients.length,
    status: "scheduled",
    auto: true,
    total: 0,
    cursor: 0,
    sent: 0,
    failed: 0,
    skipped: 0,
    failures: [],
  };
  await store().setJSON(campaignKey(c.id), c);
  return c;
}

export async function cancelCampaign(id: string) {
  const c = await getCampaign(id);
  if (!c) return null;
  if (c.status !== "scheduled") throw new SendError("This email has already started sending, so it can't be cancelled. You can pause it instead.");
  c.status = "cancelled";
  await saveCampaign(c);
  return c;
}

// Freezes the audience of a scheduled campaign when its time comes.
async function startScheduled(c: Campaign) {
  const { recipients } = await buildAudience();
  await store().setJSON(recipientsKey(c.id), recipients);
  c.status = "sending";
  c.total = recipients.length;
  c.startedAt = new Date().toISOString();
  if (!c.total) { c.status = "done"; c.finishedAt = c.startedAt; }
  await saveCampaign(c);
}

export async function createCampaign(draft: Draft, settings: MarketingSettings, siteUrl: string) {
  const { recipients } = await buildAudience();
  const id = newCampaignId();
  const c: Campaign = {
    id,
    subject: draft.subject,
    body: draft.body,
    settings,
    siteUrl,
    createdAt: new Date().toISOString(),
    status: "sending",
    total: recipients.length,
    cursor: 0,
    sent: 0,
    failed: 0,
    skipped: 0,
    failures: [],
  };
  // The recipient list is frozen when the campaign starts, so pausing and
  // resuming (even days later) sends to exactly the same people once each.
  await store().setJSON(recipientsKey(id), recipients);
  await store().setJSON(campaignKey(id), c);
  return c;
}

export async function getCampaign(id: string): Promise<Campaign | null> {
  if (!/^[0-9]{8}-[a-f0-9]{10}$/.test(id)) return null;
  return getJSONWithRetry(store(), campaignKey(id), 4).catch(() => null);
}

export async function saveCampaign(c: Campaign) {
  await store().setJSON(campaignKey(c.id), c);
}

export async function listCampaigns() {
  const { blobs } = await store().list({ prefix: "campaign-" });
  const all = await Promise.all(blobs.map((b: any) => getJSONWithRetry(store(), b.key, 3).catch(() => null)));
  return (all.filter(Boolean) as Campaign[])
    .map(({ body, settings, failures, ...summary }) => ({ ...summary, failureCount: failures?.length || 0 }))
    .sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
}

// Sends the next few batches of a campaign and records progress.
// By default (the page's "send" loop) a few batches per call; the background
// scheduler passes a bigger budget.
export async function continueCampaign(id: string, opts: { maxBatches?: number; budgetMs?: number; fromScheduler?: boolean } = {}) {
  const maxBatches = opts.maxBatches ?? BATCHES_PER_CALL;
  const budgetMs = opts.budgetMs ?? 7000;
  const c = await getCampaign(id);
  if (!c) throw new SendError("That campaign wasn't found.");
  if (c.status === "done" || c.status === "cancelled") return c;
  if (c.status === "scheduled") throw new SendError("This email is scheduled and hasn't started yet.");
  const now = Date.now();
  if (c.lockUntil && c.lockUntil > now) {
    if (opts.fromScheduler) return c;
    throw new SendError("This campaign is already being sent from another window. Please wait.");
  }
  c.status = "sending";
  c.lastError = undefined;
  if (!opts.fromScheduler) c.userPaused = false; // someone pressed Resume
  c.lockUntil = now + budgetMs + 18000;
  await saveCampaign(c);

  const recipients: Recipient[] = (await getJSONWithRetry(store(), recipientsKey(id), 4)) || [];
  const optedOut = await optedOutHashes(); // honour unsubscribes that arrive mid-campaign
  const deadline = now + budgetMs;

  try {
    for (let n = 0; n < maxBatches && c.cursor < recipients.length && Date.now() < deadline; n++) {
      if (n > 0) await sleep(550); // stay under Resend's requests-per-second limit
      const start = c.cursor;
      const chunk = recipients.slice(start, start + BATCH_SIZE);
      const sendable = chunk.filter((r) => !optedOut.has(emailHash(r.email)));
      const skipped = chunk.length - sendable.length;
      if (sendable.length) {
        const emails = sendable.map((r) => buildMarketingEmail(c, c.settings, r, c.siteUrl));
        const result = await sendBatch(emails, `kk-mkt/${c.id}-${start}`);
        if (result.ok) {
          c.sent += sendable.length;
        } else {
          // One bad address fails a whole batch, so send that batch one by one
          // to find it and still deliver to everyone else.
          // Counts are only recorded once the whole batch is through; if time
          // runs out part-way, the retry replays the same idempotency keys, so
          // nobody gets a second copy and nothing is counted twice.
          let ok = 0;
          const bad: { email: string; reason: string }[] = [];
          for (let i = 0; i < sendable.length; i++) {
            if (Date.now() > deadline + 9000) throw new SendError("Sending was split across runs; it carries on shortly.", false);
            const one = await sendBatch([emails[i]], `kk-mkt/${c.id}-${start}-${i}`);
            if (one.ok) ok++;
            else bad.push({ email: sendable[i].email, reason: one.detail || `error ${one.status}` });
          }
          c.sent += ok;
          c.failed += bad.length;
          for (const f of bad) if (c.failures.length < 200) c.failures.push(f);
        }
      }
      c.skipped = (c.skipped || 0) + skipped;
      c.cursor = start + chunk.length;
      await saveCampaign(c);
    }
    if (c.cursor >= recipients.length) {
      c.status = "done";
      c.finishedAt = new Date().toISOString();
    } else {
      // Not finished. Page-driven sends: the page calls again straight away;
      // if it was closed, the campaign shows a Resume button. Scheduled sends
      // carry on by themselves on the scheduler's next run.
      c.status = c.auto ? "sending" : "paused";
    }
  } catch (err: any) {
    const fatal = !(err instanceof SendError) || err.stopAll;
    // Scheduled sends retry passing problems on the next run; anything that
    // needs a person (API key, domain, plan limit) pauses until Resume.
    c.status = c.auto && !fatal ? "sending" : "paused";
    c.lastError = err instanceof SendError ? err.message : "Sending stopped unexpectedly. Press Resume to continue.";
    if (c.auto && !fatal) c.lastError += " (It will try again automatically in a few minutes.)";
    console.error("campaign paused", id, err);
  } finally {
    c.lockUntil = 0;
    await saveCampaign(c);
  }
  return c;
}

export async function pauseCampaign(id: string) {
  const c = await getCampaign(id);
  if (!c || c.status === "done" || c.status === "scheduled" || c.status === "cancelled") return c;
  c.status = "paused";
  c.userPaused = true;
  c.lockUntil = 0;
  await saveCampaign(c);
  return c;
}

export function publicCampaign(c: Campaign) {
  const { body, settings, ...rest } = c;
  return rest;
}

// ---------------- Background scheduler ----------------

// Starts scheduled campaigns whose time has come and keeps scheduled sends
// going until done (the page doesn't need to stay open).
export async function runMarketingSchedules(until: number) {
  const { blobs } = await store().list({ prefix: "campaign-" });
  const all = (await Promise.all(blobs.map((b: any) => getJSONWithRetry(store(), b.key, 3).catch(() => null)))).filter(Boolean) as Campaign[];
  const now = Date.now();
  const due = all
    .filter((c) => (c.status === "scheduled" && Date.parse(c.scheduledAt || "") <= now) || (c.auto && c.status === "sending" && !c.userPaused))
    .sort((a, b) => ((a.scheduledAt || a.createdAt) < (b.scheduledAt || b.createdAt) ? -1 : 1));
  for (const c of due) {
    if (Date.now() > until - 3000) return;
    try {
      if (c.status === "scheduled") await startScheduled(c);
      if (c.status === "sending") {
        await continueCampaign(c.id, { maxBatches: 60, budgetMs: Math.max(0, until - Date.now() - 2000), fromScheduler: true });
      }
    } catch (err) {
      console.error("scheduled campaign error", c.id, err);
    }
  }
}
