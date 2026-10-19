import type { Context, Config } from "@netlify/functions";
import { isAuthorized } from "../lib/waiver.mts";
import { birthdaysForMonth, emailConfigured, siteUrlFrom, SendError } from "../lib/email.mts";
import {
  validateSendTime,
  mtLabel,
  createBirthdayJob,
  listBirthdayJobs,
  cancelBirthdayJob,
  loadAutoSettings,
  loadAutoState,
  saveAutoSettings,
  autoPreview,
} from "../lib/schedule.mts";

const json = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json", "cache-control": "no-store" } });

const MAX_KEYS = 500;

// GET  /api/admin/birthday-schedule            scheduled sends + automatic settings
// POST {action:"schedule", month, keys, sendAt}  send these children's emails later
// POST {action:"cancel", id}
// PUT  {enabled, hour, noDay}                  automatic birthday emails
export default async (req: Request, context: Context) => {
  if (!isAuthorized(req)) return json({ error: "Unauthorized" }, 401);

  try {
    if (req.method === "GET") {
      const [jobs, auto, state] = await Promise.all([listBirthdayJobs(), loadAutoSettings(), loadAutoState()]);
      const recent = Date.now() - 30 * 24 * 60 * 60 * 1000;
      return json({
        jobs: jobs
          .filter((j) => j.status === "scheduled" || j.status === "sending" || Date.parse(j.finishedAt || j.scheduledAt) > recent)
          .map(({ siteUrl, lockUntil, ...j }) => ({ ...j, when: mtLabel(j.scheduledAt) })),
        auto,
        autoState: state,
        upcoming: auto.enabled ? await autoPreview(14) : [],
      });
    }

    let b: any;
    try { b = await req.json(); } catch { return json({ error: "Invalid JSON" }, 400); }

    if (req.method === "PUT") {
      const hour = Number(b.hour);
      if (!Number.isInteger(hour) || hour < 0 || hour > 23) return json({ error: "Pick a send time." }, 400);
      if (b.enabled && !emailConfigured()) return json({ error: "Email isn't set up yet." }, 503);
      await saveAutoSettings({ enabled: !!b.enabled, hour, noDay: b.noDay === "skip" ? "skip" : "first" });
      const auto = await loadAutoSettings();
      return json({ auto, upcoming: auto.enabled ? await autoPreview(14) : [] });
    }

    if (req.method === "POST" && b.action === "schedule") {
      if (!emailConfigured()) return json({ error: "Email isn't set up yet." }, 503);
      const month = Number(b.month);
      const keys: string[] = Array.isArray(b.keys) ? [...new Set(b.keys.map(String))] as string[] : [];
      if (!(month >= 1 && month <= 12)) return json({ error: "Pick a month" }, 400);
      if (!keys.length) return json({ error: "Tick at least one child first." }, 400);
      if (keys.length > MAX_KEYS) return json({ error: `Schedule at most ${MAX_KEYS} at a time.` }, 400);
      const t = validateSendTime((b.sendAt || "").toString());
      if ("error" in t) return json({ error: t.error }, 400);
      const { children } = await birthdaysForMonth(month);
      const byKey = new Map(children.map((c) => [c.key, c]));
      const chosen = keys.map((k) => byKey.get(k)).filter(Boolean) as any[];
      if (!chosen.length) return json({ error: "Those children aren't in this month's list any more. Refresh and try again." }, 400);
      const job = await createBirthdayJob(month, chosen, t.at, siteUrlFrom(req));
      return json({ job: { ...job, when: mtLabel(job.scheduledAt) } });
    }

    if (req.method === "POST" && b.action === "cancel") {
      const j = await cancelBirthdayJob((b.id || "").toString());
      return j ? json({ job: j }) : json({ error: "Not found" }, 404);
    }
  } catch (err: any) {
    console.error("birthday-schedule failed", err);
    if (err instanceof SendError) return json({ error: err.message }, 409);
    return json({ error: "Something went wrong. Please try again." }, 500);
  }
  return json({ error: "Method not allowed" }, 405);
};

export const config: Config = { path: "/api/admin/birthday-schedule" };
