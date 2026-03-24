import { CEREBRO_TOOLS, getModelForAgent } from "@cerebro/core";
import { ChatAnthropic } from "@langchain/anthropic";

interface ModelOptions {
  lightweight?: boolean;
}

/**
 * Common getter for Tier 2 agents.
 *
 * Configures the base model with low temperature for deterministic code output.
 * Uses agent-specific model configuration from environment variables.
 *
 * @param agentType - The specific agent type (e.g., "frontend", "backend") for model selection
 * @param options - Optional lightweight flag to use cheaper/faster model for simple tasks
 * @returns Configured ChatAnthropic model instance
 */
export const getTier2Model = (agentType?: string, options?: ModelOptions) => {
  const { lightweight = false } = options ?? {};

  // If lightweight mode, use the lightweight model
  if (lightweight) {
    return new ChatAnthropic({
      model: getModelForAgent("lightweight"),
      temperature: 0.2,
      apiKey: process.env.ANTHROPIC_API_KEY || "not_provided",
    });
  }

  return new ChatAnthropic({
    model: agentType ? getModelForAgent(agentType) : "claude-sonnet-4-6",
    temperature: 0.2, // Low temperature for high precision coding
    apiKey: process.env.ANTHROPIC_API_KEY || "not_provided",
  });
};

/**
 * Tier 2 model with CEREBRO tools bound for agentic loop execution.
 *
 * @param agentType - The specific agent type for model selection
 * @param options - Optional lightweight flag to use cheaper/faster model for simple tasks
 * @returns Configured ChatAnthropic model instance with tools bound
 */
export const getTier2ModelWithTools = (
  agentType?: string,
  options?: ModelOptions,
) => {
  const model = getTier2Model(agentType, options);
  return model.bindTools(CEREBRO_TOOLS);
};
