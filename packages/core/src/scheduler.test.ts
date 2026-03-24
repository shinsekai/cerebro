import { describe, expect, it } from "bun:test";
import {
  buildExecutionWaves,
  getDownstreamAgents,
  validateExecutionPlan,
} from "./scheduler.js";
import type { AgentStep, ExecutionPlan } from "./schemas.js";

function createStep(
  agent: AgentStep["agent"],
  deps: AgentStep["agent"][] = [],
): AgentStep {
  return { agent, description: `${agent} step`, depends_on: deps };
}

describe("buildExecutionWaves", () => {
  it("linear: backend→quality→tester returns 3 waves of 1", () => {
    const plan: ExecutionPlan = {
      summary: "Linear chain",
      steps: [
        createStep("backend"),
        createStep("quality", ["backend"]),
        createStep("tester", ["quality"]),
      ],
    };

    const waves = buildExecutionWaves(plan);
    expect(waves).toHaveLength(3);
    expect(waves[0]).toHaveLength(1);
    expect(waves.at(0)?.at(0)?.agent).toBe("backend");
    expect(waves[1]).toHaveLength(1);
    expect(waves.at(1)?.at(0)?.agent).toBe("quality");
    expect(waves[2]).toHaveLength(1);
    expect(waves.at(2)?.at(0)?.agent).toBe("tester");
  });

  it("parallel: [backend,frontend] → quality returns 2 waves", () => {
    const plan: ExecutionPlan = {
      summary: "Parallel then sequential",
      steps: [
        createStep("backend"),
        createStep("frontend"),
        createStep("quality", ["backend", "frontend"]),
      ],
    };

    const waves = buildExecutionWaves(plan);
    expect(waves).toHaveLength(2);
    expect(waves[0]).toHaveLength(2);
    expect(waves[0].map((s) => s.agent).sort()).toEqual([
      "backend",
      "frontend",
    ]);
    expect(waves[1]).toHaveLength(1);
    expect(waves.at(1)?.at(0)?.agent).toBe("quality");
  });

  it("full-stack: proper wave grouping", () => {
    const plan: ExecutionPlan = {
      summary: "Full stack application",
      steps: [
        createStep("backend"),
        createStep("frontend"),
        createStep("quality", ["backend", "frontend"]),
        createStep("security", ["backend", "frontend"]),
        createStep("tester", ["quality", "security"]),
        createStep("ops", ["tester"]),
      ],
    };

    const waves = buildExecutionWaves(plan);
    expect(waves).toHaveLength(4);
    expect(waves[0].map((s) => s.agent).sort()).toEqual([
      "backend",
      "frontend",
    ]);
    expect(waves[1].map((s) => s.agent).sort()).toEqual([
      "quality",
      "security",
    ]);
    expect(waves[2].map((s) => s.agent)).toEqual(["tester"]);
    expect(waves[3].map((s) => s.agent)).toEqual(["ops"]);
  });

  it("circular: A↔B throws error", () => {
    const plan: ExecutionPlan = {
      summary: "Circular dependency",
      steps: [
        {
          agent: "backend",
          description: "Backend step",
          depends_on: ["frontend"],
        },
        {
          agent: "frontend",
          description: "Frontend step",
          depends_on: ["backend"],
        },
      ],
    };

    expect(() => buildExecutionWaves(plan)).toThrow(
      /Circular dependency detected.*backend.*frontend.*backend/,
    );
  });

  it("missing dependency throws error", () => {
    const plan: ExecutionPlan = {
      summary: "Missing dependency",
      steps: [
        {
          agent: "quality",
          description: "Quality step",
          depends_on: ["backend", "nonexistent" as AgentStep["agent"]],
        },
      ],
    };

    expect(() => buildExecutionWaves(plan)).toThrow(
      "Agent 'quality' depends on 'backend', 'nonexistent' which are not in the execution plan",
    );
  });

  it("single agent with no deps returns 1 wave", () => {
    const plan: ExecutionPlan = {
      summary: "Single step",
      steps: [createStep("backend")],
    };

    const waves = buildExecutionWaves(plan);
    expect(waves).toHaveLength(1);
    expect(waves[0]).toHaveLength(1);
    expect(waves.at(0)?.at(0)?.agent).toBe("backend");
  });

  it("empty plan returns empty array", () => {
    const plan: ExecutionPlan = { summary: "Empty", steps: [] };
    expect(buildExecutionWaves(plan)).toEqual([]);
  });

  it("complex multi-wave diamond pattern", () => {
    const plan: ExecutionPlan = {
      summary: "Diamond pattern",
      steps: [
        createStep("backend"),
        createStep("frontend"),
        createStep("quality", ["backend"]),
        createStep("security", ["frontend"]),
        createStep("tester", ["quality", "security"]),
      ],
    };

    const waves = buildExecutionWaves(plan);
    expect(waves).toHaveLength(3);
    expect(waves[0].map((s) => s.agent).sort()).toEqual([
      "backend",
      "frontend",
    ]);
    expect(waves[1].map((s) => s.agent).sort()).toEqual([
      "quality",
      "security",
    ]);
    expect(waves[2].map((s) => s.agent)).toEqual(["tester"]);
  });
});

describe("validateExecutionPlan", () => {
  it("valid plan returns valid: true, empty errors", () => {
    const plan: ExecutionPlan = {
      summary: "Valid plan",
      steps: [createStep("backend"), createStep("quality", ["backend"])],
    };

    const result = validateExecutionPlan(plan);
    expect(result.valid).toBe(true);
    expect(result.errors).toEqual([]);
  });

  it("circular dependency returns valid: false with error", () => {
    const plan: ExecutionPlan = {
      summary: "Circular",
      steps: [
        { agent: "backend", description: "Backend", depends_on: ["frontend"] },
        { agent: "frontend", description: "Frontend", depends_on: ["backend"] },
      ],
    };

    const result = validateExecutionPlan(plan);
    expect(result.valid).toBe(false);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]).toContain("Circular dependency");
  });

  it("missing dependency returns valid: false with error", () => {
    const plan: ExecutionPlan = {
      summary: "Missing dep",
      steps: [
        {
          agent: "quality",
          description: "Quality",
          depends_on: ["missing" as AgentStep["agent"]],
        },
      ],
    };

    const result = validateExecutionPlan(plan);
    expect(result.valid).toBe(false);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]).toContain("missing");
  });
});

describe("getDownstreamAgents", () => {
  it("returns all transitive dependents of failed agent", () => {
    const plan: ExecutionPlan = {
      summary: "Linear chain",
      steps: [
        createStep("backend"),
        createStep("quality", ["backend"]),
        createStep("tester", ["quality"]),
      ],
    };

    const downstream = getDownstreamAgents(plan, "backend");
    expect(downstream.sort()).toEqual(["quality", "tester"]);
  });

  it("returns empty when no agents depend on failed one", () => {
    const plan: ExecutionPlan = {
      summary: "Independent",
      steps: [createStep("backend"), createStep("frontend")],
    };

    const downstream = getDownstreamAgents(plan, "backend");
    expect(downstream).toEqual([]);
  });

  it("handles diamond pattern correctly", () => {
    const plan: ExecutionPlan = {
      summary: "Diamond",
      steps: [
        createStep("backend"),
        createStep("quality", ["backend"]),
        createStep("security", ["backend"]),
        createStep("tester", ["quality", "security"]),
      ],
    };

    const downstream = getDownstreamAgents(plan, "backend");
    expect(downstream.sort()).toEqual(["quality", "security", "tester"]);
  });

  it("handles partial failure in complex graph", () => {
    const plan: ExecutionPlan = {
      summary: "Complex",
      steps: [
        createStep("backend"),
        createStep("frontend"),
        createStep("quality", ["backend", "frontend"]),
        createStep("security", ["frontend"]),
        createStep("tester", ["quality"]),
      ],
    };

    const downstream = getDownstreamAgents(plan, "backend");
    expect(downstream.sort()).toEqual(["quality", "tester"]);
  });
});
