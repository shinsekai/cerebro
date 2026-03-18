import { ChatVertexAI } from "@langchain/google-vertexai";
import { PromptTemplate } from "@langchain/core/prompts";

export class OrchestratorAgent {
  private model: ChatVertexAI;

  constructor() {
    this.model = new ChatVertexAI({
      model: process.env.ANTHROPIC_MODEL || "claude-3-opus@20240229",
      temperature: 0,
      authOptions: {
        projectId: process.env.ANTHROPIC_VERTEX_PROJECT_ID,
      },
      location: "europe-west1"
    });
  }

  /**
   * Plans the execution of a user feature request, 
   * deciding which Tier 2 agents to dispatch tasks to constraint by the Zod Schema.
   */
  public async planExecution(taskDesc: string) {
    const prompt = PromptTemplate.fromTemplate(`
      You are the Cerebro Orchestrator (Tier 1). You do not write direct code.
      Your job is to analyze the user request and dispatch it to the correct Tier 2 agents.
      User Request: {taskDesc}
      Output a strict JSON planning object detailing which agents need to act in order.
    `);

    // In actual implementation this would pipe through to a tool or StructuredOutputParser
    const chain = prompt.pipe(this.model as any);
    return await chain.invoke({ taskDesc });
  }
}
