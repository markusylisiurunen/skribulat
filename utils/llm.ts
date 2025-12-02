type TextPart = { type: "text"; text: string; cache_control?: { type: "ephemeral" } };
type ContentPart = TextPart;

type ChatMessageSimple = { role: "system" | "user" | "assistant"; content: string };
type ChatMessageMultipart = { role: "system" | "user" | "assistant"; content: ContentPart[] };
export type ChatMessage = ChatMessageSimple | ChatMessageMultipart;

const SESSION_ID = crypto.randomUUID();

export function buildMessage(
  role: "system" | "user" | "assistant",
  text: string,
  cache?: boolean,
): ChatMessage {
  if (!cache) return { role, content: text };
  return { role, content: [{ type: "text", text, cache_control: { type: "ephemeral" } }] };
}

export function buildMultipartMessage(
  role: "system" | "user" | "assistant",
  parts: Array<{ text: string; cache?: boolean }>,
): ChatMessage {
  const content: ContentPart[] = parts.map((p) =>
    p.cache
      ? { type: "text", text: p.text, cache_control: { type: "ephemeral" } }
      : { type: "text", text: p.text }
  );
  return { role, content };
}

export type CompletionUsage = {
  promptTokens: number;
  cachedTokens: number;
  completionTokens: number;
  cost: number;
};

export type CompletionResult = {
  content: string;
  usage: CompletionUsage;
};

type GenerateCompletionArgs = {
  disableReasoning?: boolean;
  maxTokens?: number;
  messages?: ChatMessage[];
  model: string;
  prompt?: string;
  provider?: { order?: string[]; allowFallbacks?: boolean };
  reasoningEffort?: "none" | "minimal" | "low" | "medium" | "high";
  reasoningMaxTokens?: number;
  systemInstructions?: string;
  temperature?: number;
  responseFormat?: { type: string };
};

export function unwrapJsonFence(text: string) {
  const trimmed = text.trim();
  if (trimmed.startsWith("{")) return trimmed;
  if (trimmed.startsWith("[")) return trimmed;
  const match = trimmed.match(/```(?:json)?\s*([\s\S]*?)\s*```/i);
  return match ? match[1].trim() : trimmed;
}

export async function generateCompletion(args: GenerateCompletionArgs) {
  const apiKey = Deno.env.get("OPENROUTER_API_KEY");
  if (!apiKey) {
    throw new Error("OPENROUTER_API_KEY is not set.");
  }
  const messages: ChatMessage[] = [];
  if (args.messages && args.messages.length > 0) {
    messages.push(...args.messages);
  } else {
    if (args.systemInstructions) {
      messages.push({ role: "system", content: args.systemInstructions });
    }
    if (args.prompt) {
      messages.push({ role: "user", content: args.prompt });
    }
  }
  if (messages.length === 0) {
    throw new Error("generateCompletion requires either messages or prompt.");
  }
  if (args.systemInstructions && args.messages && args.messages.length > 0) {
    messages.unshift({ role: "system", content: args.systemInstructions });
  }
  let reasoning: Record<string, unknown> | undefined = undefined;
  if (args.disableReasoning) {
    reasoning = { enabled: false };
  } else if ((args.reasoningMaxTokens ?? 0) > 0) {
    reasoning = { enabled: true, max_tokens: args.reasoningMaxTokens };
  } else if (args.reasoningEffort) {
    reasoning = { enabled: true, effort: args.reasoningEffort };
  }
  const response = await fetch("https://openrouter.ai/api/v1/chat/completions", {
    body: JSON.stringify({
      max_tokens: args.maxTokens ?? undefined,
      messages,
      model: args.model,
      reasoning,
      response_format: args.responseFormat,
      temperature: args.temperature,
      user: SESSION_ID,
      provider: args.provider
        ? { order: args.provider.order, allow_fallbacks: args.provider.allowFallbacks }
        : undefined,
    }),
    headers: {
      "Authorization": `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    method: "POST",
  });
  if (!response.ok || response.status !== 200) {
    throw new Error(`OpenRouter request failed: ${await response.text()}`);
  }
  const data = await response.json() as {
    choices?: Array<{ message?: { content?: string } }>;
    usage?: {
      prompt_tokens?: number;
      completion_tokens?: number;
      total_tokens?: number;
      total_cost?: number;
    };
  };
  const content = data.choices?.[0]?.message?.content ?? "";
  if (!content) {
    throw new Error("OpenRouter response is empty.");
  }
  return content;
}

export async function generateCompletionWithUsage(
  args: GenerateCompletionArgs,
): Promise<CompletionResult> {
  const apiKey = Deno.env.get("OPENROUTER_API_KEY");
  if (!apiKey) {
    throw new Error("OPENROUTER_API_KEY is not set.");
  }
  const messages: ChatMessage[] = [];
  if (args.messages && args.messages.length > 0) {
    messages.push(...args.messages);
  } else {
    if (args.systemInstructions) {
      messages.push({ role: "system", content: args.systemInstructions });
    }
    if (args.prompt) {
      messages.push({ role: "user", content: args.prompt });
    }
  }
  if (messages.length === 0) {
    throw new Error("generateCompletion requires either messages or prompt.");
  }
  if (args.systemInstructions && args.messages && args.messages.length > 0) {
    messages.unshift({ role: "system", content: args.systemInstructions });
  }
  let reasoning: Record<string, unknown> | undefined = undefined;
  if (args.disableReasoning) {
    reasoning = { enabled: false };
  } else if ((args.reasoningMaxTokens ?? 0) > 0) {
    reasoning = { enabled: true, max_tokens: args.reasoningMaxTokens };
  } else if (args.reasoningEffort) {
    reasoning = { enabled: true, effort: args.reasoningEffort };
  }
  const response = await fetch("https://openrouter.ai/api/v1/chat/completions", {
    body: JSON.stringify({
      max_tokens: args.maxTokens ?? undefined,
      messages,
      model: args.model,
      reasoning,
      response_format: args.responseFormat,
      temperature: args.temperature,
      user: SESSION_ID,
      provider: args.provider
        ? { order: args.provider.order, allow_fallbacks: args.provider.allowFallbacks }
        : undefined,
      usage: { include: true },
    }),
    headers: {
      "Authorization": `Bearer ${apiKey}`,
      "Content-Type": "application/json",
    },
    method: "POST",
  });
  if (!response.ok || response.status !== 200) {
    throw new Error(`OpenRouter request failed: ${await response.text()}`);
  }
  const data = await response.json() as {
    choices?: Array<{ message?: { content?: string } }>;
    usage?: {
      prompt_tokens?: number;
      prompt_tokens_details?: { cached_tokens?: number };
      completion_tokens?: number;
      cost?: number;
    };
  };
  const content = data.choices?.[0]?.message?.content ?? "";
  if (!content) {
    throw new Error("OpenRouter response is empty.");
  }
  const usage: CompletionUsage = {
    promptTokens: data.usage?.prompt_tokens ?? 0,
    cachedTokens: data.usage?.prompt_tokens_details?.cached_tokens ?? 0,
    completionTokens: data.usage?.completion_tokens ?? 0,
    cost: data.usage?.cost ?? 0,
  };
  return { content, usage };
}
