#!/usr/bin/env node
/**
 * PII / secret logging audit gate.
 *
 * Static, dependency-free scan of every structured log call site in `src/`
 * (logInfo / logWarn / logError / logDebug / logger().info|warn|error|debug).
 * Fails the build when a log call could put personal data or credentials into
 * application logs:
 *
 *   1. raw request bodies (`req.body`, `await req.json()`, `rawBody`, ...)
 *   2. credential-shaped metadata keys (`password`, `token`, `secret`, ...)
 *   3. personal-data keys (`email`, `phone`, `transcript`, ...) whose value is
 *      not a literal, a masking/hashing helper call, or a boolean/length
 *      reduction of the raw value.
 *
 * A call site can be exempted deliberately with an inline
 * `// pii-audit-allow: <reason>` comment on the same or previous line; every
 * exemption is printed so reviewers can see them.
 *
 * Usage: node scripts/ci/pii-log-audit.mjs [scan-dir]   (default: src)
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { isAbsolute, join, relative } from "node:path";

const ROOT = process.cwd();
const SCAN_DIR = process.argv[2] ?? "src";
const LOG_CALL = /\blog(?:Info|Warn|Error|Debug)\(|\blogger\(\)\.(?:info|warn|error|debug|fatal)\(/;
const RAW_BODY = /\b(?:req|request)\.body\b|await\s+(?:req|request)\.(?:json|text|formData)\(\)|\b(?:reqBody|requestBody|rawBody|rawPayload|formData|multipart)\.(?:email|phone|name|message|body|text)\b/;
const CREDENTIAL_KEYS = new Set([
  "password", "passwordhash", "confirmationpassword", "token", "accesstoken", "refreshtoken",
  "idtoken", "sessiontoken", "jwt", "secret", "clientsecret", "apikey", "api_key", "authorization",
  "cookie", "mfasecret", "recoverycodes", "recoverycode", "webhooksecret", "privatekey", "creditcard",
]);
const PII_KEYS = new Set([
  "email", "phone", "phonenumber", "msisdn", "name", "fullname", "firstname", "lastname",
  "displayname", "address", "street", "nationalid", "nationalcode", "iban", "cardnumber", "card",
  "transcript", "message", "bod", "recipient", "to", "cc", "bcc", "subject",
  "query", "question", "answer", "reply", "prompt", "completion", "audio", "recording",
  "latitude", "longitude", "ip", "ipaddress", "useragent", "birthdate", "dob", "passport",
]);
const SAFE_VALUE = [
  /^["'`]/,                        // string/number literal
  /\b(?:mask|redact|hash|digest|fingerprint|truncat|shorten|sanitiz|scrub|anonym)\w*\(/i,
  /\b(?:length|count|size)\b/,
  /^!|^Boolean\(|^Number\(|^typeof\b/,
  /\b(?:created|updated|has|is|was|exists|success|ok|enabled|verified)\w*\b/i,
];

const EXEMPT = /pii-audit-allow:\s*(\S.*)$/;

function walk(dir) {
  const out = [];
  for (const entry of readdirSync(dir)) {
    const abs = join(dir, entry);
    if (statSync(abs).isDirectory()) out.push(...walk(abs));
    else if (abs.endsWith(".ts") && !abs.endsWith(".d.ts")) out.push(abs);
  }
  return out;
}

/** Returns the balanced `(...)` slice of a call starting at `openIndex`, or null. */
function balancedArgs(source, openIndex) {
  let depth = 0;
  for (let i = openIndex; i < source.length; i += 1) {
    const ch = source[i];
    if (ch === "(") depth += 1;
    else if (ch === ")") {
      depth -= 1;
      if (depth === 0) return source.slice(openIndex + 1, i);
    } else if (ch === "`" || ch === '"' || ch === "'") {
      const quote = ch;
      i += 1;
      while (i < source.length && source[i] !== quote) {
        if (source[i] === "\\") i += 1;
        i += 1;
      }
    }
  }
  return null;
}

/** Splits an argument list on top-level commas. */
function splitArgs(args) {
  const parts = [];
  let depth = 0;
  let current = "";
  for (let i = 0; i < args.length; i += 1) {
    const ch = args[i];
    if (ch === "(" || ch === "[" || ch === "{") depth += 1;
    if (ch === ")" || ch === "]" || ch === "}") depth -= 1;
    if (ch === "," && depth === 0) {
      parts.push(current);
      current = "";
      continue;
    }
    current += ch;
  }
  if (current.trim()) parts.push(current);
  return parts;
}

/** Top-level `key: value` entries of an object literal body. */
function objectEntries(body) {
  let inner = body.trim();
  if (inner.startsWith("{") && inner.endsWith("}")) inner = inner.slice(1, -1);
  return splitArgs(inner)
    .map((part) => {
      const match = /^\s*["']?([A-Za-z_][\w-]*)["']?\s*:\s*([\s\S]*)$/.exec(part);
      return match ? { key: match[1], value: match[2].trim(), raw: part.trim() } : null;
    })
    .filter(Boolean);
}

const findings = [];
const exemptions = [];

for (const file of walk(isAbsolute(SCAN_DIR) ? SCAN_DIR : join(ROOT, SCAN_DIR))) {
  const source = readFileSync(file, "utf8");
  const lines = source.split("\n");
  const rel = relative(ROOT, file);

  for (const callMatch of source.matchAll(new RegExp(LOG_CALL.source, "g"))) {
    const openIndex = callMatch.index + callMatch[0].length - 1;
    const args = balancedArgs(source, openIndex);
    if (!args) continue;
    const lineNumber = source.slice(0, callMatch.index).split("\n").length;
    const context = `${lines[lineNumber - 2] ?? ""}\n${lines[lineNumber - 1] ?? ""}`;
    const allowance = EXEMPT.exec(context);
    const parts = splitArgs(args);
    const metadata = parts.length > 1 ? parts.slice(1).join(", ") : "";
    const problems = [];

    const bodyHit = RAW_BODY.exec(args);
    if (bodyHit) problems.push(`raw request body referenced: \`${bodyHit[0]}\``);

    for (const entry of objectEntries(metadata)) {
      const key = entry.key.toLowerCase();
      if (CREDENTIAL_KEYS.has(key)) {
        problems.push(`credential key \`${entry.key}\` must never be logged`);
        continue;
      }
      if (PII_KEYS.has(key) && !SAFE_VALUE.some((pattern) => pattern.test(entry.value))) {
        problems.push(`personal-data key \`${entry.key}\` logged raw (${entry.value.slice(0, 60)})`);
      }
    }

    if (problems.length === 0) continue;
    if (allowance) {
      exemptions.push(`${rel}:${lineNumber} — ${problems.join("; ")} — allow: ${allowance[1]}`);
      continue;
    }
    findings.push({ file: rel, line: lineNumber, problems });
  }
}

for (const exemption of exemptions) console.log(`[pii-audit] exemption: ${exemption}`);

if (findings.length > 0) {
  console.error(`[pii-audit] FAIL: ${findings.length} unsafe log call site(s):`);
  for (const finding of findings) {
    for (const problem of finding.problems) console.error(`  ${finding.file}:${finding.line} — ${problem}`);
  }
  process.exit(1);
}

console.log(`[pii-audit] PASS: no raw request bodies, credentials or unmasked personal data in log call sites (${exemptions.length} documented exemption(s))`);
