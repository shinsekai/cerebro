import {
  type ExecutionPlan,
  ExecutionPlanSchema,
  getModelForAgent,
} from "@cerebro/core";
import { ChatAnthropic } from "@langchain/anthropic";
import { PromptTemplate } from "@langchain/core/prompts";

export class OrchestratorAgent {
  private model: ChatAnthropic;

  constructor() {
    this.model = new ChatAnthropic({
      model: getModelForAgent("orchestrator"),
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
    mode: "develop" | "fix" | "review" | "ops" = "develop",
  ): Promise<{ content: ExecutionPlan; raw: any }> {
    // Different prompts based on mode
    const getSystemPrompt = () => {
      if (mode === "review") {
        return PromptTemplate.fromTemplate(`
      You are Cerebro Orchestrator in REVIEW mode.
      For code review, only quality and security agents are needed.

      AVAILABLE AGENTS:
      - quality: For code formatting, AST analysis, linting issues
      - security: For OWASP vulnerability scanning, input validation issues

      REVIEW DESCRIPTION: {taskDesc}

      OUTPUT STRICT JSON (no markdown, no explanation):
      {{
        "summary": "Brief description of the review plan",
        "steps": [
          {{
            "agent": "quality",
            "description": "Analyze code for quality issues",
            "depends_on": []
          }},
          {{
            "agent": "security",
            "description": "Scan for security vulnerabilities",
            "depends_on": []
          }}
        ]
      }}

      Review mode rules:
      - Only include quality and security agents
      - Quality analyzes code style, complexity, bugs, error handling, typing
      - Security scans for SQL injection, XSS, CSRF, secrets, input validation
      - Both agents run in parallel (no dependencies)
    `);
      }

      if (mode === "fix") {
        return PromptTemplate.fromTemplate(`
      You are the Cerebro Orchestrator in FIX mode. The user reported a bug.
      Identify affected files, dispatch minimum agents to diagnose and fix.
      Always include tester to verify.

      AVAILABLE AGENTS:
      - frontend: For UI components, styling, client-side code
      - backend: For API endpoints, server logic, database operations
      - quality: For code formatting, AST analysis, linting
      - security: For OWASP vulnerability scanning, input validation
      - tester: For unit tests, integration tests, test coverage
      - ops: For DevOps, infrastructure, CI/CD, Docker, Justfile, Makefile

      BUG DESCRIPTION: {taskDesc}

      OUTPUT STRICT JSON (no markdown, no explanation):
      {{
        "summary": "Brief description of the fix plan",
        "steps": [
          {{
            "agent": "backend",
            "description": "What this agent will do",
            "depends_on": []
          }}
        ]
      }}

      Fix mode rules:
      - Analyze error/stack trace to identify problem area
      - Dispatch MINIMUM agents needed for targeted fix
      - Runtime error → backend, tester
      - UI bug → frontend, tester
      - Type error → backend/frontend, quality, tester
      - Security issue → backend/frontend, security, tester
      - Always include tester to verify fix
    `);
      }

      // Default develop mode prompt
      return PromptTemplate.fromTemplate(`
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
    };

    const prompt = getSystemPrompt();

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
