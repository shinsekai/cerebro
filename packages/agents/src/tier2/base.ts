import { ChatVertexAI } from "@langchain/google-vertexai";

/**
 * Common getter for Tier 2 agents.
 * 
 * Configures the base model to sonnet with low temperature for deterministic code output.
 */
export const getTier2Model = () => {
  return new ChatVertexAI({
    model: process.env.ANTHROPIC_MODEL || "claude-3-sonnet@20240229", // Default fallback if no alias
    temperature: 0.2, // Low temperature for high precision coding
    authOptions: {
      projectId: process.env.ANTHROPIC_VERTEX_PROJECT_ID,
    },
    location: "europe-west1",
  });
};
