import { afterAll, afterEach, beforeAll, describe, expect, vi } from "vitest";
import { NextRequest } from "next/server";
import { and, eq } from "drizzle-orm";
import { closeDb, db } from "@/db";
import { businesses, knowledgeChunks, knowledgeDocuments } from "@/db/schema";
import { issueAuthTokens } from "@/lib/auth";
import { resetEnvCache } from "@/lib/env";
import { POST as upload } from "@/app/api/v1/knowledge/upload/route";
import { createBusiness, createUser } from "../helpers/fixtures";
import { ensureDbReady, hasTestDatabase, itDb, truncateAll } from "../helpers/db";

/**
 * The knowledge upload surface: size/MIME/extension validation, magic-byte
 * sniffing, the malware policy (which must never be a silent pass), and the
 * guarantee that a rejected document is never searchable.
 *
 * Embeddings are not configured in CI, so a document that passes validation ends
 * `failed` (indexing error) rather than `indexed` — that is the honest outcome
 * here, and it is asserted explicitly instead of being papered over.
 */

let ipSeq = 0;
function request(body: BodyInit | undefined, token: string, headers: Record<string, string> = {}) {
  return new NextRequest("http://localhost/api/v1/knowledge/upload", {
    method: "POST",
    headers: {
      Authorization: `Bearer ${token}`,
      "x-real-ip": `10.15.${(ipSeq >> 8) % 250}.${(ipSeq++ % 250) + 1}`,
      ...headers,
    },
    body,
  });
}

function multipart(token: string, files: Array<{ name: string; content: string; type: string }>, title?: string, fieldName = "file") {
  const form = new FormData();
  for (const file of files) {
    form.append(fieldName, new File([file.content], file.name, { type: file.type }));
  }
  if (title) form.append("title", title);
  return request(form, token);
}

const TXT = (content: string) => ({ name: "notes.txt", content, type: "text/plain" });
const EICAR = "X5O!P%@AP[4\\PZX54(P^)7CC)7}$EICAR-STANDARD-ANTIVIRUS-TEST-FILE!$H+H*";

describe.skipIf(!hasTestDatabase())("knowledge upload pipeline", () => {
  beforeAll(async () => {
    await ensureDbReady();
    await truncateAll();
  });
  afterAll(async () => {
    await truncateAll();
    await closeDb();
  });
  afterEach(async () => {
    vi.unstubAllEnvs();
    resetEnvCache();
    await truncateAll();
  });

  async function tenant(role: "ADMIN" | "AGENT" = "ADMIN") {
    const business = await createBusiness(`Upload ${crypto.randomUUID().slice(0, 8)}`);
    const { user } = await createUser(business.id, role);
    const token = (await issueAuthTokens({ userId: user.id, businessId: business.id, role })).accessToken;
    return { business, user, token };
  }

  itDb("rejects a request without a file field, and refuses roles without knowledge:write", async () => {
    const { token } = await tenant();
    const missing = await upload(request(new FormData(), token));
    expect(missing.status).toBe(400);
    expect(JSON.stringify(await missing.json())).toContain("INVALID_PAYLOAD");

    const agent = await tenant("AGENT");
    const forbidden = await upload(multipart(agent.token, [TXT("این یک سند دانش کافی بلند برای ایندکس شدن است.")]));
    expect(forbidden.status).toBe(403);
  });

  itDb("validates size, MIME type, extension consistency and content sniffing", async () => {
    const { business, token } = await tenant();

    // A file whose MIME type is not on the allowlist.
    const badType = await upload(multipart(token, [{ name: "payload.exe", content: "MZbinary", type: "application/x-msdownload" }]));
    expect(badType.status).toBe(415);

    // MIME/extension mismatch (allowed MIME, wrong extension).
    const mismatch = await upload(multipart(token, [{ name: "notes.docx", content: "plain text body that is long enough", type: "text/plain" }]));
    expect(mismatch.status).toBe(400);

    // A file claiming to be a PDF without the %PDF- magic bytes.
    const spoofed = await upload(multipart(token, [{ name: "report.pdf", content: "not really a pdf", type: "application/pdf" }]));
    expect(spoofed.status).toBe(400);
    expect(JSON.stringify(await spoofed.json())).toContain("VALIDATION_ERROR");

    // A text file with no extractable content (cleaned < 20 chars).
    const empty = await upload(multipart(token, [TXT("   ..  ")]));
    expect(empty.status).toBe(400);

    // Oversized uploads hit the configured limit (stubbed small for the test).
    vi.stubEnv("MAX_UPLOAD_BYTES", "32");
    resetEnvCache();
    const oversized = await upload(multipart(token, [TXT("x".repeat(200))]));
    expect(oversized.status).toBe(413);
    vi.unstubAllEnvs();
    resetEnvCache();

    // Nothing above may have produced a document.
    expect(await db.select().from(knowledgeDocuments).where(eq(knowledgeDocuments.businessId, business.id))).toHaveLength(0);
  });

  itDb("validates a good upload, records the scan verdict, and reports the indexing failure honestly", async () => {
    const { business, token } = await tenant();
    const res = await upload(multipart(token, [TXT("سند آزمایشی دانش کسب‌وکار درباره قیمت‌گذاری و بازدید ملک.")], "قواعد قیمت‌گذاری"));
    // CI has no embedding provider, so a validated upload must fail loudly (503
    // PROVIDER_NOT_CONFIGURED) instead of pretending the document is searchable.
    expect(res.status).toBe(503);
    expect(JSON.stringify(await res.json())).toContain("PROVIDER_NOT_CONFIGURED");

    const rows = await db.select().from(knowledgeDocuments).where(eq(knowledgeDocuments.businessId, business.id));
    expect(rows).toHaveLength(1);
    expect(rows[0].title).toBe("قواعد قیمت‌گذاری");
    // The scan verdict is recorded on the row even though indexing failed…
    const metadata = rows[0].metadata as { malwareScan: { status: string; engine: string } };
    expect(metadata.malwareScan.status).toBe("clean");
    expect(metadata.malwareScan.engine).toBe("heuristic");
    // …the document is explicitly failed (never silently indexed)…
    expect(rows[0].status).toBe("failed");
    expect(rows[0].errorMessage).toContain("Embedding provider is not configured");

    // …and it contributes no searchable chunks.
    const chunks = await db.select().from(knowledgeChunks).where(and(eq(knowledgeChunks.businessId, business.id), eq(knowledgeChunks.documentId, rows[0].id)));
    expect(chunks).toHaveLength(0);
    const { hybridSearch } = await import("@/lib/services/knowledge");
    const search = await hybridSearch({ businessId: business.id, query: "قیمت‌گذاری", topK: 5 });
    expect(search.chunks).toHaveLength(0);
  });

  itDb("rejects a malicious file, quarantines it, and keeps it unsearchable", async () => {
    const { business, token } = await tenant();
    const res = await upload(multipart(token, [TXT(`${EICAR}\nاین محتوا نباید ایندکس شود.`)]));
    expect(res.status).toBe(400);
    expect(JSON.stringify(await res.json())).toContain("MALWARE_DETECTED");

    const rows = await db.select().from(knowledgeDocuments).where(eq(knowledgeDocuments.businessId, business.id));
    expect(rows).toHaveLength(1);
    expect(rows[0].status).toBe("failed");
    expect(rows[0].content).toBe("");
    expect(rows[0].errorMessage).toContain("Malware signature detected");
    const metadata = rows[0].metadata as { malwareScan: { status: string; signature: string }; quarantined: boolean };
    expect(metadata.malwareScan.status).toBe("infected");
    expect(metadata.malwareScan.signature).toBe("EICAR-Test-File");
    expect(metadata.quarantined).toBe(true);

    const chunks = await db.select().from(knowledgeChunks).where(eq(knowledgeChunks.businessId, business.id));
    expect(chunks).toHaveLength(0);
  });

  itDb("fails closed when a configured scanner is unreachable under strict policy, and flags it when lenient", async () => {
    const { business, token } = await tenant();
    // A scanner endpoint that cannot be reached (port 1 refuses immediately).
    vi.stubEnv("MALWARE_SCAN_URL", "http://127.0.0.1:1");
    vi.stubEnv("MALWARE_SCAN_STRICT", "true");
    resetEnvCache();
    const strict = await upload(multipart(token, [TXT("محتوای سالم اما اسکنر در دسترس نیست و باید رد شود.")]));
    expect(strict.status).toBe(503);
    expect(JSON.stringify(await strict.json())).toContain("SCANNER_UNAVAILABLE");
    const [strictRow] = await db.select().from(knowledgeDocuments).where(eq(knowledgeDocuments.businessId, business.id));
    expect(strictRow.status).toBe("failed");
    expect((strictRow.metadata as { malwareScan: { status: string; detail: string } }).malwareScan.status).toBe("unavailable");

    // Lenient policy (development): the upload is not blocked by the scanner, so
    // it proceeds past the scan gate — the gap is recorded on the document rather
    // than pretending the file was scanned. (It still fails later in CI because
    // no embedding provider is configured; that is asserted in the row below.)
    vi.stubEnv("MALWARE_SCAN_STRICT", "false");
    resetEnvCache();
    const lenient = await upload(multipart(token, [TXT("محتوای سالم با سیاست ملایم برای اسکنر در دسترس نبودن.")]));
    expect(lenient.status).toBe(503);
    expect(JSON.stringify(await lenient.json())).toContain("PROVIDER_NOT_CONFIGURED");
    const rows = await db.select().from(knowledgeDocuments).where(eq(knowledgeDocuments.businessId, business.id));
    const scanned = rows[rows.length - 1];
    const metadata = scanned.metadata as { malwareScan: { status: string; detail: string }; quarantined?: boolean };
    expect(metadata.malwareScan.status).toBe("unavailable");
    expect(metadata.quarantined).toBeUndefined();
  });

  itDb("refuses to index when the tenant's knowledge feature is disabled", async () => {
    const { business, token } = await tenant();
    await db.update(businesses).set({ settings: { features: { knowledge: false } } }).where(eq(businesses.id, business.id));
    const res = await upload(multipart(token, [TXT("محتوای کافی برای ایندکس شدن ولی قابلیت خاموش است.")]));
    expect(res.status).toBe(403);
    expect(await db.select().from(knowledgeDocuments).where(eq(knowledgeDocuments.businessId, business.id))).toHaveLength(0);
  });

  itDb("ingests pasted content through the JSON path and rejects content that is too short", async () => {
    const { business, token } = await tenant();
    const tooShort = await upload(request(JSON.stringify({ title: "کوتاه", content: "کم" }), token, { "content-type": "application/json" }));
    expect(tooShort.status).toBe(400);

    const ok = await upload(
      request(JSON.stringify({ title: "قواعد پاسخگویی", content: "همیشه پاسخ‌ها کوتاه، دقیق و بر اساس اسناد ثبت‌شده باشند.", sourceType: "manual" }), token, {
        "content-type": "application/json",
      }),
    );
    // Passes validation and is stored (as `manual`), then fails indexing for the
    // same honest reason as the file path — no embedding provider.
    expect(ok.status).toBe(503);
    const rows = await db.select().from(knowledgeDocuments).where(eq(knowledgeDocuments.businessId, business.id));
    expect(rows).toHaveLength(1);
    expect(rows[0].sourceType).toBe("manual");
    expect(rows[0].status).toBe("failed");
  });
});
