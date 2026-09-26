export interface LLMProvider {
  name: string;
  complete(prompt: string, context?: Record<string, unknown>): Promise<string>;
}

export class OpenAIProvider implements LLMProvider {
  name = "openai";
  async complete(prompt: string): Promise<string> {
    return `MOCK_RESPONSE: ${prompt.slice(0, 120)}`;
  }
}

export class CompatibleProvider implements LLMProvider {
  name = "compatible";
  async complete(prompt: string): Promise<string> {
    return `MOCK_RESPONSE: ${prompt.slice(0, 120)}`;
  }
}

export interface NotificationProvider {
  send(recipient: string, message: string): Promise<{ ok: boolean; id?: string }>;
}

export class ConsoleNotificationProvider implements NotificationProvider {
  async send(recipient: string, message: string) {
    console.log("notification", { recipient, message });
    return { ok: true, id: crypto.randomUUID() };
  }
}
