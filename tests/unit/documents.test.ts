import { describe, expect, it } from "vitest";
import {
  chunkText,
  cleanText,
  estimateTokens,
  extractText,
  sniffContent,
  validateUpload,
} from "@/lib/documents";
import { AppError } from "@/lib/errors";

describe("validateUpload", () => {
  it("accepts a valid PDF upload", () => {
    const v = validateUpload({ filename: "brochure.pdf", mimeType: "application/pdf", size: 1024 });
    expect(v.docType).toBe("PDF");
  });

  it("accepts docx/txt/markdown", () => {
    expect(
      validateUpload({
        filename: "a.docx",
        mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
        size: 10,
      }).docType,
    ).toBe("DOCX");
    expect(validateUpload({ filename: "a.txt", mimeType: "text/plain", size: 10 }).docType).toBe("TXT");
    expect(validateUpload({ filename: "a.md", mimeType: "text/markdown", size: 10 }).docType).toBe("MARKDOWN");
  });

  it("rejects oversized files", () => {
    expect(() =>
      validateUpload({ filename: "big.pdf", mimeType: "application/pdf", size: 1024 * 1024 * 1024 }),
    ).toThrow(AppError);
  });

  it("rejects disallowed MIME types", () => {
    expect(() => validateUpload({ filename: "run.exe", mimeType: "application/x-msdownload", size: 10 })).toThrow(
      expect.objectContaining({ code: "UNSUPPORTED_MEDIA_TYPE" }),
    );
  });

  it("rejects extension/MIME mismatch", () => {
    expect(() => validateUpload({ filename: "evil.pdf", mimeType: "text/plain", size: 10 })).toThrow(AppError);
  });

  it("rejects path traversal filenames", () => {
    expect(() => validateUpload({ filename: "..", mimeType: "text/plain", size: 10 })).toThrow(AppError);
  });

  it("rejects empty files", () => {
    expect(() => validateUpload({ filename: "a.txt", mimeType: "text/plain", size: 0 })).toThrow(AppError);
  });
});

describe("sniffContent", () => {
  it("rejects fake PDFs", () => {
    expect(() => sniffContent(Buffer.from("MZ fake"), "PDF")).toThrow(AppError);
  });
  it("rejects fake DOCX archives", () => {
    expect(() => sniffContent(Buffer.from("not a zip"), "DOCX")).toThrow(AppError);
  });
  it("accepts magic bytes", () => {
    expect(() => sniffContent(Buffer.from("%PDF-1.7 fake"), "PDF")).not.toThrow();
    expect(() => sniffContent(Buffer.from([0x50, 0x4b, 0x03, 0x04]), "DOCX")).not.toThrow();
  });
});

describe("extractText", () => {
  it("extracts plain text and markdown", async () => {
    await expect(extractText(Buffer.from("سلام دنیا", "utf8"), "TXT")).resolves.toMatchObject({
      text: "سلام دنیا",
    });
    await expect(extractText(Buffer.from("# Title", "utf8"), "MARKDOWN")).resolves.toMatchObject({
      text: "# Title",
    });
  });
});

describe("cleanText / chunkText / estimateTokens", () => {
  it("cleans control chars and normalizes Persian", () => {
    expect(cleanText("علي\u0000  ۱۲")).toBe("علی 12");
  });

  it("returns no chunks for empty text", () => {
    expect(chunkText("   ")).toEqual([]);
  });

  it("chunks long text with overlap", () => {
    const para = "این یک پاراگراف آزمایشی برای بررسی تکه‌تکه‌سازی متن است. ".repeat(40);
    const text = [para, para, para].join("\n\n");
    const chunks = chunkText(text, { targetChars: 1200, overlapChars: 200 });
    expect(chunks.length).toBeGreaterThan(1);
    for (const c of chunks) {
      expect(c.content.length).toBeGreaterThanOrEqual(20);
      expect(c.tokenCount).toBeGreaterThan(0);
    }
    expect(chunks.map((c) => c.index)).toEqual(chunks.map((_, i) => i));
  });

  it("estimates tokens", () => {
    expect(estimateTokens("")).toBe(1);
    expect(estimateTokens("abc")).toBe(1);
    expect(estimateTokens("x".repeat(300))).toBe(100);
  });
});
