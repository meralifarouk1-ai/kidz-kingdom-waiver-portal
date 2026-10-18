import type { Context, Config } from "@netlify/functions";
import { getStore } from "@netlify/blobs";
import { IMAGE_ID_RE } from "../lib/email.mts";

// GET /api/email-image/<id>: public, because parents' email apps load the
// picture from here. Uploaded images never change, so they're cached for a year.
export default async (req: Request, context: Context) => {
  const id = (context.params?.id || "").toString();
  if (!IMAGE_ID_RE.test(id)) return new Response("Not found", { status: 404 });
  const result: any = await getStore({ name: "email-images", consistency: "strong" })
    .getWithMetadata(id, { type: "arrayBuffer" })
    .catch(() => null);
  if (!result?.data) return new Response("Not found", { status: 404 });
  return new Response(result.data, {
    status: 200,
    headers: {
      "content-type": result.metadata?.contentType || "image/jpeg",
      "cache-control": "public, max-age=31536000, immutable",
    },
  });
};

export const config: Config = { path: "/api/email-image/:id" };
