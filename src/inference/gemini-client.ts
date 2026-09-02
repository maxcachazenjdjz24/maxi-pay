/**
 * Google Gemini Client
 *
 * Traduce entre el formato interno de mensajes (estilo OpenAI) y el
 * formato nativo de Gemini (contents con role "user"/"model", parts
 * con functionCall/functionResponse).
 */

import { GoogleGenAI } from "@google/genai";
import type { ChatMessage, InferenceToolCall, InferenceToolDefinition } from "../types.js";
import type { UnifiedInferenceResult } from "./types.js";

let client: GoogleGenAI | null = null;

function getClient(): GoogleGenAI {
  if (!client) {
    const apiKey = process.env.GOOGLE_API_KEY || process.env.GEMINI_API_KEY;
    if (!apiKey) {
      throw new Error("Falta la variable de entorno GOOGLE_API_KEY (o GEMINI_API_KEY).");
    }
    client = new GoogleGenAI({ apiKey });
  }
  return client;
}

function toGeminiTools(tools?: InferenceToolDefinition[]) {
  if (!tools || tools.length === 0) return undefined;
  return [
    {
      functionDeclarations: tools.map((t) => ({
        name: t.function.name,
        description: t.function.description,
        parameters: t.function.parameters as Record<string, unknown>,
      })),
    },
  ];
}

function toGeminiContents(messages: ChatMessage[]): {
  systemInstruction: string | undefined;
  contents: { role: string; parts: Record<string, unknown>[] }[];
} {
  const systemParts: string[] = [];
  const contents: { role: string; parts: Record<string, unknown>[] }[] = [];

  for (const msg of messages) {
    if (msg.role === "system") {
      systemParts.push(msg.content);
      continue;
    }
    if (msg.role === "tool") {
      contents.push({
        role: "function",
        parts: [
          {
            functionResponse: {
              name: msg.name || "unknown",
              response: { result: msg.content },
            },
          },
        ],
      });
      continue;
    }
    if (msg.role === "assistant" && msg.tool_calls && msg.tool_calls.length > 0) {
      const parts: Record<string, unknown>[] = [];
      if (msg.content) parts.push({ text: msg.content });
      for (const tc of msg.tool_calls) {
        parts.push({
          functionCall: {
            name: tc.function.name,
            args: JSON.parse(tc.function.arguments || "{}"),
          },
        });
      }
      contents.push({ role: "model", parts });
      continue;
    }
    contents.push({
      role: msg.role === "assistant" ? "model" : "user",
      parts: [{ text: msg.content }],
    });
  }

  return { systemInstruction: systemParts.length > 0 ? systemParts.join("\n\n") : undefined, contents };
}

export async function chatWithGemini(params: {
  modelId: string;
  messages: ChatMessage[];
  maxTokens?: number;
  temperature?: number;
  tools?: InferenceToolDefinition[];
}): Promise<UnifiedInferenceResult> {
  const startedAt = Date.now();
  const { systemInstruction, contents } = toGeminiContents(params.messages);

  const response = await getClient().models.generateContent({
    model: params.modelId,
    contents: contents as any,
    config: {
      systemInstruction,
      maxOutputTokens: params.maxTokens ?? 4096,
      temperature: params.temperature,
      tools: toGeminiTools(params.tools) as any,
    },
  });

  let text = "";
  const toolCalls: InferenceToolCall[] = [];
  const candidateParts = response.candidates?.[0]?.content?.parts || [];
  for (const part of candidateParts) {
    if (part.text) text += part.text;
    if (part.functionCall) {
      toolCalls.push({
        id: `call_${Date.now()}_${toolCalls.length}`,
        type: "function",
        function: {
          name: part.functionCall.name || "",
          arguments: JSON.stringify(part.functionCall.args || {}),
        },
      });
    }
  }

  const inputTokens = response.usageMetadata?.promptTokenCount ?? 0;
  const outputTokens = response.usageMetadata?.candidatesTokenCount ?? 0;

  return {
    content: text,
    toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
    usage: {
      inputTokens,
      outputTokens,
      totalTokens: inputTokens + outputTokens,
    },
    cost: {
      inputCostCredits: 0,
      outputCostCredits: 0,
      totalCostCredits: 0,
    },
    metadata: {
      providerId: "google",
      modelId: params.modelId,
      tier: "reasoning",
      latencyMs: Date.now() - startedAt,
      retries: 0,
      failedProviders: [],
    },
  };
}
