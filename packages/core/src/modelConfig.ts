import { z } from "zod";

/**
 * All agent types that can be configured with specific models.
 * Includes the orchestrator, lightweight model, and all 6 Tier 2 agents.
 */
export const ModelAgentTypeSchema = z.enum([
  "orchestrator",
  "lightweight",
  "frontend",
  "backend",
  "quality",
  "security",
  "tester",
  "ops",
]);

export type ModelAgentType = z.infer<typeof ModelAgentTypeSchema>;

/**
 * Schema for validating model configuration.
 * Maps each agent type to a valid Claude model string.
 */
export const ModelConfigSchema = z.record(
  ModelAgentTypeSchema,
  z.string().min(1),
);

export type ModelConfig = z.infer<typeof ModelConfigSchema>;

/**
 * Default model assignments for each agent type.
 * Uses Opus for orchestrator (planning/coordination), Haiku for lightweight (simple tasks), and Sonnet for code-focused Tier 2 agents.
 */
const DEFAULT_MODELS: Record<ModelAgentType, string> = {
  orchestrator: "claude-opus-4-6",
  lightweight: "claude-haiku-4-5-20251001",
  frontend: "claude-sonnet-4-6",
  backend: "claude-sonnet-4-6",
  quality: "claude-sonnet-4-6",
  security: "claude-sonnet-4-6",
  tester: "claude-sonnet-4-6",
  ops: "claude-sonnet-4-6",
};

/**
 * Environment variable name mapping for each agent type.
 * Format: CEREBRO_MODEL_{AGENT_TYPE}
 */
const ENV_VAR_MAPPING: Record<ModelAgentType, string> = {
  orchestrator: "CEREBRO_MODEL_ORCHESTRATOR",
  lightweight: "CEREBRO_MODEL_LIGHTWEIGHT",
  frontend: "CEREBRO_MODEL_FRONTEND",
  backend: "CEREBRO_MODEL_BACKEND",
  quality: "CEREBRO_MODEL_QUALITY",
  security: "CEREBRO_MODEL_SECURITY",
  tester: "CEREBRO_MODEL_TESTER",
  ops: "CEREBRO_MODEL_OPS",
};

/**
 * Get the configured model for a specific agent type.
 *
 * Resolution order:
 * 1. Agent-specific env var (e.g., CEREBRO_MODEL_FRONTEND)
 * 2. Generic ANTHROPIC_MODEL env var (legacy support)
 * 3. Default model for agent type
 *
 * @param agentType - The agent type to get the model for
 * @returns The model string to use
 */
export function getModelForAgent(agentType: ModelAgentType | string): string {
  const normalizedType = agentType as ModelAgentType;
  const envVar = ENV_VAR_MAPPING[normalizedType];

  // Check agent-specific env var first
  const agentSpecificModel = envVar ? process.env[envVar] : null;
  if (agentSpecificModel) {
    return agentSpecificModel;
  }

  // Fall back to generic ANTHROPIC_MODEL for legacy support
  const genericModel = process.env.ANTHROPIC_MODEL;
  if (genericModel) {
    return genericModel;
  }

  // Use default for this agent type
  return DEFAULT_MODELS[normalizedType];
}

/**
 * Get the current model configuration for all agent types.
 * Useful for debugging or displaying current settings.
 *
 * @returns A record mapping agent types to their configured models
 */
export function getAllModelConfigs(): ModelConfig {
  const config: Record<string, string> = {};

  for (const agentType of ModelAgentTypeSchema.options) {
    config[agentType] = getModelForAgent(agentType);
  }

  return config as ModelConfig;
}
