import type { Context, Config } from "@netlify/functions";
import { isAuthorized, MT_TZ } from "../lib/waiver.mts";
import { daySummary, historyBetween, isDate, mtDate } from "../lib/checkin.mts";

const json = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json", "cache-control": "no-store" } });

function csvCell(v: unknown) {
  const s = (v ?? "").toString();
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

// GET /api/admin/checkins?date=YYYY-MM-DD           -> one day's counters and lists
// GET /api/admin/checkins?from=YYYY-MM-DD&to=...    -> history (max 3 months)
// add &format=csv to the history request to download it
export default async (req: Request, context: Context) => {
  if (req.method !== "GET") return json({ error: "Method not allowed" }, 405);
  if (!isAuthorized(req)) return json({ error: "Unauthorized" }, 401);
  const q = new URL(req.url).searchParams;

  try {
    if (q.get("from") || q.get("to")) {
      const from = q.get("from") || mtDate();
      const to = q.get("to") || mtDate();
      if (!isDate(from) || !isDate(to) || from > to) return json({ error: "Please pick a valid date range." }, 400);
      const h = await historyBetween(from, to);
      if (q.get("format") === "csv") {
        const rows = [["Date", "Time (Mountain)", "Parent / Guardian", "Phone", "Email", "Children", "Kids", "New waiver that day"]];
        for (const c of h.checkIns) {
          rows.push([
            c.date,
            new Date(c.checkedInAt).toLocaleTimeString("en-US", { timeZone: MT_TZ, hour: "numeric", minute: "2-digit" }),
            c.parentName, c.phone, c.email, c.children.join("; "), String(c.kids), c.newWaiverToday ? "Yes" : "No",
          ]);
        }
        rows.push([]);
        rows.push(["Date", "Checked-in families", "Checked-in kids", "New waivers", "Total entries (families)", "Total entries (kids)"]);
        for (const d of h.days) {
          rows.push([d.date, String(d.checkedIn.families), String(d.checkedIn.kids), String(d.newWaivers.families), String(d.totalEntries.families), String(d.totalEntries.kids)]);
        }
        const csv = "﻿" + rows.map((r) => r.map(csvCell).join(",")).join("\r\n");
        return new Response(csv, {
          headers: {
            "content-type": "text/csv; charset=utf-8",
            "content-disposition": `attachment; filename="kidz-kingdom-checkins-${from}-to-${to}.csv"`,
          },
        });
      }
      return json(h);
    }

    const date = q.get("date") || mtDate();
    if (!isDate(date)) return json({ error: "Invalid date" }, 400);
    return json({ ...(await daySummary(date)), today: mtDate() });
  } catch (err) {
    console.error("checkins failed", err);
    return json({ error: "Could not load check-ins. Please try again." }, 503);
  }
};

export const config: Config = { path: "/api/admin/checkins" };
