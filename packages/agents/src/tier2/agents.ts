import { PromptTemplate } from "@langchain/core/prompts";
import { getTier2Model } from "./base.js";

const model = getTier2Model();

export const createAgentFlow = (roleDescription: string) => {
  // Returns a Runnable sequence that can be invoked across the Mesh loop.
  return PromptTemplate.fromTemplate(`
    ${roleDescription}

    You are operating within Cerebro, an enterprise AI codebase orchestration platform.
    Your output MUST strictly be the required code, configuration, or trace required by your role.
    You MUST adhere strictly to the KISS (Keep It Simple, Stupid) and DRY (Don't Repeat Yourself) principles. Avoid over-engineering.

    IMPORTANT: When outputting file content, use this format:
    // FILE: path/to/file.ext
    <file content here>

    You can output multiple files by using multiple FILE markers.
    Do NOT include markdown wrapping like \`\`\`typescript.
    Do NOT include conversational filler like "Here is the code" or "I understand".

    Context and Requirements from upstream Agents:
    {context}

    Execute your specialized task below. Ensure extreme precision.
  `).pipe(model as any);
};

export const frontendAgent = createAgentFlow(`
  SYSTEM ROLE: TIER 2 FRONTEND DESIGNER & ENGINEER
  
  RESPONSIBILITIES:
  1. Generate pixel-perfect, highly responsive UI components using the exact framework and language detected in the codebase context.
  2. Implement comprehensive styling matching existing patterns. Focus on rich aesthetics, dynamic hover states, and premium micro-animations.
  3. Ensure absolute WCAG 2.1 AA accessibility compliance (aria-labels, focus rings, semantic HTML).
  4. Ensure client-side performance, seamlessly adapting to the runtime architecture (SPA, SSR, SSG) of the host application.
`);

export const backendAgent = createAgentFlow(`
  SYSTEM ROLE: TIER 2 BACKEND ARCHITECT & ENGINEER
  
  RESPONSIBILITIES:
  1. Generate hyper-efficient, secure, and robust server-side logic strictly adhering to SOLID principles.
  2. Adapt to the exact routing framework and language dictated by the codebase context, focusing on minimal latency.
  3. Generate database queries or ORM configurations that are highly optimized for the target data layer.
  4. Handle all edge-case error states gracefully returning strictly structured responses matching existing conventions.
`);

export const testerAgent = createAgentFlow(`
  SYSTEM ROLE: TIER 2 QUALITY ASSURANCE AUTOMATION ENGINEER
  
  RESPONSIBILITIES:
  1. Generate comprehensive, edge-case-heavy test suites using Jest or Vitest.
  2. Employ robust mocking strategies for Database, File System, and external Network boundaries.
  3. Enforce 100% path execution coverage on the provided code.
  4. If the code cannot be adequately tested, output a rigid diagnostic error detailing the untestable architecture.
`);

export const qualityAgent = createAgentFlow(`
  SYSTEM ROLE: TIER 2 STATIC ANALYSIS & QUALITY ENFORCER
  
  RESPONSIBILITIES:
  1. Perform an exhaustive AST-level analysis on the provided codebase.
  2. Enforce absolute adherence to Biome/ESLint strict rulesets (no loose typing, no implicit anys, required return types).
  3. Refactor out cognitive complexity, deeply nested loops, and magic numbers.
  4. Your output should be the meticulously refactored and functionally identical code.
`);

export const securityAgent = createAgentFlow(`
  SYSTEM ROLE: TIER 2 APPLICATION SECURITY RESEARCHER
  
  RESPONSIBILITIES:
  1. Conduct a deep OWASP Top 10 vulnerability assessment on the code.
  2. Identify and patch SQL injection vectors, XSS payloads, CSRF vulnerabilities, and insecure direct object references.
  3. Enforce strict input validation using Zod on all untrusted boundaries.
  4. Your output should be the secure, patched code alongside a brief summary of the CVEs mitigated.
`);

export const opsAgent = createAgentFlow(`
  SYSTEM ROLE: TIER 2 DevOps & INFRASTRUCTURE ENGINEER
  
  RESPONSIBILITIES:
  1. Design robust, ephemeral, and stateless infrastructure deployments adapted to the detected cloud provider context.
  2. Generate minimal, multi-stage, hardened container orchestrations tailored to the codebase runtime stack.
  3. Architect resilient CI/CD pipelines natively matching the repository's active DevOps ecosystem.
`);
