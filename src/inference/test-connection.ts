/**
 * Test Inference Connection
 *
 * Utility to verify API keys, connectivity, and tool calling
 * with the configured inference provider.
 */

import { chat as chatWithInference, parseModelId } from "./router.js";
import type { ChatMessage, InferenceToolDefinition } from "../types.js";

export async function testInferenceConnection(modelId: string): Promise<{
  success: boolean;
  provider: string;
  model: string;
  response?: string;
  toolCallWorked?: boolean;
  latencyMs?: number;
  error?: string;
}> {
  const { provider, modelId: model } = parseModelId(modelId);
  const startedAt = Date.now();

  const testTools: InferenceToolDefinition[] = [
    {
      type: "function",
      function: {
        name: "get_test_value",
        description: "Returns a test value to confirm tool calling works.",
        parameters: {
          type: "object",
          properties: {
            message: { type: "string", description: "Test message" },
          },
          required: ["message"],
        },
      },
    },
  ];

  const messages: ChatMessage[] = [
    {
      role: "system",
      content: "You are a testing assistant. When asked to call get_test_value, ALWAYS call get_test_value with message=\"ok\".",
    },
    {
      role: "user",
      content: "Please call the get_test_value function with message=\"ok\".",
    },
  ];

  try {
    const result = await chatWithInference({
      modelId,
      messages,
      maxTokens: 500,
      tools: testTools,
    });

    const hasToolCall = (result.toolCalls && result.toolCalls.length > 0) || false;
    return {
      success: true,
      provider,
      model,
      response: result.content,
      toolCallWorked: hasToolCall,
      latencyMs: Date.now() - startedAt,
    };
  } catch (err: any) {
    return {
      success: false,
      provider,
      model,
      latencyMs: Date.now() - startedAt,
      error: err.message || String(err),
    };
  }
}
