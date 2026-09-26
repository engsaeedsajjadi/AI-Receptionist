import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

interface WFNode {
  id?: string;
  name: string;
  type: string;
  parameters?: Record<string, unknown>;
  credentials?: Record<string, { id?: string | null; name?: string }>;
}

interface Workflow {
  name: string;
  nodes: WFNode[];
  connections: Record<string, { main: Array<Array<{ node: string }>> }>;
}

const N8N_DIR = join(__dirname, "..", "..", "n8n");
const FILES = readdirSync(N8N_DIR).filter((f) => f.endsWith(".json"));

function load(file: string): Workflow {
  return JSON.parse(readFileSync(join(N8N_DIR, file), "utf8")) as Workflow;
}

describe("n8n workflow contracts", () => {
  it("ships one workflow per automation event", () => {
    expect(FILES.sort()).toEqual(
      ["appointment.json", "call-completed.json", "human-handoff.json", "new-lead.json", "notification.json"],
    );
  });

  for (const file of FILES) {
    const event = file.replace(/\.json$/, "");
    describe(file, () => {
      const wf = load(file);

      it("has a headerAuth webhook trigger for its event path", () => {
        const webhooks = wf.nodes.filter((n) => n.type === "n8n-nodes-base.webhook");
        expect(webhooks).toHaveLength(1);
        const wh = webhooks[0];
        expect(wh.parameters).toMatchObject({
          path: `ai-receptionist/${event}`,
          httpMethod: "POST",
          responseMode: "responseNode",
          authentication: "headerAuth",
        });
        expect(wh.credentials?.httpHeaderAuth?.name).toBe("AI Receptionist Automation Token");
      });

      it("contains no static-data dedup or HMAC verification code", () => {
        const raw = JSON.stringify(wf);
        expect(raw).not.toContain("getWorkflowStaticData");
        expect(raw).not.toContain("staticData");
        expect(raw).not.toContain("x-webhook-signature");
        expect(raw).not.toContain("createHmac");
        expect(raw).not.toContain("TELEGRAM_BOT_TOKEN");
        expect(raw).not.toContain("SMS_WEBHOOK_URL");
        for (const n of wf.nodes) {
          expect(n.name).not.toMatch(/dedup|verify signature/i);
          expect(n.type).not.toMatch(/\.if$|\.switch$/);
        }
      });

      it("routes side effects through the app dispatch endpoint", () => {
        const http = wf.nodes.filter((n) => n.type === "n8n-nodes-base.httpRequest");
        expect(http.length).toBeGreaterThanOrEqual(1);
        for (const n of http) {
          const params = n.parameters as Record<string, unknown>;
          expect(String(params.url)).toContain("/api/v1/automation/dispatch");
          expect(String(params.url)).toContain("$env.APP_BASE_URL");
          const headers = (
            (params.headerParameters as { parameters?: Array<{ name: string; value: string }> })
              ?.parameters ?? []
          ).map((h) => `${h.name}: ${h.value}`);
          expect(headers.join("\n")).toContain("Authorization");
          expect(headers.join("\n")).toContain("$env.N8N_API_KEY");
        }
      });

      it("propagates the idempotency key and reports the dispatch outcome", () => {
        const raw = JSON.stringify(wf);
        expect(raw).toContain("idempotencyKey");
        const respond = wf.nodes.filter((n) => n.type === "n8n-nodes-base.respondToWebhook");
        expect(respond).toHaveLength(1);
        expect(String((respond[0].parameters as Record<string, unknown>).responseBody)).toContain(
          "duplicate",
        );
      });

      it("forms a single linear chain from webhook to respond", () => {
        const webhook = wf.nodes.find((n) => n.type === "n8n-nodes-base.webhook")!.name;
        const seen = new Set<string>();
        let current: string | undefined = webhook;
        while (current) {
          expect(seen.has(current)).toBe(false);
          seen.add(current);
          const next: string | undefined = wf.connections[current]?.main?.[0]?.[0]?.node;
          current = next;
        }
        expect(seen.size).toBe(wf.nodes.length);
        expect([...seen].pop()).toBe(
          wf.nodes.find((n) => n.type === "n8n-nodes-base.respondToWebhook")!.name,
        );
      });
    });
  }
});
