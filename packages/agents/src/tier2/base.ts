import { CEREBRO_TOOLS, getModelForAgent } from "@cerebro/core";
import { AnthropicProvider } from "../providers/anthropic.js";
import type { ModelProvider } from "../providers/index.js";

interface ModelOptions {
  lightweight?: boolean;
}

/**
 * Get the configured model provider.
 *
 * Reads CEREBRO_PROVIDER environment variable to select provider.
 * Defaults to "anthropic" for backwards compatibility.
 *
 * TODO: Add OpenAI provider when CEREBRO_PROVIDER=openai
 * TODO: Add Google provider when CEREBRO_PROVIDER=google
 *
 * @returns ModelProvider instance
 */
function getProvider(): ModelProvider {
  const providerName =
    process.env.CEREBRO_PROVIDER?.toLowerCase() ?? "anthropic";

  switch (providerName) {
    case "anthropic":
      return new AnthropicProvider();
    // TODO: case "openai": return new OpenAIProvider();
    // TODO: case "google": return new GoogleProvider();
    default:
      console.warn(
        `Unknown provider "${providerName}", defaulting to anthropic`,
      );
      return new AnthropicProvider();
  }
}

// Singleton provider instance
let provider: ModelProvider | null = null;

/**
 * Get or create the singleton provider instance.
 */
function getSingletonProvider(): ModelProvider {
  if (!provider) {
    provider = getProvider();
  }
  return provider;
}

/**
 * Common getter for Tier 2 agents.
 *
 * Configures the base model with low temperature for deterministic code output.
 * Uses agent-specific model configuration from environment variables.
 *
 * @param agentType - The specific agent type (e.g., "frontend", "backend") for model selection
 * @param options - Optional lightweight flag to use cheaper/faster model for simple tasks
 * @returns Configured BaseChatModel instance (via selected provider)
 */
export const getTier2Model = (agentType?: string, options?: ModelOptions) => {
  const { lightweight = false } = options ?? {};
  const provider = getSingletonProvider();

  const model = lightweight
    ? getModelForAgent("lightweight")
    : agentType
      ? getModelForAgent(agentType)
      : "claude-sonnet-4-6";

  return provider.createChatModel({
    model,
    temperature: 0.2, // Low temperature for high precision coding
  });
};

/**
 * Tier 2 model with CEREBRO tools bound for agentic loop execution.
 *
 * @param agentType - The specific agent type for model selection
 * @param options - Optional lightweight flag to use cheaper/faster model for simple tasks
 * @returns Configured BaseChatModel instance with tools bound (via selected provider)
 */
export const getTier2ModelWithTools = (
  agentType?: string,
  options?: ModelOptions,
) => {
  const provider = getSingletonProvider();

  const { lightweight = false } = options ?? {};
  const model = lightweight
    ? getModelForAgent("lightweight")
    : agentType
      ? getModelForAgent(agentType)
      : "claude-sonnet-4-6";

  return provider.createChatModel({
    model,
    temperature: 0.2,
    tools: CEREBRO_TOOLS,
  });
};
