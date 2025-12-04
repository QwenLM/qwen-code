/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Qwen Session Update Handler
 *
 * Handles session updates from ACP and dispatches them to appropriate callbacks
 */

import type { AcpSessionUpdate } from '../constants/acpTypes.js';
import type { QwenAgentCallbacks } from './qwenTypes.js';

/**
 * Qwen Session Update Handler class
 * Processes various session update events and calls appropriate callbacks
 */
export class QwenSessionUpdateHandler {
  private callbacks: QwenAgentCallbacks;

  constructor(callbacks: QwenAgentCallbacks) {
    this.callbacks = callbacks;
  }

  /**
   * Update callbacks
   *
   * @param callbacks - New callback collection
   */
  updateCallbacks(callbacks: QwenAgentCallbacks): void {
    this.callbacks = callbacks;
  }

  /**
   * Handle session update
   *
   * @param data - ACP session update data
   */
  handleSessionUpdate(data: AcpSessionUpdate): void {
    const update = data.update;
    console.log(
      '[SessionUpdateHandler] Processing update type:',
      update.sessionUpdate,
    );

    switch (update.sessionUpdate) {
      case 'user_message_chunk':
        // Handle user message chunk
        if (update.content?.text && this.callbacks.onStreamChunk) {
          this.callbacks.onStreamChunk(update.content.text);
        }
        break;

      case 'agent_message_chunk':
        // Handle assistant message chunk
        if (update.content?.text && this.callbacks.onStreamChunk) {
          this.callbacks.onStreamChunk(update.content.text);
        }
        break;

      case 'agent_thought_chunk':
        // Handle thought chunk - use special callback
        console.log(
          '[SessionUpdateHandler] 🧠 THOUGHT CHUNK:',
          update.content?.text,
        );
        if (update.content?.text) {
          if (this.callbacks.onThoughtChunk) {
            console.log(
              '[SessionUpdateHandler] 🧠 Calling onThoughtChunk callback',
            );
            this.callbacks.onThoughtChunk(update.content.text);
          } else if (this.callbacks.onStreamChunk) {
            // Fallback to regular stream processing
            console.log(
              '[SessionUpdateHandler] 🧠 Falling back to onStreamChunk',
            );
            this.callbacks.onStreamChunk(update.content.text);
          }
        }
        break;

      case 'tool_call': {
        // Handle new tool call
        if (this.callbacks.onToolCall && 'toolCallId' in update) {
          this.callbacks.onToolCall({
            toolCallId: update.toolCallId as string,
            kind: (update.kind as string) || undefined,
            title: (update.title as string) || undefined,
            status: (update.status as string) || undefined,
            rawInput: update.rawInput,
            content: update.content as
              | Array<Record<string, unknown>>
              | undefined,
            locations: update.locations as
              | Array<{ path: string; line?: number | null }>
              | undefined,
          });
        }
        break;
      }

      case 'tool_call_update': {
        // Handle tool call status update
        if (this.callbacks.onToolCall && 'toolCallId' in update) {
          this.callbacks.onToolCall({
            toolCallId: update.toolCallId as string,
            kind: (update.kind as string) || undefined,
            title: (update.title as string) || undefined,
            status: (update.status as string) || undefined,
            rawInput: update.rawInput,
            content: update.content as
              | Array<Record<string, unknown>>
              | undefined,
            locations: update.locations as
              | Array<{ path: string; line?: number | null }>
              | undefined,
          });
        }
        break;
      }

      case 'plan': {
        // Handle plan update
        if ('entries' in update) {
          const entries = update.entries as Array<{
            content: string;
            priority: 'high' | 'medium' | 'low';
            status: 'pending' | 'in_progress' | 'completed';
          }>;

          if (this.callbacks.onPlan) {
            this.callbacks.onPlan(entries);
          } else if (this.callbacks.onStreamChunk) {
            // Fallback to stream processing
            const planText =
              '\n📋 Plan:\n' +
              entries
                .map(
                  (entry, i) =>
                    `${i + 1}. [${entry.priority}] ${entry.content}`,
                )
                .join('\n');
            this.callbacks.onStreamChunk(planText);
          }
        }
        break;
      }

      default:
        console.log('[QwenAgentManager] Unhandled session update type');
        break;
    }
  }
}
