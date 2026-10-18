import type { Context, Config } from "@netlify/functions";
import { randomBytes } from "node:crypto";
import { getStore } from "@netlify/blobs";
import { isAuthorized } from "../lib/waiver.mts";
import { siteUrlFrom, imageUrl } from "../lib/email.mts";

const ALLOWED = ["image/jpeg", "image/png", "image/gif", "image/webp"];
const MAX_BYTES = 4 * 1024 * 1024;

const json = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json" } });

// POST /api/admin/email-image   body = the image file, Content-Type = its type.
// The page shrinks photos before uploading, so files are normally a few hundred KB.
export default async (req: Request, context: Context) => {
  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);
  if (!isAuthorized(req)) return json({ error: "Unauthorized" }, 401);

  const type = (req.headers.get("content-type") || "").split(";")[0].trim().toLowerCase();
  if (!ALLOWED.includes(type)) return json({ error: "Please use a JPG, PNG, GIF or WebP image." }, 415);

  const bytes = await req.arrayBuffer();
  if (!bytes.byteLength) return json({ error: "The image was empty." }, 400);
  if (bytes.byteLength > MAX_BYTES) return json({ error: "That image is too large (over 4 MB). Please use a smaller one." }, 413);

  const id = randomBytes(16).toString("hex");
  await getStore({ name: "email-images", consistency: "strong" }).set(id, bytes, {
    metadata: { contentType: type, uploadedAt: new Date().toISOString(), size: bytes.byteLength },
  });
  return json({ imageId: id, url: imageUrl(siteUrlFrom(req), id) });
};

export const config: Config = { path: "/api/admin/email-image" };
