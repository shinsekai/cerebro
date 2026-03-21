import { CEREBRO_TOOLS } from "@cerebro/core";
import { ChatAnthropic } from "@langchain/anthropic";

/**
 * Common getter for Tier 2 agents.
 *
 * Configures the base model to sonnet with low temperature for deterministic code output.
 */
export const getTier2Model = () => {
  return new ChatAnthropic({
    model: process.env.ANTHROPIC_MODEL || "claude-sonnet-4-6", // Default fallback if no alias
    temperature: 0.2, // Low temperature for high precision coding
    apiKey: process.env.ANTHROPIC_API_KEY || "not_provided",
  });
};

/**
 * Tier 2 model with CEREBRO tools bound for agentic loop execution.
 */
export const getTier2ModelWithTools = () => {
  const model = getTier2Model();
  return model.bindTools(CEREBRO_TOOLS);
};
