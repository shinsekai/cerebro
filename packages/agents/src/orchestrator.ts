import { type ExecutionPlan, ExecutionPlanSchema } from "@cerebro/core";
import { ChatAnthropic } from "@langchain/anthropic";
import { PromptTemplate } from "@langchain/core/prompts";

export class OrchestratorAgent {
  private model: ChatAnthropic;

  constructor() {
    this.model = new ChatAnthropic({
      model: process.env.ANTHROPIC_MODEL || "claude-opus-4-6",
      temperature: 0,
      apiKey: process.env.ANTHROPIC_API_KEY || "not_provided",
    });
  }

  /**
   * Plans the execution of a user feature request,
   * deciding which Tier 2 agents to dispatch tasks to based on Zod Schema.
   * Returns a structured ExecutionPlan that the Mesh loop uses as the control plane.
   * Also returns the raw result for token tracking.
   */
  public async planExecution(
    taskDesc: string,
  ): Promise<{ content: ExecutionPlan; raw: any }> {
    const prompt = PromptTemplate.fromTemplate(`
      You are the Cerebro Orchestrator (Tier 1). You are the CONTROL PLANE.
      Your job is to analyze the user request and determine which Tier 2 agents need to execute.
      You DO NOT write code. You only orchestrate agent execution.

      AVAILABLE AGENTS:
      - frontend: For UI components, styling, client-side code
      - backend: For API endpoints, server logic, database operations
      - quality: For code formatting, AST analysis, linting
      - security: For OWASP vulnerability scanning, input validation
      - tester: For unit tests, integration tests, test coverage
      - ops: For DevOps, infrastructure, CI/CD, Docker, Justfile, Makefile

      USER REQUEST: {taskDesc}

      OUTPUT STRICT JSON (no markdown, no explanation):
      {{
        "summary": "Brief description of the execution plan",
        "steps": [
          {{
            "agent": "backend",
            "description": "What this agent will do",
            "depends_on": []
          }}
        ]
      }}

      Rules:
      - Only include agents that are ACTUALLY needed for this task
      - Use "depends_on" to specify execution order (e.g., tester depends on backend)
      - For simple tasks (like Justfile), use only "ops" agent
      - For code changes: backend → quality → security → tester
      - For UI work: frontend → quality → tester
      - For full-stack: backend → frontend → quality → security → tester
    `);

    const chain = prompt.pipe(this.model as any);
    const rawResult = await chain.invoke({ taskDesc });

    // Parse and validate the plan against Zod schema
    let planContent: any;
    const resultAny = rawResult as any;
    if (typeof resultAny?.content === "string") {
      try {
        const jsonMatch = resultAny.content.match(/\{[\s\S]*\}/);
        if (jsonMatch) {
          planContent = JSON.parse(jsonMatch[0]);
        } else {
          planContent = JSON.parse(resultAny.content);
        }
      } catch (e) {
        // Fallback to default plan
        planContent = {
          summary: "Default execution plan",
          steps: [
            { agent: "backend", description: "Execute task", depends_on: [] },
          ],
        };
      }
    } else {
      planContent = resultAny.content;
    }

    const validatedPlan = ExecutionPlanSchema.parse(planContent);
    return { content: validatedPlan, raw: rawResult };
  }
}
