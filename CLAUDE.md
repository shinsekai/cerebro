# Cerebro AI Context (`CLAUDE.md`)

This file provides crucial architectural context, rules, and ecosystem mandates to help AI development assistants (like Gemini, GitHub Copilot, or Cursor) deeply understand the **Cerebro** monorepo workspace.

## 1. System Overviews

1. **The Turborepo / Bun Monorepo Framework**
   - We utilize `bun` strictly as our package manager (`bun install` instead of `npm i`) and execution environment natively inside all `@cerebro/*` workspaces.
   - Core API functionality lives exclusively in `apps/engine`.
   - Standalone CLI inputs live seamlessly in `apps/cli`.
   - Core LLM bindings and templates live natively in `packages/agents`.
   - All state schemas are strongly typed and shared in `@cerebro/core`.
   - Database queries and persistence logic are isolated in `@cerebro/database`.

2. **Mesh Orchestrator Pattern**
   - The engine utilizes a **decentralized event loop** on the `POST /mesh/loop` endpoint exposed by Hono.
   - It leverages powerful `Server-Sent Events (SSE)` using Hono's `streamSSE` to chunk console status texts and LLM iteration traces actively to the CLI.
   - **Dynamic Agent Dispatch**: The Orchestrator generates an `ExecutionPlan` with steps and dependencies, allowing agents to execute in parallel when possible and sequentially when required.

3. **Human-In-The-Loop (HITL) Approval System**
   - The system implements a robust approval workflow that pauses execution before writing files.
   - Users can review all proposed file changes with operation indicators (create, update, delete).
   - **Selective File Approval**: Users can approve the overall change set but reject specific files.
   - Approval is sent via `POST /mesh/approve` endpoint with optional `rejectedFiles` array.
   - 5-minute timeout safeguard prevents indefinite hanging.

4. **Token Tracking & Cost Analytics**
   - Per-agent token consumption is tracked in real-time (input/output/total tokens).
   - Cost calculation using 2025 pricing models for Claude 4.6 family (Opus, Sonnet, Haiku).
   - Final summary displays breakdown by agent type and total expenditure.
   - Model pricing configuration is centralized and extensible.

## 2. Strict Technical Conventions

- **LangChain & Anthropic Focus:** `ChatAnthropic` from `@langchain/anthropic` is explicitly relied on over Vertex AI integrations. Do NOT use `@langchain/google-vertexai` as we prioritize standard Anthropic API keys matching `process.env.ANTHROPIC_API_KEY` and `process.env.ANTHROPIC_MODEL`.
- **Picocolors over Chalk:** The CLI strictly uses the lightweight `picocolors` package for decorating terminal output.
- **Circuit Breaker Design:** The system universally relies on `@cerebro/core`'s native `CircuitBreaker`. All LLM mesh invocations iterating inside Hono routes *must* execute within the `while(CircuitBreaker.check(ticket))` boundary to gracefully trap execution cascades before spiraling infinitely.
- **Biome for Code Quality:** Use Biome for both formatting and linting. The project enforces Biome's recommended ruleset. Run `bun run format` and `bun run lint` before committing.
- **Postgres SQL Library:** Database interactions use the `postgres` npm package (not `pg` or `node-postgres`). Queries are template-literal style with auto-camelCase transformation.

## 3. Core Schemas & Data Structures

### State Ticket Schema
```typescript
{
  id: string;              // UUID identifier
  task: string;            // User's request description
  retry_count: number;      // 0-3, enforced by CircuitBreaker
  status: enum;           // pending | in-progress | awaiting-approval | completed | failed | halted
  context?: Record<any>;    // Agent outputs, metadata
  error?: string;          // Error message if failed
}
```

### Execution Plan Schema
```typescript
{
  summary: string;         // Human-readable plan description
  steps: [{
    agent: enum;          // frontend | backend | quality | security | tester | ops
    description: string;   // What this agent will do
    depends_on: enum[]    // Agent types that must complete first
  }]
}
```

### File Change Schema
```typescript
{
  path: string;           // Relative path to file
  content: string;        // File contents
  operation: enum;       // create | update | delete
  isNew: boolean;        // Whether file exists in workspace
}
```

### Approval Response Schema
```typescript
{
  ticketId: string;       // Correlates with original request
  approved: boolean;      // Overall approval decision
  rejectedFiles?: string[]; // Paths of files to skip
  reason?: string;        // Reason if rejected
}
```

## 4. Extending Agent Workflows

If requested to create a new **Tier 2 Agent** to process another facet of software architecture:
1. Initialize a descriptive base template in `packages/agents/src/tier2/agents.ts`.
2. Wrap it with `createAgentFlow(<prompt>)`.
3. Add a dedicated `SYSTEM ROLE` and explicit `RESPONSIBILITIES`. Focus heavily on extreme isolation, DRY, and KISS principles.
4. Export the newly created agent to `packages/agents/src/index.ts`.
5. Inject the agent exclusively into the master Mesh router execution pipeline located safely inside `apps/engine/src/index.ts`.
6. Ensure to actively map its token footprint output via `extractTokenDetails(res)` and append it to the HTTP SSE metric chunk.
7. Add the agent type to `AgentTypeSchema` in `@cerebro/core/src/schemas.ts`.

## 5. Cerebro Engineering Best Practices

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

4. **Framework Agnosticism in Prompts and Tooling**
   - When refining Tier 2 Sub-Agents, do not hardcode rigid technology stacks (e.g., "Use Next.js", "Use Tailwind") into the prompt unless strictly instructed by the user. Agents should intuitively infer context from the user's workspace parameters sent natively by the Tier 1 Orchestrator.
   - Base templates in `packages/agents/src/tier2/agents.ts` should remain universally applicable to any frontend or backend language.
   - **Tool executor allowed commands must be cross-ecosystem.** The `ToolExecutor`'s default command allowlist must cover JS/TS, Python, Go, Rust, and DevOps tools — not just Node/Bun binaries. Agent verification steps (e.g., "run tests", "run linter") must adapt to the detected tech stack rather than hardcoding `bun test` or `biome check`.

5. **Human-In-The-Loop (HITL) Mandate**
   - While Cerebro handles autonomous coding, testing, and reviewing, final deployments or primary branch merges MUST require human oversight and explicit CLI sign-off. Do not bypass or mock this layer.
   - The approval workflow must be respected: no file writes without user confirmation via `/mesh/approve`.

6. **Workspace Root Handling**
   - The CLI passes `workspaceRoot` (current working directory) to the Engine.
   - All file operations must use this root to resolve relative paths correctly.
   - Support for multi-directory/multi-repo workflows depends on proper path resolution.

7. **Error Handling & Retry Logic**
   - Implement graceful error handling with user-friendly error messages.
   - Use `cleanErrorMessage()` utility to parse Anthropic API error responses.
   - Circuit Breaker automatically retries on failure until `retry_count` reaches 3.
   - Log all errors to both console and SSE stream for debugging.

## 6. Development Workflow

### Running Locally
```bash
# Install dependencies
bun install

# Start PostgreSQL with pgvector
make db-up

# Run Engine API (Terminal 1)
make dev-engine

# Run CLI (Terminal 2)
make dev-cli
# Or: cd apps/cli && bun src/index.ts develop "your feature"
```

### Testing
```bash
# Run all tests
bun run test

# Run tests in watch mode
bun run test:watch
```

### Code Quality
```bash
# Format code
bun run format

# Lint code
bun run lint
```

## 7. Environment Variables

Required environment variables (set in `apps/engine/.env` or system environment):

- `ANTHROPIC_API_KEY`: Your Anthropic API key
- `ANTHROPIC_MODEL`: Model to use (default: `claude-opus-4-6`)
- `DB_HOST`: PostgreSQL host (default: `localhost`)
- `DB_PORT`: PostgreSQL port (default: `5432`)
- `POSTGRES_DB`: Database name (default: `cerebro`)
- `POSTGRES_USER`: Database user (default: `cerebro`)
- `POSTGRES_PASSWORD`: Database password (default: `cerebro_password`)

## 8. Codebase Reference — Patterns & Conventions

### Monorepo Wiring

When creating a new package (e.g., `packages/workspace`), follow this exact pattern:

**package.json** — use `"workspace:*"` for internal dependencies:
```json
{
  "name": "@cerebro/workspace",
  "version": "1.0.0",
  "type": "module",
  "main": "src/index.ts",
  "scripts": { "test": "bun test" },
  "dependencies": {
    "@cerebro/core": "workspace:*",
    "zod": "^3.22.4"
  }
}
```

**tsconfig.json** — extend root config:
```json
{
  "extends": "../../tsconfig.json",
  "compilerOptions": { "outDir": "./dist", "declaration": true },
  "include": ["src/**/*"]
}
```

Root `package.json` already has `"workspaces": ["apps/*", "packages/*"]` — any new directory under `packages/` is auto-discovered. Run `bun install` after creating.

To consume a new package from another workspace (e.g., `apps/engine`), add to its `package.json`:
```json
"@cerebro/workspace": "workspace:*"
```
Then run `bun install`.

### Test Patterns

All tests use `bun:test`. **Never** use `vitest`, `jest`, or `@jest/globals`.

```typescript
import { describe, it, expect } from 'bun:test';
import { MySchema } from './myModule.js';

describe('MyModule', () => {
  it('should do something', () => {
    const result = MySchema.parse(validInput);
    expect(result).toEqual(expectedOutput);
  });

  it('should reject invalid input', () => {
    expect(() => MySchema.parse(invalidInput)).toThrow();
  });
});
```

Key rules:
- Import from `'bun:test'`, never from `'vitest'` or `'@jest/globals'`
- Use `.js` extension in all imports (ESM resolution)
- Async tests: `it('...', async () => { ... })`
- Temp directories: `import { mkdtemp, rm } from 'fs/promises'; import { tmpdir } from 'os';`
- Run tests with: `bun test` (not `bunx vitest` or `npx jest`)
- Use `beforeEach` / `afterEach` for setup/teardown
- **Do NOT use** `jest.mock()`, `jest.fn()`, or `jest.spyOn()` — they do not exist in `bun:test`
- For mocking, use `mock.module()` from `bun:test`, or inject mock objects via function parameters (preferred)

### Import Conventions

```typescript
// Always use .js extension for local imports (ESM):
import { MyType } from './myModule.js';

// Cross-package:
import { StateTicket, FileChange } from '@cerebro/core';

// Node built-ins:
import fs from 'fs/promises';
import path from 'path';
```

### Bun Subprocess Execution

Use `Bun.spawn` (not `child_process.exec`) for running shell commands:

```typescript
const proc = Bun.spawn(["bun", "test"], {
  cwd: workspaceRoot,
  stdout: "pipe",
  stderr: "pipe",
  env: { ...process.env },
});

// Read output:
const stdout = await new Response(proc.stdout).text();
const stderr = await new Response(proc.stderr).text();
const exitCode = await proc.exited; // returns a number

// For timeout, race against a timer:
const timeoutPromise = new Promise((_, reject) =>
  setTimeout(() => { proc.kill(); reject(new Error('timeout')); }, 30000)
);
const exitCode = await Promise.race([proc.exited, timeoutPromise]);
```

### Tool Executor — Allowed Commands

The `ToolExecutor` restricts which shell commands agents can run. The default allowlist must be **framework-agnostic**, covering all supported ecosystems:

| Category | Commands |
|----------|----------|
| **JS/TS** | `bun`, `npm`, `npx`, `bunx`, `node`, `tsc`, `biome`, `vitest`, `jest` |
| **Python** | `python`, `python3`, `pip`, `pytest`, `ruff`, `mypy`, `uvicorn` |
| **Go** | `go` |
| **Rust** | `cargo`, `rustc` |
| **DevOps** | `docker`, `git`, `make`, `cmake` |
| **Unix** | `cat`, `ls`, `find`, `grep`, `head`, `tail`, `wc`, `echo`, `pwd`, `which`, `env` |

Additionally, `ToolExecutor.detectProjectCommands(workspaceRoot)` scans `package.json` scripts, `pyproject.toml` scripts, `Makefile` targets, and `Cargo.toml` to dynamically add project-specific commands at runtime.

### Path Traversal Prevention

All file operations that accept user or agent input must validate paths:

```typescript
private resolveSafePath(relativePath: string): string | null {
  const resolved = path.resolve(this.workspaceRoot, relativePath);
  if (!resolved.startsWith(this.workspaceRoot)) {
    return null; // Path traversal attempted
  }
  return resolved;
}
```

### File Layout Quick Reference

| Path | Purpose |
|------|---------|
| `packages/core/src/schemas.ts` | Zod schemas and types (`StateTicket`, `ExecutionPlan`, `FileChange`, etc.) |
| `packages/core/src/circuitBreaker.ts` | `CircuitBreaker` class for retry safety |
| `packages/agents/src/orchestrator.ts` | `OrchestratorAgent` class (Tier 1, Opus) |
| `packages/agents/src/tier2/base.ts` | `getTier2Model()` factory (Tier 2, Sonnet) |
| `packages/agents/src/tier2/agents.ts` | `createAgentFlow` + all 6 agent exports |
| `packages/database/src/queries.ts` | SQL query functions using `postgres` template literals |
| `apps/engine/src/index.ts` | Hono server with `/mesh/loop` SSE endpoint |
| `apps/cli/src/index.ts` | Interactive CLI with `@clack/prompts` |