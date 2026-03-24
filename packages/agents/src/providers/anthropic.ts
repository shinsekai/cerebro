/**
 * Anthropic Provider Implementation
 *
 * Implements the ModelProvider interface using @langchain/anthropic's ChatAnthropic.
 * This wraps the current Cerebro behavior for Anthropic Claude models.
 */

import { ChatAnthropic } from "@langchain/anthropic";
import type { CreateChatModelOptions, ModelProvider } from "./index.js";

/**
 * Anthropic provider for Claude models.
 *
 * Uses the Anthropic API via LangChain's ChatAnthropic integration.
 * Supports all Claude 4.6 family models (Opus, Sonnet, Haiku).
 */
export class AnthropicProvider implements ModelProvider {
  readonly name = "anthropic";
  readonly supportsToolUse = true;

  /**
   * The API key to use for Anthropic requests.
   * Falls back to "not_provided" if not set (allows local testing).
   */
  private readonly apiKey: string;

  constructor() {
    this.apiKey = process.env.ANTHROPIC_API_KEY || "not_provided";
  }

  /**
   * Create a configured Anthropic chat model.
   *
   * @param options - Model configuration options
   * @returns Configured ChatAnthropic instance
   */
  createChatModel(options: CreateChatModelOptions): ChatAnthropic {
    const { model, temperature, tools } = options;

    const chatModel = new ChatAnthropic({
      model,
      temperature,
      apiKey: this.apiKey,
    });

    // Bind tools if provided
    if (tools && tools.length > 0) {
      return chatModel.bindTools(tools);
    }

    return chatModel;
  }
}
