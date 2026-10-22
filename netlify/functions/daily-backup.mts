import type { Config } from "@netlify/functions";
import { writeDailyBackup } from "../lib/trash.mts";

// Every night, saves a copy of the whole waiver list (kept 90 days), so we can
// always tell whether a waiver was ever in the system and when it left.
export default async () => {
  const r = await writeDailyBackup().catch((e) => { console.error("backup failed", e); return null; });
  console.log("daily backup", JSON.stringify(r));
};

// 3:15 AM Edmonton (09:15 UTC; 10:15 UTC in winter is fine either way).
export const config: Config = { schedule: "15 9 * * *" };
