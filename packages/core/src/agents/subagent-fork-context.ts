/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type { SystemPrompt } from '../prompts/types.js';
import type { Message } from '../protocol/transcript/message.js';
import type { ToolRegistry } from '../tools/tool-registry.js';

import type { CacheSafeQuerySnapshot } from '../core/cache-safe-query-snapshot.js';
import { stripThoughtSignaturesFromMessages } from '../protocol/transcript/conversation-history.js';

/**
 * Live conversation and prompt-cache state of a single subagent invocation.
 *
 * `buildSubagentRegistries()` creates the holder and wires the child's
 * `AgentLoopContext` fork accessors to it up front, so a nested fork inherits
 * its direct caller's live state without anyone having to rewrite the
 * (readonly) context afterwards. `runSubagent()` calls {@link seed} with the
 * invocation's context messages and rendered system prompt right before the
 * query loop starts, then feeds it via {@link appendMessage} /
 * {@link setCacheSafeSnapshot}.
 *
 * A class instead of a set of closures: it retains only these four fields for
 * the subagent's lifetime rather than the whole setup scope that produced them.
 * The accessors are bound properties so they can be handed to the context and
 * to query() directly.
 */
export class SubagentForkContext {
  private messages: Message[] = [];
  private systemPrompt: SystemPrompt | undefined;
  private toolRegistry: ToolRegistry | undefined;
  private cacheSafeSnapshot: CacheSafeQuerySnapshot | null = null;

  /** Installs the starting state for one invocation. Called once. */
  seed(state: {
    messages?: readonly Message[];
    systemPrompt: SystemPrompt;
    toolRegistry: ToolRegistry;
  }): void {
    this.messages = [...(state.messages ?? [])];
    this.systemPrompt = state.systemPrompt;
    this.toolRegistry = state.toolRegistry;
  }

  readonly getConversationMessages = (): readonly Message[] => this.messages;

  readonly stripThoughtsFromConversationHistory = (): void => {
    this.messages = stripThoughtSignaturesFromMessages(this.messages);
  };

  readonly getSystemPrompt = (): SystemPrompt | undefined =>
    this.cacheSafeSnapshot?.systemPrompt ?? this.systemPrompt;

  readonly getParentToolSchemas = (): ReturnType<
    ToolRegistry['getSchema']
  > =>
    this.cacheSafeSnapshot?.toolSchemas ??
    this.toolRegistry?.getSchema() ??
    [];

  readonly getCacheSafeQuerySnapshot = (): CacheSafeQuerySnapshot | null =>
    this.cacheSafeSnapshot;

  readonly appendMessage = (message: Message): void => {
    this.messages.push(message);
  };

  readonly setCacheSafeSnapshot = (snapshot: CacheSafeQuerySnapshot): void => {
    this.cacheSafeSnapshot = snapshot;
  };
}
