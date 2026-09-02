/**
 * Inference Router
 *
 * Decide, según el modelo configurado (config.inferenceModel), a qué
 * cliente de inferencia llamar. Formato del modelo: "proveedor/modelo",
 * por ejemplo "anthropic/claude-sonnet-4-5", "openai/gpt-5",
 * "google/gemini-2.5-pro", "groq/llama-3.3-70b", "ollama/qwen3:8b".
 *
 * Si no hay "/", se asume Anthropic (compatibilidad con configuraciones
 * previas que solo tenían el nombre del modelo, ej. "claude-sonnet-4-5").
 */

import type { ChatMessage, InferenceToolDefinition } from "../types.js";
import type { UnifiedInferenceResult } from "./types.js";
import { chatWithAnthropic } from "./anthropic-client.js";
import { chatWithGemini } from "./gemini-client.js";
import {
  chatWithOpenAICompatible,
  type OpenAICompatibleProvider,
} from "./openai-compatible-client.js";

const OPENAI_COMPATIBLE_PROVIDERS = new Set<string>([
  "openai",
  "groq",
  "openrouter",
  "grok",
  "modelstudio",
  "ollama",
]);

export function parseModelId(fullModelId: string): { provider: string; modelId: string } {
  const slashIndex = fullModelId.indexOf("/");
  if (slashIndex === -1) {
    return { provider: "anthropic", modelId: fullModelId };
  }
  return {
    provider: fullModelId.slice(0, slashIndex),
    modelId: fullModelId.slice(slashIndex + 1),
  };
}

export async function chat(params: {
  modelId: string; // "proveedor/modelo" o solo "modelo" (asume anthropic)
  messages: ChatMessage[];
  maxTokens?: number;
  temperature?: number;
  tools?: InferenceToolDefinition[];
}): Promise<UnifiedInferenceResult> {
  const { provider, modelId } = parseModelId(params.modelId);

  if (provider === "anthropic") {
    return chatWithAnthropic({ ...params, modelId });
  }
  if (provider === "google") {
    return chatWithGemini({ ...params, modelId });
  }
  if (OPENAI_COMPATIBLE_PROVIDERS.has(provider)) {
    return chatWithOpenAICompatible({
      ...params,
      provider: provider as OpenAICompatibleProvider,
      modelId,
    });
  }

  throw new Error(
    `Proveedor de inferencia desconocido: "${provider}". Proveedores soportados: anthropic, google, openai, groq, openrouter, grok, modelstudio, ollama.`,
  );
}
