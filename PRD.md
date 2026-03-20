# Product Requirements Document (PRD)

**Project Name:** Cerebro
**Document Version:** 2.0
**Product Type:** Enterprise Multi-Agent Orchestration Platform / Developer CLI
**Last Updated:** March 2026

---

## 1. Product Vision & Objective

* **Vision:** To provide engineering teams with a zero-friction, context-aware AI development platform that operates as a senior engineering sub-team. Cerebro bridges the gap between local development and cloud-based CI/CD orchestration.
* **Objective:** Build a blazingly fast, multi-tier agentic system that writes, tests, reviews, and deploys code autonomously. It must enforce strict industry standards, prevent infinite generation loops, and mandate human-in-the-loop (HITL) sign-offs for final merges.

---

## 2. Target Audience

* **Software Engineers:** Looking for a fast, local CLI tool to scaffold features or fix bugs (`cerebro fix`, `cerebro develop`).
* **DevOps / QA Engineers:** Needing automated security audits, test generation, and infrastructure code (`cerebro ops`, `cerebro review`).
* **Engineering Managers:** Seeking to enforce worldwide coding standards (OWASP, SOLID, WCAG) across all generated code.

---

## 3. System Architecture & Tech Stack

Cerebro is designed as a monolithic multi-agent application exposing an API, consumable via a compiled CLI.

* **Runtime & Language:** Full TypeScript executed on **Bun** (for instant sub-process spawning and standalone binary compilation).
* **Monorepo Management:** **Turbo** (Turborepo) to clearly separate CLI, Engine, Agents, Core, and Database logic.
* **API & Routing Layer:** **Hono** (Serverless-ready HTTP/SSE framework) with Server-Sent Events for real-time streaming.
* **Data Validation:** **Zod** (Strict enforcement of agent-to-agent JSON payloads and state tickets).
* **Code Formatting/Linting:** **Biome** (High-speed linting utilized by the Quality Agent and enforced across all codebases).
* **Memory / Database:** **PostgreSQL + `pgvector`** (For hybrid semantic search and context storage). Database queries use the `postgres` npm package.
* **CLI Interactions:** **@clack/prompts** (Interactive terminal prompts) and **picocolors** (Terminal color output).
* **Deployment Architecture:**
    * *Production:* Scaleway Serverless Containers inside a VPC connecting to Managed PostgreSQL.
    * *Local:* Docker Compose parity (`cerebro-engine` and `cerebro-db`).

---

## 4. AI Models & Tiered Strategy

The system uses a two-tier LLM approach to balance deep reasoning with token efficiency and execution speed.

### Tier 1: The Orchestrator (Claude Opus 4.6)
* **Role:** Acts as the "Cerebro" router. Analyzes requests, checks the semantic cache, plans execution, and dispatches tasks. Does not write code.
* **Output:** Structured `ExecutionPlan` with agent steps, dependencies, and descriptions.

### Tier 2: Specialized Sub-Agents (Claude Sonnet 4.6)
* **Role:** The "Muscle." Executed as fast Bun sub-processes.
* **Agents:**
    1.  **Frontend Agent:** UI, React/Vue, WCAG compliance, CSS.
    2.  **Backend Agent:** APIs, DB logic, SOLID principles.
    3.  **Tester Agent:** Jest/Vitest, strict 100% pass enforcement.
    4.  **Quality Agent:** Code standards, AST parsing, Biome execution.
    5.  **Security Agent:** Vulnerability auditing, OWASP Top 10 enforcement.
    6.  **Ops Agent:** GitHub API integrations, Docker/Terraform, 12-Factor App rules.

---

## 5. Core Features & Mechanics

### 5.1 The Decentralized Mesh & Circuit Breaker
* **Feature:** Agents can communicate directly without routing through the Opus orchestrator.
* **Mechanism:** The Backend Agent and Tester Agent share a localized event loop. The Backend writes code, the Tester runs it, and feeds stack traces back to the Backend.
* **Safety Net (Circuit Breaker):** To prevent infinite LLM loops, a Zod-validated "State Ticket" tracks retries. If `retry_count` reaches 3, the loop halts and escalates the context back up to Cerebro (Opus) for high-level intervention.

### 5.2 Dynamic Agent Dispatch with Dependency Management
* **Feature:** The Orchestrator generates execution plans that specify which agents to run and their dependencies.
* **Mechanism:** Agents can execute in parallel when dependencies are met, reducing overall execution time. Sequential execution is enforced for dependent agents (e.g., Quality depends on Backend).
* **Benefits:**
    - Faster execution for independent tasks
    - Better resource utilization
    - Clear execution ordering visualization

### 5.3 Context-Aware Semantic Memory
* **Feature:** Cerebro learns from past solutions to save time and API costs.
* **Mechanism:** Successful task resolutions are saved as a "Memory Ticket" in PostgreSQL/`pgvector`.
* **Anti-Drift Guardrail:** Before serving a cached answer, Cerebro cross-references the historical solution with the live codebase. If the codebase has changed, the Quality Agent patches the cached solution before presenting it to the user.

### 5.4 Human-in-the-Loop (HITL) Security
* **Feature:** Cerebro cannot autonomously merge code into production environments.
* **Mechanism:** Cerebro and its Ops Agent have read/write access to create branches and open Pull Requests (via GitHub/GitLab API). Merge capabilities are explicitly denied in the API scope and system prompt. All workflows end with returning a PR URL to the human developer for final review.

### 5.5 File Operations with Selective Approval
* **Feature:** Users review all proposed file changes before they are written to disk.
* **Operations Supported:**
    - **Create:** New files (shown with green `+` indicator)
    - **Update:** Existing files (shown with yellow `~` indicator)
    - **Delete:** File removal (shown with red `-` indicator)
* **Selective Approval:** Users can approve overall changes but reject specific files.
* **Content Preview:** File contents are displayed before approval (truncated for large files).
* **Timeout:** 5-minute timeout prevents indefinite hanging.

### 5.6 Token Tracking & Cost Analytics
* **Feature:** Real-time tracking of token consumption and costs per agent.
* **Metrics Tracked:**
    - Input tokens, output tokens, total tokens per agent
    - Cost calculation per agent using current model pricing
    - Total expenditure for each operation
* **Models Supported:**
    - Claude Opus 4.6: $15/M input, $75/M output
    - Claude Sonnet 4.6: $3/M input, $15/M output
    - Claude Haiku 4.5: $0.25/M input, $1.25/M output
* **Visualization:** Breakdown displayed in CLI final summary with color-coded agent categories.

### 5.7 Real-Time Streaming with Server-Sent Events (SSE)
* **Feature:** Live streaming of agent execution progress to CLI.
* **Mechanism:** Hono's `streamSSE` delivers incremental updates including:
    - Agent execution status
    - Token usage updates
    - Error messages
    - Approval requests
    - Completion notifications
* **Benefits:**
    - Immediate feedback on progress
    - No need for polling
    - Lower latency than HTTP polling

---

## 6. User Interface (The Cerebro CLI)

A standalone binary compiled via Bun, offering an interactive terminal UI (using `@clack/prompts`).

* `cerebro init`: Auto-detects `.git` environments, fetches remote origin, or prompts for a GitHub URL to build the `.cerebro.json` context file.
* `cerebro develop "<feature>"`: Scaffolds full-stack features by orchestrating multiple agents. Displays real-time progress via SSE.
* `cerebro fix "<target>"`: Triggers the Mesh loop to solve specific stack traces or GitHub issues.
* `cerebro review`: Bypasses builder agents; triggers Security and Quality agents to audit local diffs or remote PRs.
* `cerebro ops "<task>"`: Generates CI/CD pipelines, Dockerfiles, and infrastructure code.

### CLI Features

* **Interactive Prompts:**
    - Command selection menu
    - Feature description input
    - Approval confirmation with file preview
    - Selective file rejection (multi-select)

* **Visual Feedback:**
    - Color-coded status messages (picocolors)
    - Agent execution progress indicators
    - Token consumption display
    - File operation icons (+, ~, -)

* **Error Handling:**
    - Clear error messages
    - Engine unreachable warnings
    - Approval timeout notifications
    - Retry guidance

---

## 7. Data Schema

### State Ticket
Tracks execution state for each request.

```typescript
{
  id: UUID;
  task: string;
  retry_count: number (0-3);
  status: enum (pending | in-progress | awaiting-approval | completed | failed | halted);
  context: Record<any> | null;
  error: string | null;
}
```

### Execution Plan
Generated by Orchestrator to control agent execution.

```typescript
{
  summary: string;
  steps: [{
    agent: enum (frontend | backend | quality | security | tester | ops);
    description: string;
    depends_on: enum[];
  }];
}
```

### File Change
Represents a file operation awaiting approval.

```typescript
{
  path: string;
  content: string;
  operation: enum (create | update | delete);
  isNew: boolean;
}
```

### Memory Ticket
Stores successful solutions for semantic retrieval.

```typescript
{
  id: UUID;
  task_hash: string;
  task_summary: string;
  solution_code: string;
  embedding: vector(768) | null;
  created_at: timestamp;
}
```

---

## 8. Development Workflow

### Local Development Setup

```bash
# Install dependencies
bun install

# Start database (PostgreSQL + pgvector)
make db-up

# Run Engine API (Terminal 1)
make dev-engine

# Run CLI (Terminal 2)
make dev-cli
```

### Testing

```bash
# Run all tests
bun run test

# Run tests in watch mode
bun run test:watch

# Test specific package
cd packages/core && bun test
```

### Code Quality

```bash
# Format code with Biome
bun run format

# Lint code with Biome
bun run lint
```

### Building

```bash
# Build all packages
bun run build

# Build CLI binary
cd apps/cli && bun run build
```

---

## 9. API Endpoints

### Engine API (Port 8080)

| Endpoint | Method | Description |
|----------|---------|-------------|
| `/` | GET | Health check |
| `/state` | POST | Save state ticket |
| `/state/:id` | GET | Get state ticket |
| `/memory` | POST | Save memory ticket |
| `/memory/search` | POST | Search similar memories |
| `/mesh/loop` | POST | Execute mesh workflow (SSE) |
| `/mesh/approve` | POST | Submit approval decision |

---

## 10. Environment Variables

| Variable | Required | Description | Default |
|----------|-----------|-------------|---------|
| `ANTHROPIC_API_KEY` | Yes | Anthropic API key | - |
| `ANTHROPIC_MODEL` | No | Model to use | `claude-opus-4-6` |
| `DB_HOST` | No | PostgreSQL host | `localhost` |
| `DB_PORT` | No | PostgreSQL port | `5432` |
| `POSTGRES_DB` | No | Database name | `cerebro` |
| `POSTGRES_USER` | No | Database user | `cerebro` |
| `POSTGRES_PASSWORD` | No | Database password | `cerebro_password` |

---

## 11. Out of Scope (V1)

* Deploying actual infrastructure directly (Cerebro writes the Terraform/Dockerfiles, but does not run `terraform apply` against production cloud accounts).
* Real-time voice interactions (Focus remains purely on terminal/text and CI workflows).
* Custom agent creation by the end-user (Sticking strictly to the 6 predefined enterprise agents for V1 to ensure quality).
* Distributed execution across multiple machines (V1 is designed for single-machine local development).

---

## 12. Future Enhancements (Post-V1)

* **Multi-Repository Support:** Handle operations across multiple git repositories.
* **Advanced Memory System:** Implement hierarchical memory with time-weighted retrieval.
* **Agent Collaboration:** Enable direct agent-to-agent communication without orchestration.
* **Web UI:** Browser-based interface for visualization of mesh execution.
* **Plugin System:** Allow third-party agents to be added via plugins.
* **Distributed Mesh:** Scale across multiple worker machines for parallel processing.
