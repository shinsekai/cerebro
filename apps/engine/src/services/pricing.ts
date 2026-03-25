/**
 * Model pricing configuration (per 1M tokens as of 2025)
 */
export const MODEL_PRICING: Record<string, { input: number; output: number }> =
  {
    "claude-opus-4-6": { input: 15.0, output: 75.0 },
    "claude-sonnet-4-6": { input: 3.0, output: 15.0 },
    "claude-haiku-4-5-20251001": { input: 0.25, output: 1.25 },
  };

/**
 * Get pricing for a specific model
 * Falls back to Opus pricing for unknown models
 */
export function getPricingForModel(modelName: string): {
  input: number;
  output: number;
} {
  return MODEL_PRICING[modelName] || MODEL_PRICING["claude-opus-4-6"];
}

/**
 * Format cost for display
 */
export function formatCost(cost: number): string {
  return `$${cost.toFixed(4)}`;
}

/**
 * Extract input/output tokens and calculate cost from a model response
 */
export function extractTokenDetails(
  res: any,
  pricing: { input: number; output: number },
): {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
  cost: number;
} {
  const usage = res?.usage_metadata || {};
  const inputTokens = usage.input_tokens || 0;
  const outputTokens = usage.output_tokens || 0;
  const totalTokens = usage.total_tokens || inputTokens + outputTokens;

  const cost =
    (inputTokens / 1_000_000) * pricing.input +
    (outputTokens / 1_000_000) * pricing.output;

  return { inputTokens, outputTokens, totalTokens, cost };
}
