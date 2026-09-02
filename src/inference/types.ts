/**
 * Inference Types (versión simplificada)
 *
 * A diferencia del original (que soportaba 5+ proveedores OpenAI-
 * compatibles con circuit breakers y fallback complejo), aquí nos
 * enfocamos en Anthropic como proveedor principal, con OpenAI como
 * alternativa simple si el operador prefiere usarlo.
 */

export type ModelTier = "reasoning" | "fast" | "cheap";

export interface UnifiedInferenceResult {
  content: string;
  toolCalls?: unknown[];
  usage: {
    inputTokens: number;
    outputTokens: number;
    totalTokens: number;
  };
  cost: {
    inputCostCredits: number;
    outputCostCredits: number;
    totalCostCredits: number;
  };
  metadata: {
    providerId: string;
    modelId: string;
    tier: ModelTier;
    latencyMs: number;
    retries: number;
    failedProviders: string[];
  };
}
