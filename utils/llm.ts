type ChatMessage = { role: "system" | "user" | "assistant"; content: string };

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
  };
  const content = data.choices?.[0]?.message?.content ?? "";
  if (!content) {
    throw new Error("OpenRouter response is empty.");
  }
  return content;
}
