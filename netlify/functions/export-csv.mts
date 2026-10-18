import type { Context, Config } from "@netlify/functions";
import {
  MT_TZ,
  MONTHS,
  isAuthorized,
  loadIndex,
  childDetailsOf,
  childFullName,
  birthLabel,
} from "../lib/waiver.mts";

function csvEscape(value: unknown): string {
  const str = (value ?? "").toString();
  if (/[",\r\n]/.test(str)) {
    return `"${str.replace(/"/g, '""')}"`;
  }
  return str;
}

function toCsv(rows: unknown[][]): string {
  // UTF-8 BOM so Excel shows accented names correctly.
  return "﻿" + rows.map((row) => row.map(csvEscape).join(",")).join("\r\n");
}

function csvResponse(csv: string, filename: string): Response {
  return new Response(csv, {
    status: 200,
    headers: {
      "content-type": "text/csv; charset=utf-8",
      "content-disposition": `attachment; filename="${filename}"`,
    },
  });
}

export default async (req: Request, context: Context) => {
  if (req.method !== "GET") {
    return new Response(JSON.stringify({ error: "Method not allowed" }), { status: 405 });
  }

  if (!isAuthorized(req)) {
    return new Response(JSON.stringify({ error: "Unauthorized" }), { status: 401 });
  }

  const url = new URL(req.url);
  const dateFilter = url.searchParams.get("date") || "";
  const birthMonth = Number(url.searchParams.get("birthMonth") || 0);

  let loaded;
  try {
    loaded = await loadIndex();
  } catch (err) {
    console.error("export: load failed", err);
    loaded = null;
  }
  if (!loaded || loaded.failed > 0) {
    // Never hand out a partial export as if it were complete.
    return new Response(
      JSON.stringify({ error: "Some waivers could not be loaded. Please try the export again." }),
      { status: 503, headers: { "content-type": "application/json" } }
    );
  }
  let index = loaded.entries;

  // ---- Birthday list: one row per child born in the chosen month ----
  if (birthMonth >= 1 && birthMonth <= 12) {
    const thisYear = Number(new Date().toLocaleDateString("en-CA", { timeZone: MT_TZ }).slice(0, 4));
    const seen = new Set<string>();
    const rows: unknown[][] = [];
    // index is newest first, so the most recent contact details win for
    // families who have signed more than one waiver.
    for (const item of index) {
      for (const c of childDetailsOf(item)) {
        if (c.birthMonth !== birthMonth) continue;
        const key = [c.firstName, c.lastName, c.birthMonth, c.birthYear].join("|").toLowerCase();
        if (seen.has(key)) continue;
        seen.add(key);
        rows.push([
          c.firstName,
          c.lastName,
          MONTHS[c.birthMonth - 1],
          c.birthYear,
          thisYear - c.birthYear,
          item.parentFirstName || item.parentName,
          item.parentLastName,
          item.email,
          item.phone,
        ]);
      }
    }
    rows.sort((a, b) => `${a[0]} ${a[1]}`.localeCompare(`${b[0]} ${b[1]}`));
    const header = [
      "Child First Name",
      "Child Last Name",
      "Birth Month",
      "Birth Year",
      `Turning (${thisYear})`,
      "Parent First Name",
      "Parent Last Name",
      "Parent Email",
      "Parent Phone",
    ];
    const monthName = MONTHS[birthMonth - 1].toLowerCase();
    return csvResponse(toCsv([header, ...rows]), `kidz-kingdom-birthdays-${monthName}.csv`);
  }

  // ---- Waiver list: one row per waiver ----
  if (dateFilter) {
    index = index.filter((item: any) => {
      const mtDate = new Date(item.submittedAt).toLocaleDateString("en-CA", { timeZone: MT_TZ });
      return mtDate === dateFilter;
    });
  }

  const header = [
    "Parent First Name",
    "Parent Last Name",
    "Email",
    "Phone",
    "Children",
    "Children Birth Month/Year",
    "Submitted (Mountain Time)",
  ];
  const rows = index.map((item: any) => {
    const details = childDetailsOf(item);
    const names = details.length ? details.map(childFullName) : item.children || [];
    return [
      // Waivers signed before first/last names were collected only have a full name.
      item.parentFirstName || item.parentName,
      item.parentLastName,
      item.email,
      item.phone,
      names.join("; "),
      details.map((c) => `${childFullName(c)}: ${birthLabel(c)}`).join("; "),
      new Date(item.submittedAt).toLocaleString("en-CA", { timeZone: MT_TZ }),
    ];
  });

  const filename = dateFilter ? `kidz-kingdom-waivers-${dateFilter}.csv` : "kidz-kingdom-waivers.csv";
  return csvResponse(toCsv([header, ...rows]), filename);
};

export const config: Config = {
  path: "/api/admin/export",
};
