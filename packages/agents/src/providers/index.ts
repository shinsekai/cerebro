/**
 * Provider Abstraction Layer
 *
 * This module defines the interface for LLM model providers, enabling
 * multi-provider support (Anthropic, OpenAI, Google, etc.) in a unified way.
 *
 * TODO: Add OpenAIProvider implementation
 * TODO: Add GoogleProvider implementation
 */

import type { BaseChatModel } from "@langchain/core/language_models/chat_models";

/**
 * Options for creating a chat model instance.
 */
export interface CreateChatModelOptions {
  /** The model identifier (e.g., "claude-opus-4-6", "gpt-4o") */
  model: string;
  /** Temperature for response randomness (0.0-1.0) */
  temperature: number;
  /** Optional tools to bind to the model */
  tools?: unknown[];
}

/**
 * Abstract interface for LLM model providers.
 *
 * All provider implementations must conform to this interface,
 * allowing the system to swap providers at runtime without changing
 * agent logic.
 */
export interface ModelProvider {
  /**
   * Create a configured chat model instance.
   *
   * @param options - Model configuration options
   * @returns Configured chat model (BaseChatModel from langchain)
   */
  createChatModel(options: CreateChatModelOptions): BaseChatModel;

  /**
   * Human-readable name of the provider.
   */
  readonly name: string;

  /**
   * Whether this provider supports tool use.
   */
  readonly supportsToolUse: boolean;
}

export * from "./anthropic.js";
