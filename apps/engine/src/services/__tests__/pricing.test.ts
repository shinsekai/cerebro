import { describe, expect, it } from "bun:test";
import {
  extractTokenDetails,
  formatCost,
  getPricingForModel,
  MODEL_PRICING,
} from "../pricing.js";

describe("pricing", () => {
  describe("MODEL_PRICING", () => {
    it("should have pricing for all known models", () => {
      expect(MODEL_PRICING["claude-opus-4-6"]).toEqual({
        input: 15.0,
        output: 75.0,
      });
      expect(MODEL_PRICING["claude-sonnet-4-6"]).toEqual({
        input: 3.0,
        output: 15.0,
      });
      expect(MODEL_PRICING["claude-haiku-4-5-20251001"]).toEqual({
        input: 0.25,
        output: 1.25,
      });
    });
  });

  describe("getPricingForModel", () => {
    it("should return correct pricing for Opus", () => {
      const pricing = getPricingForModel("claude-opus-4-6");
      expect(pricing.input).toBe(15.0);
      expect(pricing.output).toBe(75.0);
    });

    it("should return correct pricing for Sonnet", () => {
      const pricing = getPricingForModel("claude-sonnet-4-6");
      expect(pricing.input).toBe(3.0);
      expect(pricing.output).toBe(15.0);
    });

    it("should return correct pricing for Haiku", () => {
      const pricing = getPricingForModel("claude-haiku-4-5-20251001");
      expect(pricing.input).toBe(0.25);
      expect(pricing.output).toBe(1.25);
    });

    it("should fall back to Opus pricing for unknown models", () => {
      const pricing = getPricingForModel("unknown-model");
      expect(pricing.input).toBe(15.0);
      expect(pricing.output).toBe(75.0);
    });
  });

  describe("formatCost", () => {
    it("should format cost with 4 decimal places", () => {
      expect(formatCost(0.00012345)).toBe("$0.0001");
      expect(formatCost(1.23456)).toBe("$1.2346");
      expect(formatCost(10)).toBe("$10.0000");
      expect(formatCost(0.5)).toBe("$0.5000");
    });
  });

  describe("extractTokenDetails", () => {
    it("should extract token details and calculate cost", () => {
      const res = {
        usage_metadata: {
          input_tokens: 1000,
          output_tokens: 500,
          total_tokens: 1500,
        },
      };
      const pricing = { input: 15.0, output: 75.0 };
      const result = extractTokenDetails(res, pricing);

      expect(result.inputTokens).toBe(1000);
      expect(result.outputTokens).toBe(500);
      expect(result.totalTokens).toBe(1500);
      expect(result.cost).toBeCloseTo(0.0525, 6); // (1000/1M)*15 + (500/1M)*75
    });

    it("should handle missing total_tokens", () => {
      const res = {
        usage_metadata: {
          input_tokens: 1000,
          output_tokens: 500,
        },
      };
      const pricing = { input: 15.0, output: 75.0 };
      const result = extractTokenDetails(res, pricing);

      expect(result.totalTokens).toBe(1500); // Should sum input + output
    });

    it("should handle zero tokens", () => {
      const res = {
        usage_metadata: {
          input_tokens: 0,
          output_tokens: 0,
        },
      };
      const pricing = { input: 15.0, output: 75.0 };
      const result = extractTokenDetails(res, pricing);

      expect(result.inputTokens).toBe(0);
      expect(result.outputTokens).toBe(0);
      expect(result.totalTokens).toBe(0);
      expect(result.cost).toBe(0);
    });

    it("should handle missing usage_metadata", () => {
      const res = {};
      const pricing = { input: 15.0, output: 75.0 };
      const result = extractTokenDetails(res, pricing);

      expect(result.inputTokens).toBe(0);
      expect(result.outputTokens).toBe(0);
      expect(result.totalTokens).toBe(0);
      expect(result.cost).toBe(0);
    });
  });
});
