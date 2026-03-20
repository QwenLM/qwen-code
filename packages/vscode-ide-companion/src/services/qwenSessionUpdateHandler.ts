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

import type {
  SessionNotification,
  AvailableCommand,
} from '@agentclientprotocol/sdk';
import type { SessionUpdateMeta } from '../types/acpTypes.js';
import type { ApprovalModeValue } from '../types/approvalModeValueTypes.js';
import type {
  QwenAgentCallbacks,
  UsageStatsPayload,
} from '../types/chatTypes.js';

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
  handleSessionUpdate(data: SessionNotification): void {
    const update = data.update;
    const sessionUpdate = (update as { sessionUpdate?: string }).sessionUpdate;
    console.log(
      '[SessionUpdateHandler] Processing update type:',
      sessionUpdate,
    );

    switch (sessionUpdate) {
      case 'user_message_chunk': {
        const text = this.getTextContent(
          (update as { content?: unknown }).content,
        );
        if (text && this.callbacks.onStreamChunk) {
          this.callbacks.onStreamChunk(text);
        }
        break;
      }

      case 'agent_message_chunk': {
        const text = this.getTextContent(
          (update as { content?: unknown }).content,
        );
        if (text && this.callbacks.onStreamChunk) {
          this.callbacks.onStreamChunk(text);
        }
        this.emitUsageMeta(
          (update as { _meta?: SessionUpdateMeta | null })._meta,
        );
        break;
      }

      case 'agent_thought_chunk': {
        const text = this.getTextContent(
          (update as { content?: unknown }).content,
        );
        if (text) {
          if (this.callbacks.onThoughtChunk) {
            this.callbacks.onThoughtChunk(text);
          } else if (this.callbacks.onStreamChunk) {
            // Fallback to regular stream processing
            console.log(
              '[SessionUpdateHandler] 🧠 Falling back to onStreamChunk',
            );
            this.callbacks.onStreamChunk(text);
          }
        }
        this.emitUsageMeta(
          (update as { _meta?: SessionUpdateMeta | null })._meta,
        );
        break;
      }

      case 'tool_call': {
        // Handle new tool call
        if (this.callbacks.onToolCall && 'toolCallId' in update) {
          const meta = update._meta as SessionUpdateMeta | undefined;
          const timestamp =
            typeof meta?.timestamp === 'number' ? meta.timestamp : undefined;
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
            ...(timestamp !== undefined && { timestamp }),
          });
        }
        break;
      }

      case 'tool_call_update': {
        if (this.callbacks.onToolCall && 'toolCallId' in update) {
          const meta = update._meta as SessionUpdateMeta | undefined;
          const timestamp =
            typeof meta?.timestamp === 'number' ? meta.timestamp : undefined;
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
            ...(timestamp !== undefined && { timestamp }),
          });
        }
        break;
      }

      case 'plan': {
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

      case 'current_mode_update': {
        // Notify UI about mode change
        try {
          const modeId = (
            update as unknown as { currentModeId?: ApprovalModeValue }
          ).currentModeId;
          if (modeId && this.callbacks.onModeChanged) {
            this.callbacks.onModeChanged(modeId);
          }
        } catch (err) {
          console.warn(
            '[SessionUpdateHandler] Failed to handle mode update',
            err,
          );
        }
        break;
      }

      case 'available_commands_update': {
        // Notify UI about available commands
        try {
          const commands = (
            update as unknown as { availableCommands?: AvailableCommand[] }
          ).availableCommands;
          if (commands && this.callbacks.onAvailableCommands) {
            this.callbacks.onAvailableCommands(commands);
          }
        } catch (err) {
          console.warn(
            '[SessionUpdateHandler] Failed to handle available commands update',
            err,
          );
        }
        break;
      }

      case 'available_skills_update': {
        try {
          const skills = (
            update as unknown as {
              availableSkills?: Array<{
                name: string;
                description: string;
              }>;
            }
          ).availableSkills;
          if (skills && this.callbacks.onAvailableSkills) {
            this.callbacks.onAvailableSkills(skills);
          }
        } catch (err) {
          console.warn(
            '[SessionUpdateHandler] Failed to handle available skills update',
            err,
          );
        }
        break;
      }

      default:
        console.log('[QwenAgentManager] Unhandled session update type');
        break;
    }
  }

  private getTextContent(content: unknown): string | undefined {
    if (!content || typeof content !== 'object') {
      return undefined;
    }
    const text = (content as { text?: unknown }).text;
    return typeof text === 'string' ? text : undefined;
  }

  private emitUsageMeta(meta?: SessionUpdateMeta | null): void {
    if (!meta || !this.callbacks.onUsageUpdate) {
      return;
    }

    const raw = meta.usage as Record<string, unknown> | null | undefined;
    const usage = raw
      ? {
          // SDK field names
          inputTokens:
            (raw['inputTokens'] as number | null | undefined) ??
            (raw['promptTokens'] as number | null | undefined),
          outputTokens:
            (raw['outputTokens'] as number | null | undefined) ??
            (raw['completionTokens'] as number | null | undefined),
          thoughtTokens:
            (raw['thoughtTokens'] as number | null | undefined) ??
            (raw['thoughtsTokens'] as number | null | undefined),
          totalTokens: raw['totalTokens'] as number | null | undefined,
          cachedReadTokens:
            (raw['cachedReadTokens'] as number | null | undefined) ??
            (raw['cachedTokens'] as number | null | undefined),
          cachedWriteTokens: raw['cachedWriteTokens'] as
            | number
            | null
            | undefined,
          // Legacy compat
          promptTokens:
            (raw['promptTokens'] as number | null | undefined) ??
            (raw['inputTokens'] as number | null | undefined),
          completionTokens:
            (raw['completionTokens'] as number | null | undefined) ??
            (raw['outputTokens'] as number | null | undefined),
          thoughtsTokens:
            (raw['thoughtsTokens'] as number | null | undefined) ??
            (raw['thoughtTokens'] as number | null | undefined),
          cachedTokens:
            (raw['cachedTokens'] as number | null | undefined) ??
            (raw['cachedReadTokens'] as number | null | undefined),
        }
      : undefined;

    const payload: UsageStatsPayload = {
      usage,
      durationMs: meta.durationMs ?? undefined,
    };

    this.callbacks.onUsageUpdate(payload);
  }
}
