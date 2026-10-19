import { createHash, randomBytes, scrypt as _scrypt, timingSafeEqual } from "node:crypto";
import { promisify } from "node:util";
import { getStore } from "@netlify/blobs";

// Two kinds of staff login:
//  * "admin"     (Super Admin): the ADMIN_PASSWORD set in Netlify. Full access.
//  * "frontdesk": a password the Super Admin sets on the Staff Access tab.
//                 Can only search waivers and check families in.
// Every endpoint decides for itself which roles it accepts, so a front-desk
// login can't reach anything else even by calling the website directly.

export type Role = "admin" | "frontdesk";

const scrypt = promisify(_scrypt) as (pw: string, salt: Buffer, len: number) => Promise<Buffer>;
const store = () => getStore({ name: "staff-access", consistency: "strong" });

function safeEqual(a: string, b: string) {
  const x = Buffer.from(a), y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}

type FrontDeskRecord = { salt: string; hash: string; updatedAt: string; version: number };

// Cache of passwords already checked against the current record version, so a
// busy front desk doesn't re-hash on every request.
let recordCache: { at: number; value: FrontDeskRecord | null } | null = null;
const verified = new Map<string, { at: number; version: number }>();

// The record is read on every request (one small, fast read) so a password
// change or switch-off takes effect immediately on every device.
async function frontDeskRecord(): Promise<FrontDeskRecord | null> {
  const v = (await store().get("frontdesk", { type: "json" }).catch(() => null)) as FrontDeskRecord | null;
  recordCache = { at: Date.now(), value: v && v.hash ? v : null };
  return recordCache.value;
}

async function isFrontDeskPassword(pw: string): Promise<boolean> {
  if (!pw) return false;
  const rec = await frontDeskRecord();
  if (!rec) return false;
  const key = createHash("sha256").update(pw).digest("hex");
  const hit = verified.get(key);
  if (hit && hit.version === rec.version && Date.now() - hit.at < 300000) return true;
  const hash = (await scrypt(pw, Buffer.from(rec.salt, "hex"), 32)).toString("hex");
  const ok = safeEqual(hash, rec.hash);
  if (ok) verified.set(key, { at: Date.now(), version: rec.version });
  return ok;
}

export async function roleForPassword(pw: string): Promise<Role | null> {
  const admin = Netlify.env.get("ADMIN_PASSWORD") || "";
  if (admin && pw && safeEqual(pw, admin)) return "admin";
  if (await isFrontDeskPassword(pw)) return "frontdesk";
  return null;
}

export function roleFor(req: Request): Promise<Role | null> {
  return roleForPassword(req.headers.get("x-admin-password") || "");
}

// ---- Managing the front-desk password (Super Admin only) ----

export async function frontDeskStatus() {
  recordCache = null;
  const rec = await frontDeskRecord();
  return { enabled: !!rec, updatedAt: rec?.updatedAt || null };
}

export async function setFrontDeskPassword(pw: string) {
  const admin = Netlify.env.get("ADMIN_PASSWORD") || "";
  if (pw.length < 6) throw new Error("Please use at least 6 characters.");
  if (admin && safeEqual(pw, admin)) throw new Error("The Front Desk password must be different from the Super Admin password.");
  const prev = await frontDeskRecord();
  const salt = randomBytes(16);
  const hash = (await scrypt(pw, salt, 32)).toString("hex");
  const rec: FrontDeskRecord = {
    salt: salt.toString("hex"),
    hash,
    updatedAt: new Date().toISOString(),
    version: (prev?.version || 0) + 1,
  };
  await store().setJSON("frontdesk", rec);
  recordCache = null;
  verified.clear();
}

export async function disableFrontDesk() {
  await store().delete("frontdesk");
  recordCache = null;
  verified.clear();
}
