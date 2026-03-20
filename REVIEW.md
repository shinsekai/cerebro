# Cerebro PR Review Guidelines

This document provides structured guidelines for AI-assisted Pull Request reviews in the Cerebro monorepo. All reviews should verify compliance with the engineering standards defined in [`CLAUDE.md`](./CLAUDE.md).

---

## Quick Reference Checklist

- [ ] **Monorepo Structure Compliance**
- [ ] **Package Manager**: `bun` used correctly (no `npm`, `yarn`, `pnpm`)
- [ ] **Architecture**: Code placed in correct workspace (`apps/engine`, `apps/cli`, `packages/agents`, `@cerebro/core`, `@cerebro/database`)
- [ ] **Tech Stack**: `ChatAnthropic` from `@langchain/anthropic` (no Vertex AI)
- [ ] **CLI Styling**: `picocolors` only (no `chalk`)
- [ ] **Database Library**: `postgres` package only (not `pg` or `node-postgres`)
- [ ] **Circuit Breaker**: LLM invocations wrapped in `while(CircuitBreaker.check(ticket))`
- [ ] **Tier 2 Agents**: Follow proper agent extension pattern (if applicable)
- [ ] **KISS/DRY**: No over-engineering, no code duplication
- [ ] **Type Safety**: LLM outputs validated with Zod schemas
- [ ] **Dependencies**: No bloated packages (Moment.js, Lodash, etc.)
- [ ] **Statelessness**: Hono endpoints remain stateless, use PostgreSQL for persistence
- [ ] **Framework Agnosticism**: Prompts don't hardcode tech stacks
- [ ] **HITL Compliance**: File writes require approval via `/mesh/approve`
- [ ] **Token Tracking**: Per-agent token usage tracked and reported
- [ ] **Biome Standards**: Code formatted and linted with Biome
- [ ] **Test Coverage**: Unit tests for new functionality

---

## Detailed Review Guidelines

### 1. Monorepo & Workspace Structure

**Verify code placement:**

| Workspace | Purpose | Check For |
|-----------|---------|-----------|
| `apps/engine` | Core API functionality | Hono routes, SSE streaming, Mesh orchestration |
| `apps/cli` | CLI inputs | Terminal interfaces, CLI-specific commands, @clack/prompts |
| `packages/agents` | LLM bindings & templates | Agent definitions, prompts, flows |
| `@cerebro/core` | Shared state schemas | Zod schemas, CircuitBreaker, shared utilities |
| `@cerebro/database` | Database queries | `postgres` package usage, query functions |

**Red flags:**
- API logic in `apps/cli` or CLI logic in `apps/engine`
- Shared utilities NOT in `@cerebro/core`
- Tier 2 agents defined outside `packages/agents/src/tier2/`
- Database queries using `pg` instead of `postgres`

---

### 2. Package Manager & Execution Environment

**Must use `bun`:**
- ✅ `bun install` (not `npm install`, `yarn install`, `pnpm install`)
- ✅ `bun run <script>` (not `npm run`)
- ✅ `bun test` (not `npm test`)
- ✅ `bunx @biomejs/biome` for Biome commands

**Check for:** Any npm/yarn/pnpm commands in scripts, docs, or CI workflows.

---

### 3. Tech Stack Compliance

**LLM Integration:**
- ✅ `import { ChatAnthropic } from '@langchain/anthropic'`
- ✅ Uses `process.env.ANTHROPIC_API_KEY` and `process.env.ANTHROPIC_MODEL`
- ❌ NO `@langchain/google-vertexai` imports
- ❌ NO Vertex AI API references

**CLI Styling:**
- ✅ `import color from 'picocolors'` or `import { red, green, yellow } from 'picocolors'`
- ❌ NO `chalk` imports
- ❌ NO other terminal color libraries

**Database:**
- ✅ `import { sql } from 'postgres'`
- ✅ Template literal queries: `sql`SELECT * FROM table WHERE id = ${id}``
- ❌ NO `pg` package
- ❌ NO `node-postgres` package

---

### 4. Circuit Breaker Design

**All LLM mesh invocations in Hono routes MUST be wrapped:**

```typescript
// ✅ CORRECT
while (CircuitBreaker.check(ticket)) {
  const result = await llm.invoke(...);
  // ... handle result
}

// ❌ WRONG
const result = await llm.invoke(...);  // No CircuitBreaker protection
```

**Check locations:** All files in `apps/engine/src/` that invoke LLMs.

---

### 5. Human-In-The-Loop (HITL) System

**Approval workflow must be implemented:**
- ✅ File changes require user approval before writing
- ✅ Approval sent via `POST /mesh/approve` endpoint
- ✅ Support for selective file rejection (`rejectedFiles` array)
- ✅ Timeout safeguard (5-minute default)
- ✅ Clear display of file operations (create, update, delete)
- ✅ Visual preview of file content before approval

**Red flags:**
- Direct file writes without approval
- No timeout mechanism
- Missing file operation indicators

---

### 6. Token Tracking & Cost Analytics

**Per-agent token usage must be tracked:**
- ✅ Extract input/output/total tokens from LLM responses
- ✅ Calculate costs using pricing configuration
- ✅ Track per-agent: `orchestrator`, `frontend`, `backend`, `quality`, `security`, `tester`, `ops`
- ✅ Display breakdown in final SSE message
- ✅ Extensible pricing configuration for multiple models

```typescript
// ✅ CORRECT
const tokenDetails = extractTokenDetails(result);
if (agent === 'backend') {
  backendTokens += tokenDetails.totalTokens;
  backendCost += tokenDetails.cost;
}
```

---

### 7. Tier 2 Agent Extension Pattern

If the PR adds/extends a Tier 2 agent, verify:

1. Agent template in `packages/agents/src/tier2/agents.ts`
2. Wrapped with `createAgentFlow(<prompt>)`
3. Has explicit `SYSTEM ROLE` and `RESPONSIBILITIES`
4. Exported to `packages/agents/src/index.ts`
5. Injected into Mesh router in `apps/engine/src/index.ts`
6. Token footprint extracted via `extractTokenDetails(res)` and appended to SSE chunk
7. Agent type added to `AgentTypeSchema` in `@cerebro/core/src/schemas.ts`

---

### 8. KISS & DRY Principles

**KISS (Keep It Simple, Stupid):**
- ❌ Deeply nested abstractions (more than 3 levels)
- ❌ Over-engineered classes with inheritance chains
- ❌ Complex factory patterns when simple functions suffice
- ❌ Excessive boilerplate that obscures logic

**DRY (Don't Repeat Yourself):**
- ❌ Same logic block in 3+ places without extraction to `@cerebro/core`
- ❌ Duplicate utility functions across workspaces
- ❌ Repeated Zod schema definitions

**Action:** Request refactoring if violations found.

---

### 9. Zero-Trust LLM Outputs

**All LLM outputs must be validated:**

```typescript
// ✅ CORRECT
const rawOutput = await llm.invoke(...);
const validated = StateTicketSchema.parse(rawOutput);

// ❌ WRONG
const output = await llm.invoke(...);
await database.insert(output);  // Unsafe! No validation
```

**Check for:**
- Direct database inserts from LLM output
- SSE payloads broadcast without Zod validation
- Type assertions (`as any`) bypassing schema validation
- Missing validation for user inputs (approval responses, etc.)

---

### 10. Performance & Dependencies

**Dependency Guidelines:**
- ❌ NO Moment.js (use native `Date` methods)
- ❌ NO Lodash (use native array methods, optional chaining)
- ❌ NO heavyweight utilities when native JS/TS or Bun APIs suffice
- ✅ Prefer native `fetch`, `URL`, `crypto`, `fs`, etc.
- ✅ Prefer `postgres` over `pg` for PostgreSQL

**Statelessness Check:**
- Hono endpoints in `apps/engine` must NOT store execution context in memory
- All state MUST persist via PostgreSQL (`pgvector`)
- ❌ NO `global` variables or module-level caches for request-specific state

---

### 11. Framework Agnosticism

**Prompt Engineering Guidelines:**
- ❌ NO hardcoded "Use Next.js", "Use Tailwind", "Use React", etc.
- ✅ Prompts should infer tech stack from user workspace parameters
- ✅ Templates in `packages/agents/src/tier2/agents.ts` must be language/framework neutral

**Example:**

```
❌ BAD: "Create a Next.js component with Tailwind CSS..."
✅ GOOD: "Create a component following the patterns in the provided workspace..."
```

---

### 12. Code Quality Standards (Biome)

**All code must pass Biome linting:**
- ✅ Run `bun run lint` before committing
- ✅ Run `bun run format` for consistent formatting
- ✅ Follow Biome recommended ruleset
- ✅ Use 2-space indentation (configured in `biome.json`)
- ✅ Proper semicolon usage per Biome rules

---

### 13. Testing Requirements

**New functionality must include tests:**
- ✅ Unit tests for core utilities in `@cerebro/core`
- ✅ Unit tests for agent logic in `@cerebro/agents`
- ✅ Unit tests for database queries in `@cerebro/database`
- ✅ Test coverage for error handling paths
- ✅ Test for schema validation edge cases

**Run tests:**
```bash
bun run test          # Run all tests
bun run test:watch    # Run tests in watch mode
```

---

### 14. Workspace Root Handling

**File operations must respect workspace root:**
- ✅ Use `workspaceRoot` parameter from request body
- ✅ Resolve relative paths against workspace root
- ✅ Support for multi-directory workflows
- ❌ NO hardcoded paths or assuming current working directory

```typescript
// ✅ CORRECT
const workspaceRoot = body.workspaceRoot || process.cwd();
const fullPath = path.join(workspaceRoot, filePath);

// ❌ WRONG
const fullPath = path.join(process.cwd(), filePath);
```

---

## Review Output Template

When reviewing a PR, structure your feedback as:

### ✅ Approved / 🔴 Changes Requested / ⚠️ Concerns

#### Critical Issues (Must Fix)
- [ ] Description of critical violation
  - **Location**: `path/to/file.ts:line`
  - **Guideline**: Reference from `CLAUDE.md`

#### Recommendations (Should Fix)
- [ ] Suggestion for improvement
  - **Location**: `path/to/file.ts:line`

#### Observations (Nice to Have)
- [ ] Optional enhancement or note

---

## Integration Notes

This `REVIEW.md` is designed to be consumed by AI tools (Claude Code, GitHub Copilot, etc.) when reviewing PRs via:
1. GitHub Actions workflows using `/review` commands
2. Pre-commit hooks
3. CI/CD pipeline integration
4. Manual AI-assisted review sessions

For automated CI integration, ensure this file is accessible to the AI reviewing agent.
