/**
 * Anthropic Inference Client
 *
 * Módulo nuevo (no existía en el original — Conway actuaba como proxy
 * OpenAI-compatible hacia Claude). Llama directamente a la API de
 * Anthropic usando su SDK oficial, traduciendo entre nuestro formato
 * interno de mensajes (estilo OpenAI: role/tool_calls) y el formato
 * nativo de Anthropic (system aparte, content con bloques tool_use/
 * tool_result).
 */

import Anthropic from "@anthropic-ai/sdk";
import type { ChatMessage, InferenceToolCall, InferenceToolDefinition } from "../types.js";
import type { UnifiedInferenceResult } from "./types.js";

let client: Anthropic | null = null;

function getClient(): Anthropic {
  if (!client) {
    const apiKey = process.env.ANTHROPIC_API_KEY;
    if (!apiKey) {
      throw new Error("ANTHROPIC_API_KEY no está definida.");
    }
    client = new Anthropic({ apiKey });
  }
  return client;
}

/** Precios aproximados por millón de tokens (input/output), en USD. */
const MODEL_PRICING: Record<string, { input: number; output: number }> = {
  "claude-sonnet-4-5": { input: 3.0, output: 15.0 },
  "claude-opus-4-6": { input: 15.0, output: 75.0 },
  "claude-haiku-4-5": { input: 0.8, output: 4.0 },
};

function toAnthropicTools(tools?: InferenceToolDefinition[]): Anthropic.Tool[] | undefined {
  if (!tools || tools.length === 0) return undefined;
  return tools.map((t) => ({
    name: t.function.name,
    description: t.function.description,
    input_schema: t.function.parameters as Anthropic.Tool.InputSchema,
  }));
}

function toAnthropicMessages(messages: ChatMessage[]): {
  system: string | undefined;
  messages: Anthropic.MessageParam[];
} {
  const systemParts: string[] = [];
  const converted: Anthropic.MessageParam[] = [];

  for (const msg of messages) {
    if (msg.role === "system") {
      systemParts.push(msg.content);
      continue;
    }

    if (msg.role === "tool") {
      converted.push({
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: msg.tool_call_id || "",
            content: msg.content,
          },
        ],
      });
      continue;
    }

    if (msg.role === "assistant" && msg.tool_calls && msg.tool_calls.length > 0) {
      const contentBlocks: Anthropic.ContentBlockParam[] = [];
      if (msg.content) {
        contentBlocks.push({ type: "text", text: msg.content });
      }
      for (const tc of msg.tool_calls) {
        contentBlocks.push({
          type: "tool_use",
          id: tc.id,
          name: tc.function.name,
          input: JSON.parse(tc.function.arguments || "{}"),
        });
      }
      converted.push({ role: "assistant", content: contentBlocks });
      continue;
    }

    converted.push({
      role: msg.role === "assistant" ? "assistant" : "user",
      content: msg.content,
    });
  }

  return {
    system: systemParts.length > 0 ? systemParts.join("\n\n") : undefined,
    messages: converted,
  };
}

function fromAnthropicResponse(
  response: Anthropic.Message,
  modelId: string,
  latencyMs: number,
): UnifiedInferenceResult {
  let text = "";
  const toolCalls: InferenceToolCall[] = [];

  for (const block of response.content) {
    if (block.type === "text") {
      text += block.text;
    } else if (block.type === "tool_use") {
      toolCalls.push({
        id: block.id,
        type: "function",
        function: {
          name: block.name,
          arguments: JSON.stringify(block.input),
        },
      });
    }
  }

  const pricing = MODEL_PRICING[modelId] || { input: 3.0, output: 15.0 };
  const inputTokens = response.usage.input_tokens;
  const outputTokens = response.usage.output_tokens;

  return {
    content: text,
    toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
    usage: {
      inputTokens,
      outputTokens,
      totalTokens: inputTokens + outputTokens,
    },
    cost: {
      inputCostCredits: (inputTokens / 1_000_000) * pricing.input,
      outputCostCredits: (outputTokens / 1_000_000) * pricing.output,
      totalCostCredits:
        (inputTokens / 1_000_000) * pricing.input +
        (outputTokens / 1_000_000) * pricing.output,
    },
    metadata: {
      providerId: "anthropic",
      modelId,
      tier: "reasoning",
      latencyMs,
      retries: 0,
      failedProviders: [],
    },
  };
}

export async function chatWithAnthropic(params: {
  modelId: string;
  messages: ChatMessage[];
  maxTokens?: number;
  temperature?: number;
  tools?: InferenceToolDefinition[];
}): Promise<UnifiedInferenceResult> {
  const startedAt = Date.now();
  const { system, messages } = toAnthropicMessages(params.messages);

  const response = await getClient().messages.create({
    model: params.modelId,
    max_tokens: params.maxTokens ?? 4096,
    temperature: params.temperature,
    system,
    messages,
    tools: toAnthropicTools(params.tools),
  });

  return fromAnthropicResponse(response, params.modelId, Date.now() - startedAt);
}
