import type { Config } from "@netlify/functions";
import { runBirthdaySchedules } from "../lib/schedule.mts";
import { runMarketingSchedules } from "../lib/marketing.mts";
import { emailProvider } from "../lib/email.mts";

// Runs every 5 minutes on the live site and sends anything that's due:
// scheduled birthday emails, automatic birthday emails, and scheduled
// marketing emails (a big one is spread over several runs).
// Netlify gives scheduled functions 30 seconds, so each part has a budget.
export default async () => {
  if (emailProvider() !== "resend") return;
  const start = Date.now();
  try {
    await runBirthdaySchedules({ until: start + 11000 });
  } catch (err) {
    console.error("scheduler: birthdays failed", err);
  }
  try {
    await runMarketingSchedules(start + 23000);
  } catch (err) {
    console.error("scheduler: marketing failed", err);
  }
};

export const config: Config = {
  schedule: "*/5 * * * *",
};
