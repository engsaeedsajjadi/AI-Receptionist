/**
 * TTS text cleaner: the caller must hear natural Persian speech — never raw
 * markdown, code, URLs, or tool JSON that may leak into an LLM reply.
 */

const MAX_SPOKEN_CHARS = 2000;

/**
 * Convert an agent reply into speakable text:
 * - drops fenced/inline code and JSON blobs
 * - unwraps markdown links ([text](url) → text), drops bare URLs
 * - strips headings, emphasis, quotes, list markers
 * - collapses whitespace; truncates at a sentence boundary when too long
 */
export function toSpokenPersian(reply: string, maxChars = MAX_SPOKEN_CHARS): string {
  if (!reply) return "";
  let text = reply;

  // Fenced code blocks (incl. ```json tool dumps) and inline code.
  text = text.replace(/```[\s\S]*?```/g, " ");
  text = text.replace(/`[^`]*`/g, " ");

  // Markdown links → link text; images → dropped.
  text = text.replace(/!\[([^\]]*)\]\([^)]*\)/g, " ");
  text = text.replace(/\[([^\]]*)\]\([^)]*\)/g, "$1");

  // Bare URLs and emails are not speakable.
  text = text.replace(/https?:\/\/\S+/g, " ");
  text = text.replace(/[\w.+-]+@[\w-]+\.[\w.]+/g, " ");

  // Headings, blockquotes, list markers, emphasis, tables, hr.
  text = text
    .replace(/^#{1,6}\s+/gm, "")
    .replace(/^>\s?/gm, "")
    .replace(/^\s*[-*+]\s+/gm, "")
    .replace(/^\s*\d+[.)]\s+/gm, "")
    .replace(/(\*\*|__)(.*?)\1/g, "$2")
    .replace(/(\*|_)(.*?)\1/g, "$2")
    .replace(/\|/g, " ")
    .replace(/^[-*_]{3,}\s*$/gm, " ");

  // Collapse all whitespace runs (newlines become pauses-as-spaces for TTS).
  text = text.replace(/\s+/g, " ").trim();
  text = text.replace(/\s+([،؛؟!.?,:;])/g, "$1");

  if (text.length <= maxChars) return text;

  // Truncate at a sentence boundary (Persian + latin terminators).
  const head = text.slice(0, maxChars);
  const boundaries = ["؟", ".", "!", "?", "。", "\n", "؛", "،"];
  let cut = -1;
  for (const b of boundaries) {
    const idx = head.lastIndexOf(b);
    if (idx > maxChars * 0.4 && idx > cut) cut = idx;
  }
  if (cut > 0) return head.slice(0, cut + 1).trim();
  return `${head.trim()}…`;
}
