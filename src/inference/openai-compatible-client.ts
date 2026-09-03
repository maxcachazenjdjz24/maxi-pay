/**
 * OpenAI-Compatible Client
 *
 * Un solo cliente para todos los proveedores que hablan el formato de
 * API de OpenAI: OpenAI, Groq, OpenRouter, Grok (xAI), Alibaba Cloud
 * Model Studio (DashScope), y Ollama local. Cada uno solo cambia la
 * URL base y la variable de entorno de la API key.
 */

import OpenAI from "openai";
import type { ChatMessage, InferenceToolCall, InferenceToolDefinition } from "../types.js";
import type { UnifiedInferenceResult } from "./types.js";

export type OpenAICompatibleProvider =
  | "openai"
  | "groq"
  | "openrouter"
  | "grok"
  | "modelstudio"
  | "ollama";

interface ProviderDef {
  baseUrl: string;
  apiKeyEnvVar: string;
  /** Ollama no necesita key real; cualquier string sirve. */
  requiresKey: boolean;
}

const PROVIDERS: Record<OpenAICompatibleProvider, ProviderDef> = {
  openai: {
    baseUrl: "https://api.openai.com/v1",
    apiKeyEnvVar: "OPENAI_API_KEY",
    requiresKey: true,
  },
  groq: {
    baseUrl: "https://api.groq.com/openai/v1",
    apiKeyEnvVar: "GROQ_API_KEY",
    requiresKey: true,
  },
  openrouter: {
    baseUrl: "https://openrouter.ai/api/v1",
    apiKeyEnvVar: "OPENROUTER_API_KEY",
    requiresKey: true,
  },
  grok: {
    baseUrl: "https://api.x.ai/v1",
    apiKeyEnvVar: "GROK_API_KEY",
    requiresKey: true,
  },
  modelstudio: {
    // Endpoint internacional (compatible-mode). Para China continental,
    // usar https://dashscope.aliyuncs.com/compatible-mode/v1 en su lugar
    // (ver AUTOMATON_MODELSTUDIO_BASE_URL abajo para sobreescribir).
    baseUrl: "https://dashscope-intl.aliyuncs.com/compatible-mode/v1",
    apiKeyEnvVar: "MODELSTUDIO_API_KEY",
    requiresKey: true,
  },
  ollama: {
    baseUrl: "http://localhost:11434/v1",
    apiKeyEnvVar: "OLLAMA_API_KEY", // no usada realmente, Ollama no valida key
    requiresKey: false,
  },
};

const clients = new Map<OpenAICompatibleProvider, OpenAI>();

function getApiKey(provider: OpenAICompatibleProvider, defaultEnvVar: string): string | undefined {
  if (provider === "modelstudio") {
    return (
      process.env.MODELSTUDIO_API_KEY ||
      process.env.DASHSCOPE_API_KEY ||
      process.env.ALIBABA_API_KEY
    );
  }
  return process.env[defaultEnvVar];
}

function getBaseUrl(provider: OpenAICompatibleProvider, defaultUrl: string): string {
  const baseUrlOverrideEnv = `AUTOMATON_${provider.toUpperCase()}_BASE_URL`;
  if (process.env[baseUrlOverrideEnv]) {
    return process.env[baseUrlOverrideEnv]!;
  }
  if (provider === "modelstudio" && process.env.DASHSCOPE_BASE_URL) {
    return process.env.DASHSCOPE_BASE_URL;
  }
  return defaultUrl;
}

function getClient(provider: OpenAICompatibleProvider): OpenAI {
  const cached = clients.get(provider);
  if (cached) return cached;

  const def = PROVIDERS[provider];
  const apiKey = getApiKey(provider, def.apiKeyEnvVar);
  if (def.requiresKey && !apiKey) {
    throw new Error(
      `Falta la variable de entorno ${def.apiKeyEnvVar} para el proveedor "${provider}".`,
    );
  }

  const baseUrl = getBaseUrl(provider, def.baseUrl);
  const client = new OpenAI({ apiKey: apiKey || "not-required", baseURL: baseUrl });
  clients.set(provider, client);
  return client;
}

function toOpenAIMessages(messages: ChatMessage[]): OpenAI.ChatCompletionMessageParam[] {
  return messages.map((m) => {
    if (m.role === "tool") {
      return {
        role: "tool",
        content: m.content,
        tool_call_id: m.tool_call_id || "",
      };
    }
    if (m.role === "assistant" && m.tool_calls && m.tool_calls.length > 0) {
      return {
        role: "assistant",
        content: m.content || null,
        tool_calls: m.tool_calls.map((tc) => ({
          id: tc.id,
          type: "function" as const,
          function: { name: tc.function.name, arguments: tc.function.arguments },
        })),
      };
    }
    return { role: m.role as "system" | "user" | "assistant", content: m.content };
  });
}

function toOpenAITools(tools?: InferenceToolDefinition[]): OpenAI.ChatCompletionTool[] | undefined {
  if (!tools || tools.length === 0) return undefined;
  return tools.map((t) => ({
    type: "function",
    function: {
      name: t.function.name,
      description: t.function.description,
      parameters: t.function.parameters,
    },
  }));
}

export async function chatWithOpenAICompatible(params: {
  provider: OpenAICompatibleProvider;
  modelId: string;
  messages: ChatMessage[];
  maxTokens?: number;
  temperature?: number;
  tools?: InferenceToolDefinition[];
}): Promise<UnifiedInferenceResult> {
  const startedAt = Date.now();
  const client = getClient(params.provider);

  const response = await client.chat.completions.create({
    model: params.modelId,
    messages: toOpenAIMessages(params.messages),
    max_tokens: params.maxTokens ?? 4096,
    temperature: params.temperature,
    tools: toOpenAITools(params.tools),
  });

  const choice = response.choices[0];
  const toolCalls: InferenceToolCall[] = (choice.message.tool_calls || [])
    .filter((tc): tc is OpenAI.ChatCompletionMessageFunctionToolCall => tc.type === "function")
    .map((tc) => ({
      id: tc.id,
      type: "function",
      function: { name: tc.function.name, arguments: tc.function.arguments },
    }));

  const inputTokens = response.usage?.prompt_tokens ?? 0;
  const outputTokens = response.usage?.completion_tokens ?? 0;

  return {
    content: choice.message.content || "",
    toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
    usage: {
      inputTokens,
      outputTokens,
      totalTokens: inputTokens + outputTokens,
    },
    cost: {
      // El costo exacto depende del proveedor/modelo; sin tabla de precios
      // por proveedor todavía, se deja en 0 y se puede refinar por
      // proveedor más adelante si se necesita seguimiento de gasto exacto.
      inputCostCredits: 0,
      outputCostCredits: 0,
      totalCostCredits: 0,
    },
    metadata: {
      providerId: params.provider,
      modelId: params.modelId,
      tier: "reasoning",
      latencyMs: Date.now() - startedAt,
      retries: 0,
      failedProviders: [],
    },
  };
}
