import { describe, expect, it } from "bun:test";
import { TokenTracker } from "../tokenTracker.js";

describe("TokenTracker", () => {
  it("should initialize with empty tracking", () => {
    const tracker = new TokenTracker();
    expect(tracker.getAgents()).toEqual([]);
    expect(tracker.getUsage("orchestrator")).toEqual({ tokens: 0, cost: 0 });
    expect(tracker.getTotals()).toEqual({ tokens: 0, cost: 0 });
  });

  it("should add usage for a single agent", () => {
    const tracker = new TokenTracker();
    tracker.addUsage("orchestrator", 1000, 0.05);

    expect(tracker.getUsage("orchestrator")).toEqual({
      tokens: 1000,
      cost: 0.05,
    });
    expect(tracker.getTotals()).toEqual({ tokens: 1000, cost: 0.05 });
  });

  it("should accumulate usage when adding to same agent multiple times", () => {
    const tracker = new TokenTracker();
    tracker.addUsage("frontend", 500, 0.01);
    tracker.addUsage("frontend", 300, 0.006);
    tracker.addUsage("frontend", 200, 0.004);

    expect(tracker.getUsage("frontend")).toEqual({ tokens: 1000, cost: 0.02 });
    expect(tracker.getTotals()).toEqual({ tokens: 1000, cost: 0.02 });
  });

  it("should track usage for multiple agents", () => {
    const tracker = new TokenTracker();
    tracker.addUsage("orchestrator", 500, 0.025);
    tracker.addUsage("frontend", 1000, 0.01);
    tracker.addUsage("backend", 800, 0.015);
    tracker.addUsage("quality", 600, 0.005);

    expect(tracker.getUsage("orchestrator")).toEqual({
      tokens: 500,
      cost: 0.025,
    });
    expect(tracker.getUsage("frontend")).toEqual({ tokens: 1000, cost: 0.01 });
    expect(tracker.getUsage("backend")).toEqual({ tokens: 800, cost: 0.015 });
    expect(tracker.getUsage("quality")).toEqual({ tokens: 600, cost: 0.005 });
  });

  it("should getTotals sum across all agents", () => {
    const tracker = new TokenTracker();
    tracker.addUsage("orchestrator", 500, 0.025);
    tracker.addUsage("frontend", 1000, 0.01);
    tracker.addUsage("backend", 800, 0.015);

    const totals = tracker.getTotals();
    expect(totals.tokens).toBe(2300);
    expect(totals.cost).toBeCloseTo(0.05, 6);
  });

  it("should toUsageReport produce expected shape with per-agent breakdown", () => {
    const tracker = new TokenTracker();
    tracker.addUsage("orchestrator", 500, 0.025);
    tracker.addUsage("frontend", 1000, 0.01);
    tracker.addUsage("backend", 800, 0.015);

    const report = tracker.toUsageReport("claude-opus-4-6");

    expect(report).toHaveProperty("model", "claude-opus-4-6");
    expect(report).toHaveProperty("total");
    expect(report.total).toEqual({ tokens: 2300, cost: 0.05 });
    expect(report.orchestrator).toEqual({ tokens: 500, cost: 0.025 });
    expect(report.frontend).toEqual({ tokens: 1000, cost: 0.01 });
    expect(report.backend).toEqual({ tokens: 800, cost: 0.015 });
  });

  it("should return zero usage for agent that hasn't been tracked", () => {
    const tracker = new TokenTracker();
    tracker.addUsage("orchestrator", 100, 0.005);

    expect(tracker.getUsage("frontend")).toEqual({ tokens: 0, cost: 0 });
  });

  it("should return all zero for empty tracker", () => {
    const tracker = new TokenTracker();

    expect(tracker.getAgents()).toEqual([]);
    expect(tracker.getUsage("orchestrator")).toEqual({ tokens: 0, cost: 0 });
    expect(tracker.getTotals()).toEqual({ tokens: 0, cost: 0 });

    const report = tracker.toUsageReport("claude-opus-4-6");
    expect(report).toEqual({
      model: "claude-opus-4-6",
      total: { tokens: 0, cost: 0 },
    });
  });

  it("should return list of tracked agent names", () => {
    const tracker = new TokenTracker();
    tracker.addUsage("orchestrator", 100, 0.005);
    tracker.addUsage("frontend", 200, 0.01);
    tracker.addUsage("backend", 150, 0.008);

    const agents = tracker.getAgents();
    expect(agents).toContain("orchestrator");
    expect(agents).toContain("frontend");
    expect(agents).toContain("backend");
    expect(agents.length).toBe(3);
  });

  it("should reset all tracking", () => {
    const tracker = new TokenTracker();
    tracker.addUsage("orchestrator", 100, 0.005);
    tracker.addUsage("frontend", 200, 0.01);

    expect(tracker.getTotals().tokens).toBe(300);

    tracker.reset();
    expect(tracker.getAgents()).toEqual([]);
    expect(tracker.getTotals()).toEqual({ tokens: 0, cost: 0 });
  });
});
