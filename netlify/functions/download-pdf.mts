import type { Context, Config } from "@netlify/functions";
import { getStore } from "@netlify/blobs";
import { PDFDocument, StandardFonts, rgb } from "pdf-lib";

const MT_TZ = "America/Edmonton";

const RULES = [
  "Children must wear grip socks at all times; adults must wear socks.",
  "Adults are not permitted on the play structure.",
  "No food or beverages are permitted within the soft play area.",
  "All participants must sanitize hands prior to entering the play area.",
  "Wristbands must be retained for same-day re-entry.",
  "Parent/guardian must supervise children at all times unless participating in a supervised program.",
  "If a parent/guardian cannot be located, mall security will be contacted.",
];

const CLAUSES: { num: number; key: string; title: string; body?: string; rules?: string[] }[] = [
  {
    num: 2,
    key: "assumptionOfRisk",
    title: "Assumption of Risk",
    body:
      "I acknowledge that participation in activities at Kidz Kingdom INC involves inherent risks including slips, falls, collisions, and injuries. I voluntarily assume all risks.",
  },
  {
    num: 3,
    key: "releaseOfLiability",
    title: "Release of Liability",
    body:
      "To the fullest extent permitted under Alberta law, I release and hold harmless Kidz Kingdom INC, its owners, employees, affiliates, and all locations from any claims arising from participation.",
  },
  {
    num: 4,
    key: "rulesRegulations",
    title: "Rules & Regulations",
    rules: RULES,
  },
  {
    num: 5,
    key: "supervision",
    title: "Supervision",
    body: "I am responsible for the supervision of my child unless enrolled in a supervised program.",
  },
  {
    num: 6,
    key: "emergencyMedical",
    title: "Emergency Medical Consent",
    body: "I authorize staff to administer basic first aid and contact emergency services if required.",
  },
  {
    num: 7,
    key: "indemnity",
    title: "Indemnity",
    body:
      "I agree to indemnify and hold harmless Kidz Kingdom INC, its owners, employees, affiliates, and all locations from any claims, demands, or actions arising from my child's participation.",
  },
  {
    num: 8,
    key: "governingLaw",
    title: "Governing Law",
    body: "This agreement shall be governed by and interpreted in accordance with the laws of the Province of Alberta.",
  },
  {
    num: 9,
    key: "surveillance",
    title: "Photo, Video & Audio Surveillance",
    body:
      "I acknowledge that Kidz Kingdom Inc. uses video and audio surveillance for safety and security purposes. Recordings are handled in accordance with applicable Alberta privacy laws, and footage may be blurred, muted, or redacted where required to protect the privacy of others.",
  },
];

function isAuthorized(req: Request): boolean {
  const expected = Netlify.env.get("ADMIN_PASSWORD") || "";
  const provided = req.headers.get("x-admin-password") || "";
  return Boolean(expected) && provided === expected;
}

function mtDateTime(iso: string): string {
  return (
    new Date(iso).toLocaleString("en-US", {
      timeZone: MT_TZ,
      year: "numeric",
      month: "long",
      day: "numeric",
      hour: "numeric",
      minute: "2-digit",
    }) + " MT"
  );
}

function base64ToBytes(base64: string): Uint8Array {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

export default async (req: Request, context: Context) => {
  if (req.method !== "GET") {
    return new Response(JSON.stringify({ error: "Method not allowed" }), { status: 405 });
  }

  if (!isAuthorized(req)) {
    return new Response(JSON.stringify({ error: "Unauthorized" }), { status: 401 });
  }

  const url = new URL(req.url);
  const id = url.searchParams.get("id") || "";
  if (!id) {
    return new Response(JSON.stringify({ error: "Missing id" }), { status: 400 });
  }

  const submissionsStore = getStore("waiver-submissions");
  const record: any = await submissionsStore.get(id, { type: "json" });

  if (!record) {
    return new Response(JSON.stringify({ error: "Not found" }), { status: 404 });
  }

  // Standard PDF fonts (WinAnsi) can't encode arbitrary Unicode (emoji, CJK, etc.).
  // Sanitize any free-text a customer typed so PDF generation never fails.
  function sanitize(v: any): string {
    const s = (v ?? "").toString();
    let out = "";
    for (const ch of s) {
      const code = ch.codePointAt(0) || 0;
      out += code <= 0x7e || (code >= 0xa0 && code <= 0xff) ? ch : "?";
    }
    return out;
  }
  record.parentName = sanitize(record.parentName);
  record.phone = sanitize(record.phone);
  record.email = sanitize(record.email);
  record.printedName = sanitize(record.printedName);
  record.children = Array.isArray(record.children) ? record.children.map(sanitize) : [];
  if (record.initials && typeof record.initials === "object") {
    Object.keys(record.initials).forEach((k) => {
      record.initials[k] = sanitize(record.initials[k]);
    });
  }

  const pdfDoc = await PDFDocument.create();
  const font = await pdfDoc.embedFont(StandardFonts.Helvetica);
  const boldFont = await pdfDoc.embedFont(StandardFonts.HelveticaBold);
  const italicFont = await pdfDoc.embedFont(StandardFonts.HelveticaOblique);

  const pageWidth = 595.28; // A4
  const pageHeight = 841.89;
  const margin = 50;
  const contentWidth = pageWidth - margin * 2;

  let page = pdfDoc.addPage([pageWidth, pageHeight]);
  let y = pageHeight - margin;

  const ink = rgb(0.08, 0.09, 0.14);
  const muted = rgb(0.45, 0.48, 0.56);
  const accent = rgb(0.53, 0.2, 0.83);
  const green = rgb(0.11, 0.5, 0.24);

  function newPage() {
    page = pdfDoc.addPage([pageWidth, pageHeight]);
    y = pageHeight - margin;
  }

  function ensureSpace(needed: number) {
    if (y - needed < margin) newPage();
  }

  function wrapText(str: string, useFont: any, size: number, maxWidth: number): string[] {
    const words = str.split(/\s+/);
    const lines: string[] = [];
    let current = "";
    for (const word of words) {
      const test = current ? current + " " + word : word;
      if (useFont.widthOfTextAtSize(test, size) > maxWidth && current) {
        lines.push(current);
        current = word;
      } else {
        current = test;
      }
    }
    if (current) lines.push(current);
    return lines;
  }

  function text(
    str: string,
    opts: { size?: number; bold?: boolean; italic?: boolean; color?: any; gap?: number; x?: number } = {}
  ) {
    const size = opts.size ?? 11;
    const useFont = opts.italic ? italicFont : opts.bold ? boldFont : font;
    const color = opts.color ?? ink;
    ensureSpace(size + (opts.gap ?? 6));
    page.drawText(str, { x: opts.x ?? margin, y, size, font: useFont, color });
    y -= size + (opts.gap ?? 6);
  }

  function paragraph(str: string, opts: { size?: number; color?: any; maxWidth?: number; lineGap?: number } = {}) {
    const size = opts.size ?? 10.2;
    const color = opts.color ?? rgb(0.22, 0.2, 0.27);
    const maxWidth = opts.maxWidth ?? contentWidth;
    const lineHeight = size + (opts.lineGap ?? 4);
    const lines = wrapText(str, font, size, maxWidth);
    lines.forEach((line) => {
      ensureSpace(lineHeight);
      page.drawText(line, { x: margin, y, size, font, color });
      y -= lineHeight;
    });
  }

  function sectionHeading(numLabel: string, title: string) {
    ensureSpace(34);
    y -= 8;
    page.drawLine({
      start: { x: margin, y: y + 6 },
      end: { x: pageWidth - margin, y: y + 6 },
      thickness: 0.75,
      color: rgb(0.85, 0.85, 0.88),
    });
    ensureSpace(18);
    page.drawCircle({ x: margin + 8, y: y - 2, size: 9, color: accent });
    page.drawText(numLabel, {
      x: margin + (numLabel.length > 1 ? 4.5 : 5.5),
      y: y - 6,
      size: 8.5,
      font: boldFont,
      color: rgb(1, 1, 1),
    });
    page.drawText(title, { x: margin + 24, y: y - 6, size: 12.5, font: boldFont, color: ink });
    y -= 26;
  }

  function initialsLine(value: string) {
    ensureSpace(24);
    y -= 4;
    page.drawRectangle({
      x: margin,
      y: y - 16,
      width: contentWidth,
      height: 24,
      color: rgb(0.96, 0.95, 0.99),
      borderColor: rgb(0.85, 0.8, 0.93),
      borderWidth: 0.75,
    });
    page.drawText("Parent / Guardian Initial to Confirm:", {
      x: margin + 10,
      y: y - 8,
      size: 9.5,
      font: boldFont,
      color: muted,
    });
    page.drawText((value || "-").toString(), {
      x: margin + contentWidth - 60,
      y: y - 9,
      size: 12,
      font: boldFont,
      color: green,
    });
    y -= 30;
  }

  // ============ Header ============
  text("Kidz Kingdom INC", { size: 21, bold: true, gap: 3 });
  text("Indoor Playground Waiver & Release of Liability", { size: 12.5, color: muted, gap: 4 });
  text("Full Submission Record - reproduces the complete waiver as agreed to online.", {
    size: 8.7,
    italic: true,
    color: muted,
    gap: 14,
  });

  text(`Record ID: ${record.id}`, { size: 8.3, color: muted, gap: 2 });
  text(`Submitted: ${mtDateTime(record.submittedAt)}`, { size: 8.3, color: muted, gap: 16 });

  // ============ 1. Family Information ============
  sectionHeading("1", "Family Information");

  function fieldRow(label: string, value: string) {
    ensureSpace(17);
    page.drawText(label, { x: margin, y, size: 9.8, font: boldFont, color: muted });
    page.drawText(value || "-", { x: margin + 150, y, size: 10.5, font, color: ink });
    y -= 19;
  }

  fieldRow("Parent / Guardian Name:", record.parentName);
  fieldRow("Phone Number:", record.phone);
  fieldRow("Email:", record.email);
  y -= 4;

  const children: string[] = Array.isArray(record.children) ? record.children : [];
  if (children.length === 0) {
    text("No children listed.", { size: 10, color: muted, gap: 8 });
  } else {
    children.forEach((child, i) => fieldRow(`Child ${i + 1}:`, child));
  }

  // ============ Clauses 2-8 ============
  const initials = record.initials || {};

  CLAUSES.forEach((clause) => {
    sectionHeading(String(clause.num), clause.title);

    if (clause.body) {
      paragraph(clause.body);
    }

    if (clause.rules) {
      y -= 2;
      clause.rules.forEach((rule) => {
        const lines = wrapText(rule, font, 10, contentWidth - 26);
        ensureSpace(lines.length * 14 + 4);
        page.drawRectangle({
          x: margin,
          y: y - 8,
          width: 9,
          height: 9,
          color: green,
          borderColor: green,
          borderWidth: 1,
        });
        page.drawText("x", { x: margin + 2, y: y - 6.5, size: 7.5, font: boldFont, color: rgb(1, 1, 1) });
        lines.forEach((line, i) => {
          page.drawText(line, { x: margin + 18, y: y - i * 14, size: 10, font, color: rgb(0.22, 0.2, 0.27) });
        });
        y -= lines.length * 14 + 4;
      });
      y -= 2;
    }

    initialsLine(initials[clause.key]);
  });

  // ============ 10. Signature ============
  sectionHeading("10", "Signature");
  paragraph(
    "I have read and understand this agreement, I have had the opportunity to ask questions, and I voluntarily agree to all terms. This agreement shall be governed by and interpreted in accordance with the laws of the Province of Alberta.",
    { color: muted, size: 9.5 }
  );
  y -= 6;
  fieldRow("Printed Name:", record.printedName);
  fieldRow("Rules & Regulations Acknowledged:", record.rulesAcknowledged ? "Yes - all items checked" : "No");
  y -= 10;

  text("Signature on file:", { size: 10, bold: true, gap: 8 });

  const signature: string = record.signature || "";
  const match = /^data:image\/(png|jpe?g);base64,(.+)$/i.exec(signature);
  if (match) {
    const mime = match[1].toLowerCase();
    const bytes = base64ToBytes(match[2]);
    try {
      const image = mime === "png" ? await pdfDoc.embedPng(bytes) : await pdfDoc.embedJpg(bytes);
      const maxW = 280;
      const maxH = 110;
      const scale = Math.min(maxW / image.width, maxH / image.height, 1);
      const w = image.width * scale;
      const h = image.height * scale;
      ensureSpace(h + 24);
      const boxW = Math.max(w, 220) + 20;
      page.drawRectangle({
        x: margin,
        y: y - h - 12,
        width: boxW,
        height: h + 20,
        color: rgb(1, 1, 1),
        borderColor: rgb(0.85, 0.85, 0.88),
        borderWidth: 1,
      });
      page.drawImage(image, { x: margin + 10, y: y - h - 2, width: w, height: h });
      y -= h + 34;
    } catch {
      text("(Signature image could not be rendered)", { size: 10, color: muted, gap: 8 });
    }
  } else {
    text("(No signature on file)", { size: 10, color: muted, gap: 8 });
  }

  // ============ Footer ============
  ensureSpace(44);
  y -= 8;
  page.drawLine({
    start: { x: margin, y: y + 4 },
    end: { x: pageWidth - margin, y: y + 4 },
    thickness: 0.75,
    color: rgb(0.85, 0.85, 0.88),
  });
  text(
    "This document reproduces the complete digital waiver, including full clause text and parent/guardian initials, as submitted via the Kidz Kingdom registration portal.",
    { size: 7.8, color: muted, gap: 2 }
  );
  text(`Downloaded: ${mtDateTime(new Date().toISOString())} - for record-keeping / dispute purposes.`, {
    size: 7.8,
    color: muted,
  });

  const pdfBytes = await pdfDoc.save();

  const safeName =
    (record.parentName || "waiver").toString().replace(/[^a-z0-9]+/gi, "-").replace(/^-+|-+$/g, "") || "waiver";
  const filename = `kidz-kingdom-waiver-${safeName}-${record.id.slice(0, 8)}.pdf`;

  return new Response(pdfBytes, {
    status: 200,
    headers: {
      "content-type": "application/pdf",
      "content-disposition": `attachment; filename="${filename}"`,
    },
  });
};

export const config: Config = {
  path: "/api/admin/download-pdf",
};
