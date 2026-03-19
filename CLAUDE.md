# Cerebro AI Context (`CLAUDE.md`)

This file provides crucial architectural context, rules, and ecosystem mandates to help AI development assistants (like Gemini, GitHub Copilot, or Cursor) deeply understand the **Cerebro** monorepo workspace.

## 1. System Overviews

1. **The Turborepo / Bun Monorepo Framework**
   - We utilize `bun` strictly as our package manager (`bun install` instead of `npm i`) and execution environment natively inside all `@cerebro/*` workspaces.
   - Core API functionality lives exclusively in `apps/engine`.
   - Standalone CLI inputs live seamlessly in `apps/cli`.
   - Core LLM bindings and templates live natively in `packages/agents`.
   - All state schemas are strongly typed and shared in `@cerebro/core`.

2. **Mesh Orchestrator Pattern**
   - The engine utilizes a **decentralized event loop** on the `POST /mesh/loop` endpoint exposed by Hono.
   - It leverages powerful `Server-Sent Events (SSE)` using Hono's `streamSSE` to chunk console status texts and LLM iteration traces actively to the CLI.

## 2. Strict Technical Conventions

- **LangChain & Anthropic Focus:** `ChatAnthropic` from `@langchain/anthropic` is explicitly relied on over Vertex AI integrations. Do NOT use `@langchain/google-vertexai` as we prioritize standard Anthropic API keys matching `process.env.ANTHROPIC_API_KEY` and `process.env.ANTHROPIC_MODEL`.
- **Picocolors over Chalk:** The CLI strictly uses the lightweight `picocolors` package for decorating terminal output.
- **Circuit Breaker Design:** The system universally relies on `@cerebro/core`'s native `CircuitBreaker`. All LLM mesh invocations iterating inside Hono routes *must* execute within the `while(CircuitBreaker.check(ticket))` boundary to gracefully trap execution cascades before spiraling infinitely.

## 3. Extending Agent Workflows

If requested to create a new **Tier 2 Agent** to process another facet of software architecture:
1. Initialize a descriptive base template in `packages/agents/src/tier2/agents.ts`.
2. Wrap it with `createAgentFlow(<prompt>)`.
3. Add a dedicated `SYSTEM ROLE` and explicit `RESPONSIBILITIES`. Focus heavily on extreme isolation, DRY, and KISS principles.
4. Export the newly created agent to `packages/agents/src/index.ts`.
5. Inject the agent exclusively into the master Mesh router execution pipeline located safely inside `apps/engine/src/index.ts`. 
6. Ensure to actively map its token footprint output via `extractTokens(res)` and append it to the HTTP SSE metric chunk.

## 4. Cerebro Engineering Best Practices

When contributing code to any portion of the Cerebro monorepo, AI coding assistants must rigorously adhere to the following principles:

1. **Extreme KISS & DRY Principle Compliance**
   - Keep it simple, stupid. Deeply nested abstractions, excessive boilerplate, and over-engineered classes are strictly forbidden.
   - Don't repeat yourself. If a logic block or utility method is required across multiple agents or Engine endpoints, it must be modularized and exported out of `@cerebro/core`.

2. **Zero-Trust LLM Outputs**
   - Never trust raw LLM output strings intrinsically.
   - Always map and parse LLM completion results into Zod-validated Schemas (e.g., `StateTicketSchema`) before interacting with `packages/database` or broadcasting payloads across the Hono Mesh.

3. **Performance First (Bun + Hono)**
   - Prioritize zero-dependency or lightweight solutions. Do not add bloated NPM libraries (like Moment.js or Lodash) if native JavaScript/TypeScript methods or native Bun APIs suffice.
   - Hono endpoints in `apps/engine` must remain completely stateless regarding LLM execution context. Rely entirely on PostgreSQL (`pgvector`) for state persistence.

4. **Framework Agnosticism in Prompts**
   - When refining Tier 2 Sub-Agents, do not hardcode rigid technology stacks (e.g., "Use Next.js", "Use Tailwind") into the prompt unless strictly instructed by the user. Agents should intuitively infer context from the user's workspace parameters sent natively by the Tier 1 Orchestrator. 
   - Base templates in `packages/agents/src/tier2/agents.ts` should remain universally applicable to any frontend or backend language.

5. **Human-In-The-Loop (HITL) Mandate**
   - While Cerebro handles autonomous coding, testing, and reviewing, final deployments or primary branch merges MUST require human oversight and explicit CLI sign-off. Do not bypass or mock this layer.
