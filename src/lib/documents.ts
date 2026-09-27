import mammoth from "mammoth";
import pdfParse from "pdf-parse";
import { AppError } from "@/lib/errors";
import { getEnv } from "@/lib/env";
import { normalizePersianText } from "@/lib/normalization";

export type SupportedDocType = "PDF" | "DOCX" | "TXT" | "MARKDOWN";

const MIME_TO_TYPE: Record<string, SupportedDocType> = {
  "application/pdf": "PDF",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document": "DOCX",
  "text/plain": "TXT",
  "text/markdown": "MARKDOWN",
};

const EXT_TO_TYPE: Record<string, SupportedDocType> = {
  pdf: "PDF",
  docx: "DOCX",
  txt: "TXT",
  md: "MARKDOWN",
  markdown: "MARKDOWN",
};

export type ValidatedUpload = {
  filename: string;
  mimeType: string;
  size: number;
  docType: SupportedDocType;
};

/**
 * Upload validation: size limit, MIME allowlist, extension consistency,
 * safe filename. Never executes uploaded content.
 */
export function validateUpload(input: { filename: string; mimeType: string; size: number }): ValidatedUpload {
  const e = getEnv();
  const filename = input.filename.split(/[/\\]/).pop()?.trim() ?? "";
  if (!filename || filename.length > 255 || filename === "." || filename === "..") {
    throw new AppError(400, "INVALID_PAYLOAD", "Invalid filename");
  }
  if (!Number.isFinite(input.size) || input.size <= 0) {
    throw new AppError(400, "INVALID_PAYLOAD", "Empty file");
  }
  if (input.size > e.MAX_UPLOAD_BYTES) {
    throw new AppError(413, "PAYLOAD_TOO_LARGE", `File exceeds the ${Math.round(e.MAX_UPLOAD_BYTES / 1024 / 1024)} MB limit`);
  }
  const allowed = new Set(e.ALLOWED_UPLOAD_MIME.split(",").map((m) => m.trim().toLowerCase()));
  const mimeType = input.mimeType.toLowerCase().split(";")[0].trim();
  if (!allowed.has(mimeType)) {
    throw new AppError(415, "UNSUPPORTED_MEDIA_TYPE", `MIME type not allowed: ${mimeType}`);
  }
  const ext = filename.includes(".") ? filename.split(".").pop()!.toLowerCase() : "";
  const extType = EXT_TO_TYPE[ext];
  const mimeTypeDoc = MIME_TO_TYPE[mimeType];
  if (!extType || !mimeTypeDoc || extType !== mimeTypeDoc) {
    throw new AppError(400, "VALIDATION_ERROR", "File extension does not match its MIME type");
  }
  return { filename, mimeType, size: input.size, docType: mimeTypeDoc };
}

/** Magic-byte sniffing to reject spoofed uploads (defense in depth). */
export function sniffContent(buffer: Buffer, docType: SupportedDocType): void {
  if (docType === "PDF" && !buffer.subarray(0, 5).toString("latin1").startsWith("%PDF-")) {
    throw new AppError(400, "VALIDATION_ERROR", "File content is not a valid PDF");
  }
  if (docType === "DOCX" && !(buffer[0] === 0x50 && buffer[1] === 0x4b)) {
    throw new AppError(400, "VALIDATION_ERROR", "File content is not a valid DOCX (zip) archive");
  }
}

/** Extract raw text from a validated upload buffer. */
export async function extractText(buffer: Buffer, docType: SupportedDocType): Promise<{ text: string; pages?: number }> {
  sniffContent(buffer, docType);
  switch (docType) {
    case "PDF": {
      const result = await pdfParse(buffer);
      return { text: result.text ?? "", pages: result.numpages };
    }
    case "DOCX": {
      const result = await mammoth.extractRawText({ buffer });
      return { text: result.value ?? "" };
    }
    case "TXT":
    case "MARKDOWN": {
      return { text: buffer.toString("utf8") };
    }
  }
}

/** Clean extracted text: control chars, excess whitespace, Persian normalization. */
export function cleanText(raw: string): string {
  const noControls = raw.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, "");
  return normalizePersianText(noControls);
}

export type TextChunk = { content: string; index: number; tokenCount: number };

/** Rough token estimate for chunk sizing (Persian ≈ 3 chars/token). */
export function estimateTokens(text: string): number {
  return Math.max(1, Math.ceil(text.length / 3));
}

/**
 * Overlapping chunking: target ~1200 chars with ~200 char overlap,
 * preferring paragraph then sentence boundaries.
 */
export function chunkText(text: string, opts?: { targetChars?: number; overlapChars?: number }): TextChunk[] {
  const target = opts?.targetChars ?? 1200;
  const overlap = opts?.overlapChars ?? 200;
  const cleaned = text.replace(/\r\n/g, "\n").trim();
  if (!cleaned) return [];

  const paragraphs = cleaned.split(/\n{2,}/).map((p) => p.trim()).filter(Boolean);
  const chunks: string[] = [];
  let current = "";

  const push = () => {
    if (current.trim()) chunks.push(current.trim());
    current = "";
  };

  for (const para of paragraphs) {
    if ((current + "\n\n" + para).length <= target || !current) {
      current = current ? `${current}\n\n${para}` : para;
      continue;
    }
    push();
    if (para.length > target) {
      // Long paragraph: split on sentences.
      const sentences = para.split(/(?<=[.!?؟!۔])\s+/);
      let acc = "";
      for (const s of sentences) {
        if ((acc + " " + s).length > target && acc) {
          chunks.push(acc.trim());
          acc = s;
        } else {
          acc = acc ? `${acc} ${s}` : s;
        }
      }
      current = acc;
    } else {
      // Overlap: carry the tail of the previous chunk.
      const tail = chunks.length > 0 ? chunks[chunks.length - 1].slice(-overlap) : "";
      current = tail ? `${tail} ... ${para}` : para;
    }
  }
  push();

  return chunks
    .map((content, index) => ({ content, index, tokenCount: estimateTokens(content) }))
    .filter((c) => c.content.length >= 20);
}
