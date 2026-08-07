import type { Context, Config } from "@netlify/functions";
import { getStore } from "@netlify/blobs";
import { PDFDocument, StandardFonts, rgb } from "pdf-lib";

const MT_TZ = "America/Edmonton";

const CLAUSE_LABELS: Record<string, string> = {
  assumptionOfRisk: "Assumption of Risk",
  releaseOfLiability: "Release of Liability",
  rulesRegulations: "Rules & Regulations",
  supervision: "Supervision",
  emergencyMedical: "Emergency Medical Consent",
  indemnity: "Indemnity",
  governingLaw: "Governing Law",
};

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

  const pdfDoc = await PDFDocument.create();
  const font = await pdfDoc.embedFont(StandardFonts.Helvetica);
  const boldFont = await pdfDoc.embedFont(StandardFonts.HelveticaBold);

  const pageWidth = 595.28; // A4
  const pageHeight = 841.89;
  const margin = 50;
  const contentWidth = pageWidth - margin * 2;

  let page = pdfDoc.addPage([pageWidth, pageHeight]);
  let y = pageHeight - margin;

  const ink = rgb(0.08, 0.09, 0.14);
  const muted = rgb(0.45, 0.48, 0.56);
  const accent = rgb(0.53, 0.2, 0.83);
  const green = rgb(0.13, 0.55, 0.25);

  function ensureSpace(needed: number) {
    if (y - needed < margin) {
      page = pdfDoc.addPage([pageWidth, pageHeight]);
      y = pageHeight - margin;
    }
  }

  function text(
    str: string,
    opts: { size?: number; bold?: boolean; color?: any; gap?: number; x?: number } = {}
  ) {
    const size = opts.size ?? 11;
    const useFont = opts.bold ? boldFont : font;
    const color = opts.color ?? ink;
    ensureSpace(size + (opts.gap ?? 6));
    page.drawText(str, { x: opts.x ?? margin, y, size, font: useFont, color });
    y -= size + (opts.gap ?? 6);
  }

  function sectionHeading(str: string) {
    ensureSpace(30);
    y -= 6;
    page.drawLine({
      start: { x: margin, y: y + 4 },
      end: { x: pageWidth - margin, y: y + 4 },
      thickness: 0.75,
      color: rgb(0.85, 0.85, 0.88),
    });
    text(str, { size: 12, bold: true, color: accent, gap: 10 });
  }

  function row(label: string, value: string) {
    ensureSpace(16);
    page.drawText(label, { x: margin, y, size: 10, font: boldFont, color: muted });
    page.drawText(value || "-", { x: margin + 150, y, size: 10.5, font, color: ink });
    y -= 18;
  }

  // ---- Header ----
  text("Kidz Kingdom INC", { size: 20, bold: true, gap: 2 });
  text("Waiver & Release of Liability - Submission Record", { size: 11.5, color: muted, gap: 16 });

  text(`Record ID: ${record.id}`, { size: 8.5, color: muted, gap: 2 });
  text(`Submitted: ${mtDateTime(record.submittedAt)}`, { size: 8.5, color: muted, gap: 16 });

  // ---- Parent / Guardian ----
  sectionHeading("Parent / Guardian Information");
  row("Full Name:", record.parentName);
  row("Phone:", record.phone);
  row("Email:", record.email);

  // ---- Children ----
  sectionHeading("Children Registered");
  const children: string[] = Array.isArray(record.children) ? record.children : [];
  if (children.length === 0) {
    text("No children listed.", { size: 10.5, color: muted, gap: 8 });
  } else {
    children.forEach((child, i) => row(`Child ${i + 1}:`, child));
  }

  // ---- Waiver acknowledgements ----
  sectionHeading("Waiver Clauses - Parent/Guardian Initials");
  const initials = record.initials || {};
  Object.keys(CLAUSE_LABELS).forEach((key) => {
    ensureSpace(16);
    page.drawText(CLAUSE_LABELS[key], { x: margin, y, size: 10, font: boldFont, color: muted });
    page.drawText(String(initials[key] || "-"), {
      x: margin + 260,
      y,
      size: 10.5,
      font: boldFont,
      color: green,
    });
    y -= 18;
  });

  // ---- Rules & printed name ----
  sectionHeading("Acknowledgement");
  row("Rules & Regulations Acknowledged:", record.rulesAcknowledged ? "Yes" : "No");
  row("Printed Name:", record.printedName);

  // ---- Signature ----
  sectionHeading("Signature");
  const signature: string = record.signature || "";
  const match = /^data:image\/(png|jpe?g);base64,(.+)$/i.exec(signature);
  if (match) {
    const mime = match[1].toLowerCase();
    const bytes = base64ToBytes(match[2]);
    try {
      const image = mime === "png" ? await pdfDoc.embedPng(bytes) : await pdfDoc.embedJpg(bytes);
      const maxW = 260;
      const maxH = 110;
      const scale = Math.min(maxW / image.width, maxH / image.height, 1);
      const w = image.width * scale;
      const h = image.height * scale;
      ensureSpace(h + 20);
      page.drawRectangle({
        x: margin,
        y: y - h - 10,
        width: Math.max(w, 200) + 20,
        height: h + 20,
        color: rgb(1, 1, 1),
        borderColor: rgb(0.85, 0.85, 0.88),
        borderWidth: 1,
      });
      page.drawImage(image, { x: margin + 10, y: y - h - 0, width: w, height: h });
      y -= h + 30;
    } catch {
      text("(Signature image could not be rendered)", { size: 10, color: muted, gap: 8 });
    }
  } else {
    text("(No signature on file)", { size: 10, color: muted, gap: 8 });
  }

  // ---- Footer ----
  ensureSpace(40);
  y -= 10;
  page.drawLine({
    start: { x: margin, y: y + 4 },
    end: { x: pageWidth - margin, y: y + 4 },
    thickness: 0.75,
    color: rgb(0.85, 0.85, 0.88),
  });
  text(
    "Official record of a digital waiver submitted via the Kidz Kingdom registration portal.",
    { size: 8, color: muted, gap: 2 }
  );
  text(`Downloaded: ${mtDateTime(new Date().toISOString())} - for record-keeping / dispute purposes.`, {
    size: 8,
    color: muted,
  });

  const pdfBytes = await pdfDoc.save();

  const safeName = (record.parentName || "waiver").toString().replace(/[^a-z0-9]+/gi, "-").replace(/^-+|-+$/g, "") || "waiver";
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
