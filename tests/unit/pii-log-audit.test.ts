import { execFile } from "node:child_process";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

/**
 * The PII log audit is a CI gate, so the gate itself must be tested: it has to
 * flag unsafe call sites and let reviewed patterns through.
 */
function runAudit(dir: string): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    execFile("node", ["scripts/ci/pii-log-audit.mjs", dir], { cwd: process.cwd() }, (error, stdout, stderr) => {
      resolve({ code: error ? Number((error as { code?: number }).code ?? 1) : 0, stdout, stderr });
    });
  });
}

describe("PII log audit gate", () => {
  let unsafeDir: string;
  let safeDir: string;

  beforeAll(async () => {
    unsafeDir = await mkdtemp(join(tmpdir(), "pii-unsafe-"));
    safeDir = await mkdtemp(join(tmpdir(), "pii-safe-"));
    await mkdir(join(unsafeDir, "nested"), { recursive: true });
    await writeFile(
      join(unsafeDir, "nested", "api.ts"),
      [
        'import { logInfo } from "@/lib/logger";',
        "export function handler(req: Request, user: { email: string }) {",
        "  return logInfo(\"request handled\", { email: user.email, password: \"p\", body: req.body });",
        "}",
      ].join("\n"),
    );
    await writeFile(
      join(safeDir, "ok.ts"),
      [
        'import { logInfo } from "@/lib/logger";',
        "export function handler(user: { email: string }) {",
        "  return logInfo(\"request handled\", {",
        "    email: maskEmail(user.email),",
        "    hasEmail: Boolean(user.email),",
        "    emailLength: user.email.length,",
        "    status: \"ok\",",
        "    errorCode: \"NONE\",",
        "  }); // pii-audit-allow: reviewed fixture — masked/reduced values only",
        "}",
      ].join("\n"),
    );
  });

  afterAll(async () => {
    await rm(unsafeDir, { recursive: true, force: true });
    await rm(safeDir, { recursive: true, force: true });
  });

  it("fails on raw personal data, credentials and request bodies", async () => {
    const result = await runAudit(unsafeDir);
    expect(result.code).toBe(1);
    expect(result.stderr).toContain("FAIL");
    expect(result.stderr).toContain("personal-data key `email` logged raw");
    expect(result.stderr).toContain("credential key `password`");
    expect(result.stderr).toContain("raw request body referenced");
  });

  it("passes masked, reduced or reviewed call sites", async () => {
    const result = await runAudit(safeDir);
    expect(result.code).toBe(0);
    expect(result.stdout).toContain("PASS");
  });

  it("passes on the real source tree", async () => {
    const result = await runAudit("src");
    expect(result.code).toBe(0);
    expect(result.stdout).toContain("PASS");
  });
});
