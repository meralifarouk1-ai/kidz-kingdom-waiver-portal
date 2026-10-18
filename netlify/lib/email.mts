import { createHash, createHmac, timingSafeEqual } from "node:crypto";
import nodemailer from "nodemailer";
import { getStore } from "@netlify/blobs";
import { MONTHS, MT_TZ, loadIndex, childDetailsOf, getJSONWithRetry } from "./waiver.mts";

// ---------------- Settings ----------------

export const TEST_EMAIL = "kidzkingdom2023@gmail.com";

function env(name: string, fallback = ""): string {
  return (Netlify.env.get(name) || fallback).trim();
}

// Gmail by default: only SMTP_PASS (a Gmail app password) has to be set in
// Netlify. Everything else can be overridden with environment variables.
function smtpConfig() {
  const user = env("SMTP_USER", TEST_EMAIL);
  return {
    host: env("SMTP_HOST", "smtp.gmail.com"),
    port: Number(env("SMTP_PORT", "465")),
    user,
    pass: env("SMTP_PASS").replace(/\s+/g, ""), // app passwords are shown with spaces
    fromName: env("EMAIL_FROM_NAME", "Kidz Kingdom"),
    fromAddress: env("EMAIL_FROM", user),
  };
}

// Two ways to send:
//  * Resend (preferred): set RESEND_API_KEY. Emails come from
//    birthdays@kidzkingdomqr.com once that domain is verified in Resend.
//  * Gmail SMTP (fallback): set SMTP_PASS to a Gmail app password.
export const BIRTHDAY_FROM = "birthdays@kidzkingdomqr.com";
export const REPLY_TO = TEST_EMAIL; // parents' replies land in the Kidz Kingdom Gmail inbox

function resendKey(): string {
  return env("RESEND_API_KEY");
}

export function emailProvider(): "resend" | "gmail" | null {
  if (resendKey()) return "resend";
  if (smtpConfig().pass) return "gmail";
  return null;
}

export function emailConfigured(): boolean {
  return emailProvider() !== null;
}

export function senderAddress(): string {
  return emailProvider() === "resend" ? env("EMAIL_FROM", BIRTHDAY_FROM) : smtpConfig().fromAddress;
}

// Error with a message staff can act on.
export class SendError extends Error {
  stopAll: boolean;
  constructor(message: string, stopAll = false) {
    super(message);
    this.stopAll = stopAll;
  }
}

let transport: any = null;
function getTransport() {
  if (!transport) {
    const c = smtpConfig();
    transport = nodemailer.createTransport({
      host: c.host,
      port: c.port,
      secure: c.port === 465,
      auth: { user: c.user, pass: c.pass },
      connectionTimeout: 8000,
      greetingTimeout: 8000,
      socketTimeout: 10000,
      pool: true,
      maxConnections: 2,
    });
  }
  return transport;
}

// ---------------- Template ----------------

export type EmailTemplate = { subject: string; body: string; footerAddress: string };

export const DEFAULT_TEMPLATE: EmailTemplate = {
  subject: "Happy Birthday, {child_first_name}! 🎉",
  body: [
    "Hi {parent_first_name},",
    "",
    "Everyone at Kidz Kingdom wants to wish {child_first_name} a very happy {age_ordinal} birthday! 🎂",
    "",
    "We'd love to help celebrate. Come and play with us at Kidz Kingdom this {birthday_month}.",
    "",
    "With love,",
    "The Kidz Kingdom Team",
  ].join("\n"),
  footerAddress: "Kidz Kingdom INC, Southgate Centre, Edmonton, Alberta, Canada",
};

export const PLACEHOLDERS = [
  ["{child_first_name}", "Child's first name"],
  ["{child_last_name}", "Child's last name"],
  ["{child_name}", "Child's full name"],
  ["{age}", "Age they're turning, e.g. 7"],
  ["{age_ordinal}", "e.g. 7th"],
  ["{birthday_month}", "e.g. October"],
  ["{parent_first_name}", "Parent's first name"],
  ["{parent_name}", "Parent's full name"],
];

const settingsStore = () => getStore({ name: "email-settings", consistency: "strong" });

export async function loadTemplate(): Promise<EmailTemplate> {
  const saved: any = await settingsStore().get("birthday-template", { type: "json" }).catch(() => null);
  return {
    subject: saved?.subject ?? DEFAULT_TEMPLATE.subject,
    body: saved?.body ?? DEFAULT_TEMPLATE.body,
    footerAddress: saved?.footerAddress ?? DEFAULT_TEMPLATE.footerAddress,
  };
}

export async function saveTemplate(t: EmailTemplate) {
  await settingsStore().setJSON("birthday-template", { ...t, updatedAt: new Date().toISOString() });
}

function ordinal(n: number): string {
  const s = ["th", "st", "nd", "rd"];
  const v = n % 100;
  return n + (s[(v - 20) % 10] || s[v] || s[0]);
}

export type BirthdayChild = {
  key: string;
  childFirstName: string;
  childLastName: string;
  birthMonth: number;
  birthYear: number;
  birthdayYear: number; // the year of the birthday being celebrated
  age: number;
  parentFirstName: string;
  parentName: string;
  email: string;
  phone: string;
};

export function fillTemplate(text: string, c: BirthdayChild): string {
  const values: Record<string, string> = {
    child_first_name: c.childFirstName,
    child_last_name: c.childLastName,
    child_name: `${c.childFirstName} ${c.childLastName}`.trim(),
    age: String(c.age),
    age_ordinal: ordinal(c.age),
    birthday_month: MONTHS[c.birthMonth - 1] || "",
    parent_first_name: c.parentFirstName || "there",
    parent_name: c.parentName || c.parentFirstName || "",
  };
  return text.replace(/\{([a-z_]+)\}/gi, (m, k) => (k.toLowerCase() in values ? values[k.toLowerCase()] : m));
}

export const SAMPLE_CHILD: BirthdayChild = {
  key: "sample",
  childFirstName: "Zara",
  childLastName: "Khan",
  birthMonth: 10,
  birthYear: 2019,
  birthdayYear: 2026,
  age: 7,
  parentFirstName: "Amina",
  parentName: "Amina Khan",
  email: TEST_EMAIL,
  phone: "",
};

// ---------------- Unsubscribe ----------------

function unsubscribeSecret(): string {
  return env("UNSUBSCRIBE_SECRET") || env("ADMIN_PASSWORD") || "kidz-kingdom";
}

export function emailHash(email: string): string {
  return createHash("sha256").update(email.trim().toLowerCase()).digest("hex").slice(0, 40);
}

export function unsubscribeToken(email: string): string {
  return createHmac("sha256", unsubscribeSecret()).update(email.trim().toLowerCase()).digest("hex").slice(0, 32);
}

export function verifyUnsubscribe(email: string, token: string): boolean {
  const expected = Buffer.from(unsubscribeToken(email));
  const given = Buffer.from((token || "").slice(0, 32));
  return expected.length === given.length && timingSafeEqual(expected, given);
}

export function unsubscribeUrl(siteUrl: string, email: string): string {
  return `${siteUrl}/api/unsubscribe?e=${encodeURIComponent(email)}&t=${unsubscribeToken(email)}`;
}

const optoutStore = () => getStore({ name: "email-optout", consistency: "strong" });

export async function optOut(email: string) {
  await optoutStore().setJSON(emailHash(email), { at: new Date().toISOString() });
}

export async function optedOutHashes(): Promise<Set<string>> {
  const { blobs } = await optoutStore().list();
  return new Set(blobs.map((b: any) => b.key));
}

// ---------------- Sent log ----------------

const sentStore = () => getStore({ name: "birthday-sent", consistency: "strong" });

// One record per child per birthday, keyed "<year>-<month>-<child>", so a
// month's records can be listed by prefix.
function monthPrefix(birthdayYear: number, month: number) {
  return `${birthdayYear}-${String(month).padStart(2, "0")}-`;
}
function sentKey(c: { key: string; birthdayYear: number; birthMonth: number }) {
  return monthPrefix(c.birthdayYear, c.birthMonth) + c.key;
}

// Child key -> { sentAt, to } for everyone already emailed for this birthday.
export async function sentLogForMonth(birthdayYear: number, month: number): Promise<Map<string, any>> {
  const store = sentStore();
  const prefix = monthPrefix(birthdayYear, month);
  const { blobs } = await store.list({ prefix });
  const out = new Map<string, any>();
  await Promise.all(
    blobs.map(async (b: any) => {
      const v = await getJSONWithRetry(store, b.key, 4).catch(() => ({ sentAt: null }));
      out.set(b.key.slice(prefix.length), v || { sentAt: null });
    })
  );
  return out;
}

export async function markSent(c: BirthdayChild) {
  await sentStore().setJSON(sentKey(c), { sentAt: new Date().toISOString(), to: c.email });
}

// ---------------- Birthday list ----------------

function childKey(first: string, last: string, month: number, year: number) {
  return createHash("sha256")
    .update([first, last, month, year].join("|").trim().toLowerCase())
    .digest("hex")
    .slice(0, 24);
}

// Children with a birthday in `month`, one row per child (deduplicated across
// waivers, newest contact details win). The birthday year is this year for
// this month or later, and next year for months that have already passed.
export async function birthdaysForMonth(month: number) {
  const { entries, failed } = await loadIndex();
  const now = new Date().toLocaleDateString("en-CA", { timeZone: MT_TZ });
  const thisYear = Number(now.slice(0, 4));
  const thisMonth = Number(now.slice(5, 7));
  const birthdayYear = month >= thisMonth ? thisYear : thisYear + 1;

  const seen = new Set<string>();
  const children: BirthdayChild[] = [];
  for (const item of entries) {
    for (const c of childDetailsOf(item)) {
      if (Number(c.birthMonth) !== month) continue;
      const key = childKey(c.firstName, c.lastName, c.birthMonth, c.birthYear);
      if (seen.has(key)) continue;
      seen.add(key);
      const parentName = item.parentName || "";
      children.push({
        key,
        childFirstName: c.firstName,
        childLastName: c.lastName,
        birthMonth: c.birthMonth,
        birthYear: c.birthYear,
        birthdayYear,
        age: birthdayYear - c.birthYear,
        parentFirstName: item.parentFirstName || parentName.split(" ")[0] || "",
        parentName,
        email: (item.email || "").trim(),
        phone: item.phone || "",
      });
    }
  }
  children.sort((a, b) =>
    `${a.childFirstName} ${a.childLastName}`.localeCompare(`${b.childFirstName} ${b.childLastName}`)
  );
  return { children, birthdayYear, failed };
}

// ---------------- Sending ----------------

function escapeHtml(s: string) {
  return s.replace(/[&<>"']/g, (ch) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[ch]!));
}

export function buildEmail(t: EmailTemplate, c: BirthdayChild, unsubscribeLink: string, isTest = false) {
  const subject = (isTest ? "[TEST] " : "") + fillTemplate(t.subject, c).replace(/[\r\n]+/g, " ").trim();
  const body = fillTemplate(t.body, c);
  const footer =
    `${t.footerAddress}\n` +
    `You're receiving this because you registered your family at Kidz Kingdom.\n` +
    `Unsubscribe: ${unsubscribeLink}`;
  const text = `${body}\n\n--\n${footer}`;

  const paragraphs = escapeHtml(body)
    .split(/\n{2,}/)
    .map((p) => `<p style="margin:0 0 14px">${p.replace(/\n/g, "<br>")}</p>`)
    .join("");
  const html = `<!doctype html><html><body style="margin:0;background:#faf7ff;font-family:-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif;color:#2a1a3d">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background:#faf7ff;padding:24px 12px"><tr><td align="center">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:560px;background:#ffffff;border-radius:18px;border:1px solid #e7ddf7">
<tr><td style="background:linear-gradient(135deg,#7c3aed,#ec4899);border-radius:18px 18px 0 0;padding:26px 24px;text-align:center;color:#ffffff;font-size:22px;font-weight:700">🎂 Happy Birthday, ${escapeHtml(c.childFirstName)}! 🎉</td></tr>
<tr><td style="padding:26px 26px 10px;font-size:16px;line-height:1.55">${paragraphs}</td></tr>
<tr><td style="padding:14px 26px 24px;border-top:1px solid #f0eaf9;font-size:12px;line-height:1.5;color:#7a6f8c">
${escapeHtml(t.footerAddress)}<br>You're receiving this because you registered your family at Kidz Kingdom.<br>
<a href="${escapeHtml(unsubscribeLink)}" style="color:#7a6f8c">Unsubscribe from these emails</a></td></tr>
</table></td></tr></table></body></html>`;
  return { subject, text, html };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function sendWithResend(to: string, msg: { subject: string; text: string; html: string }, unsubscribeLink: string) {
  const fromName = env("EMAIL_FROM_NAME", "Kidz Kingdom");
  const payload = {
    from: `${fromName} <${senderAddress()}>`,
    to: [to],
    reply_to: [env("EMAIL_REPLY_TO", REPLY_TO)],
    subject: msg.subject,
    text: msg.text,
    html: msg.html,
    headers: {
      "List-Unsubscribe": `<${unsubscribeLink}>`,
      "List-Unsubscribe-Post": "List-Unsubscribe=One-Click",
    },
  };
  for (let attempt = 0; attempt < 4; attempt++) {
    const res = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: { Authorization: `Bearer ${resendKey()}`, "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
    if (res.ok) return;
    const data: any = await res.json().catch(() => ({}));
    const detail = `${data?.name || ""} ${data?.message || ""}`.trim();
    console.error("resend error", res.status, detail);
    if (res.status === 401 || /api key/i.test(detail)) {
      throw new SendError("Resend rejected the API key. Check RESEND_API_KEY in Netlify.", true);
    }
    if (res.status === 403 || /not verified|verify/i.test(detail)) {
      throw new SendError(
        "The kidzkingdomqr.com domain isn't verified in Resend yet. Finish the DNS step in Resend, then try again.",
        true
      );
    }
    if (/daily|quota|monthly/i.test(detail)) {
      throw new SendError("Resend's sending limit was reached (free plan: 100 a day). Send the rest tomorrow.", true);
    }
    if (res.status === 429 || res.status >= 500) {
      await sleep(600 * 2 ** attempt);
      continue;
    }
    throw new SendError(detail ? `Resend couldn't send this email: ${detail}` : "Sending failed. Please try again.");
  }
  throw new SendError("Resend is busy right now. Please try again in a minute.");
}

export async function sendEmail(to: string, msg: { subject: string; text: string; html: string }, unsubscribeLink: string) {
  if (emailProvider() === "resend") return sendWithResend(to, msg, unsubscribeLink);
  const c = smtpConfig();
  await getTransport().sendMail({
    from: { name: c.fromName, address: c.fromAddress },
    to,
    replyTo: env("EMAIL_REPLY_TO", c.fromAddress),
    subject: msg.subject,
    text: msg.text,
    html: msg.html,
    headers: {
      "List-Unsubscribe": `<${unsubscribeLink}>`,
      "List-Unsubscribe-Post": "List-Unsubscribe=One-Click",
    },
  });
}

export function siteUrlFrom(req: Request): string {
  return env("URL") || new URL(req.url).origin;
}
