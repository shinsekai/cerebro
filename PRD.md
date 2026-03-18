# Product Requirements Document (PRD)

**Project Name:** Cerebro  
**Document Version:** 1.0  
**Product Type:** Enterprise Multi-Agent Orchestration Platform / Developer CLI  

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
* **Monorepo Management:** **Turbo** (Turborepo) to clearly separate CLI, Engine, and Agent logic.
* **API & Routing Layer:** **Hono** (Serverless-ready HTTP/SSE framework).
* **Data Validation:** **Zod** (Strict enforcement of agent-to-agent JSON payloads and state tickets).
* **Code Formatting/Linting:** **Biome** (High-speed linting utilized by the Quality Agent).
* **Memory / Database:** **PostgreSQL + `pgvector`** (For hybrid semantic search and context storage).
* **Deployment Architecture:**
    * *Production:* Scaleway Serverless Containers inside a VPC connecting to Managed PostgreSQL.
    * *Local:* Docker Compose parity (`cerebro-engine` and `cerebro-db`).

---

## 4. AI Models & Tiered Strategy

The system uses a two-tier LLM approach to balance deep reasoning with token efficiency and execution speed.

### Tier 1: The Orchestrator (Claude Opus 4.6)
* **Role:** Acts as the "Cerebro" router. Analyzes requests, checks the semantic cache, plans execution, and dispatches tasks. Does not write code.

### Tier 2: Specialized Sub-Agents (Claude Sonnet 4.6)
* **Role:** The "Muscle." Executed as fast Bun sub-processes.
* **Agents:**
    1.  **Frontend Agent:** UI, React/Vue, WCAG compliance, CSS.
    2.  **Backend Agent:** APIs, DB logic, SOLID principles.
    3.  **Tester Agent:** Jest/Cypress, strict 100% pass enforcement.
    4.  **Quality Agent:** Code standards, AST parsing, Biome execution.
    5.  **Security Agent:** Vulnerability auditing, OWASP Top 10 enforcement.
    6.  **Ops Agent:** GitHub API integrations, Docker/Terraform, 12-Factor App rules.

---

## 5. Core Features & Mechanics

### 5.1 The Decentralized Mesh & Circuit Breaker
* **Feature:** Agents can communicate directly without routing through the Opus orchestrator.
* **Mechanism:** The Backend Agent and Tester Agent share a localized event loop. The Backend writes code, the Tester runs it, and feeds stack traces back to the Backend.
* **Safety Net (Circuit Breaker):** To prevent infinite LLM loops, a Zod-validated "State Ticket" tracks retries. If `retry_count` reaches 3, the loop halts and escalates the context back up to Cerebro (Opus) for high-level intervention.

### 5.2 Context-Aware Semantic Memory
* **Feature:** Cerebro learns from past solutions to save time and API costs.
* **Mechanism:** Successful task resolutions are saved as a "Memory Ticket" in PostgreSQL/`pgvector`. 
* **Anti-Drift Guardrail:** Before serving a cached answer, Cerebro cross-references the historical solution with the live codebase. If the codebase has changed, the Quality Agent patches the cached solution before presenting it to the user.

### 5.3 Human-in-the-Loop (HITL) Security
* **Feature:** Cerebro cannot autonomously merge code into production environments.
* **Mechanism:** Cerebro and its Ops Agent have read/write access to create branches and open Pull Requests (via GitHub/GitLab API). Merge capabilities are explicitly denied in the API scope and system prompt. All workflows end with returning a PR URL to the human developer for final review.

---

## 6. User Interface (The Cerebro CLI)

A standalone binary compiled via Bun, offering an interactive terminal UI (using `@clack/prompts`).

* `cerebro init`: Auto-detects `.git` environments, fetches remote origin, or prompts for a GitHub URL to build the `.cerebro.json` context file.
* `cerebro develop "<feature>"`: Scaffolds full-stack features by orchestrating multiple agents.
* `cerebro fix "<target>"`: Triggers the Mesh loop to solve specific stack traces or GitHub issues.
* `cerebro review`: Bypasses builder agents; triggers Security and Quality agents to audit local diffs or remote PRs.
* `cerebro ops "<task>"`: Generates CI/CD pipelines, Dockerfiles, and infrastructure code.

---

## 7. Out of Scope (V1)

* Deploying actual infrastructure directly (Cerebro writes the Terraform/Dockerfiles, but does not run `terraform apply` against production cloud accounts).
* Real-time voice interactions (Focus remains purely on terminal/text and CI workflows).
* Custom agent creation by the end-user (Sticking strictly to the 6 predefined enterprise agents for V1 to ensure quality).