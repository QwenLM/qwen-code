/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * @fileoverview Shared progress tracking utility for agent-like executions.
 *
 * Extracted from `subagent-tool.ts` so that both the SubAgent tool and the
 * fork skill execution path (`activate-skill.ts`) can report progress via
 * the same `SubagentProgress` mechanism without duplicating event handling.
 */

import { randomUUID } from 'node:crypto';
import type { QueryEvent } from '../core/query-event.js';
import { SUBAGENT_PROGRESS_ACTIVITY_LIMIT } from './types.js';
import type {
  SubagentActivityItem,
  SubagentProgress,
  AgentColor,
} from './types.js';
import type { ToolLiveOutput } from '../tools/tools.js';
import {
  getToolUseDisplayMetadata,
  normalizeToolInput,
} from '../tools/tool-use-display.js';
import { normalizeSpace } from '../utils/fastAckHelper.js';

const TOOL_ACTIVITY_DESCRIPTION_MAX_LENGTH = 120;

export interface ProgressTrackerOptions {
  /** Display name for the progress UI. */
  agentName: string;
  /** Stable identity for lazy loading the full subagent transcript. */
  agentId?: string;
  /** Original prompt used to invoke this agent. */
  prompt?: string;
  /** Optional UI color. */
  color?: AgentColor;
  /** Root used to render file path arguments as relative display paths. */
  targetDir?: string;
  /** Callback invoked whenever the progress state changes. */
  updateOutput: (output: ToolLiveOutput) => void;
  /** Optional callback for side effects derived from individual activity items. */
  publishActivity?: (activity: SubagentActivityItem) => void;
  /** Optional resolver for tool display names (API name → UI name). */
  resolveToolDisplayName?: (apiName: string) => string | undefined;
}

/**
 * Tracks query-event–based progress and pushes `SubagentProgress` updates
 * via the provided `updateOutput` callback.
 */
export class ProgressTracker {
  readonly recentActivity: SubagentActivityItem[] = [];
  private observedToolUseCount = 0;
  private readonly pendingToolDisplays = new Map<
    string,
    {
      status: SubagentActivityItem['status'];
      displayName?: string;
      description?: string;
    }
  >();
  private readonly toolActivitiesById = new Map<string, SubagentActivityItem>();
  private readonly opts: ProgressTrackerOptions;

  constructor(opts: ProgressTrackerOptions) {
    this.opts = opts;
  }

  get toolUseCount(): number {
    return this.observedToolUseCount;
  }

  private trimRecentActivity(): void {
    const overflow =
      this.recentActivity.length - SUBAGENT_PROGRESS_ACTIVITY_LIMIT;
    if (overflow > 0) {
      this.recentActivity.splice(0, overflow);
    }
  }

  private appendActivity(activity: SubagentActivityItem): void {
    this.recentActivity.push(activity);
    this.trimRecentActivity();
  }

  /** If the last activity item is a running thought, mark it completed. */
  private completeRunningThought(): void {
    const last = this.recentActivity[this.recentActivity.length - 1];
    if (last && last.type === 'thought' && last.status === 'running') {
      last.status = 'completed';
    }
  }

  /** Mark all running activity items with the given status. */
  markRunningAs(status: SubagentActivityItem['status']): void {
    const running = new Set(this.toolActivitiesById.values());
    for (const item of running) {
      if (item.status === 'running') {
        item.status = status;
        this.opts.publishActivity?.(item);
      }
    }
    this.toolActivitiesById.clear();
    for (const item of this.recentActivity) {
      if (item.type === 'thought' && item.status === 'running') {
        item.status = status;
      }
    }
  }

  /** Append an error activity item unless the last item is already an error. */
  addErrorActivity(message: string): void {
    const last = this.recentActivity[this.recentActivity.length - 1];
    if (last?.status === 'error') return;
    const activity: SubagentActivityItem = {
      id: randomUUID(),
      type: 'thought',
      content: message,
      status: 'error',
    };
    this.appendActivity(activity);
    this.opts.publishActivity?.(activity);
  }

  updateToolDisplay(update: {
    toolUseId: string;
    status: SubagentActivityItem['status'];
    displayName?: string;
    description?: string;
  }): void {
    if (update.displayName === undefined && update.description === undefined) {
      return;
    }

    this.pendingToolDisplays.set(update.toolUseId, {
      status: update.status,
      displayName: update.displayName,
      description:
        update.description === undefined
          ? undefined
          : truncateActivityDescription(update.description),
    });

    const item = this.toolActivitiesById.get(update.toolUseId);
    if (item) {
      item.status = update.status;
      item.displayName = update.displayName ?? item.displayName;
      item.description =
        update.description === undefined
          ? item.description
          : truncateActivityDescription(update.description);
      this.pendingToolDisplays.delete(update.toolUseId);
      this.opts.publishActivity?.(item);
      this.opts.updateOutput(this.makeProgress('running'));
      return;
    }
  }

  /** Build a `SubagentProgress` snapshot from the current activity state. */
  makeProgress(
    state: SubagentProgress['state'],
    extra?: Partial<SubagentProgress>,
  ): SubagentProgress {
    return {
      isSubagentProgress: true,
      agentName: this.opts.agentName,
      agentId: this.opts.agentId,
      prompt: this.opts.prompt,
      color: this.opts.color,
      toolUseCount: this.observedToolUseCount,
      // Parent progress is always bounded. Full history is loaded from the
      // independently persisted subagent transcript only while a detail view
      // is mounted.
      recentActivity: [...this.recentActivity],
      state,
      ...extra,
    };
  }

  /** Process a single `QueryEvent` and push an update if state changed. */
  handleQueryEvent(event: QueryEvent): void {
    let updated = false;

    if (event.type === 'user') {
      const msg = event;
      if (msg.message?.content && Array.isArray(msg.message.content)) {
        for (const block of msg.message.content) {
          if (
            block &&
            typeof block === 'object' &&
            'type' in block &&
            block.type === 'tool_result'
          ) {
            const toolResult = block as {
              content?: unknown;
              is_error?: boolean;
              tool_use_id?: unknown;
              toolUseResult?: unknown;
            };
            const toolUseId =
              typeof toolResult.tool_use_id === 'string'
                ? toolResult.tool_use_id
                : undefined;
            const activity = this.findToolResultActivity(toolUseId);
            if (activity) {
              activity.status = toolResult.is_error ? 'error' : 'completed';
              this.opts.publishActivity?.(activity);
              if (toolUseId) {
                this.toolActivitiesById.delete(toolUseId);
              }
              updated = true;
            }
          }
        }
      }
    }

    if (event.type === 'assistant') {
      const msg = event;
      this.completeRunningThought();

      for (const block of msg.message.content) {
        if (
          block &&
          typeof block === 'object' &&
          'type' in block &&
          block.type === 'tool_use'
        ) {
          this.observedToolUseCount++;
          const toolUse = block as {
            id?: unknown;
            name?: string;
            input?: unknown;
          };
          const name = toolUse.name ?? 'unknown';
          const input = normalizeToolInput(toolUse.input);
          const metadata = getToolUseDisplayMetadata(name, input, {
            targetDir: this.opts.targetDir,
          });
          const description = truncateActivityDescription(metadata.description);
          const displayName =
            this.opts.resolveToolDisplayName?.(name) ?? metadata.displayName;
          const args = getToolArgsDisplayString(description);
          const id = typeof toolUse.id === 'string' ? toolUse.id : randomUUID();
          const pendingDisplay = this.pendingToolDisplays.get(id);
          const activity: SubagentActivityItem = {
            id,
            type: 'tool_call',
            content: name,
            displayName: pendingDisplay?.displayName ?? displayName,
            description: pendingDisplay?.description ?? description,
            args,
            status: pendingDisplay?.status ?? 'running',
          };
          this.appendActivity(activity);
          this.toolActivitiesById.set(id, activity);
          if (pendingDisplay) {
            this.pendingToolDisplays.delete(id);
          }
          this.opts.publishActivity?.(activity);
          updated = true;
        }
      }
    }

    // Compact boundary: agent-loop yields the marker as a Message QueryEvent
    // after compression so the subagent's ctrl+o expand view can show the
    // "✻ Compressed N → M" note inline with other activity.
    if (event.type === 'system' && event.subtype === 'compact_boundary') {
      const meta = event.compactMetadata;
      this.completeRunningThought();
      const activity: SubagentActivityItem = {
        id: event.uuid,
        type: 'compact',
        content: 'Conversation compacted',
        status: 'completed',
        preTokens: meta?.preTokens,
        postTokens: meta?.postTokens,
      };
      this.appendActivity(activity);
      this.opts.publishActivity?.(activity);
      updated = true;
    }

    if (updated) {
      this.opts.updateOutput(this.makeProgress('running'));
    }
  }

  private findToolResultActivity(
    toolUseId: string | undefined,
  ): SubagentActivityItem | undefined {
    return toolUseId ? this.toolActivitiesById.get(toolUseId) : undefined;
  }
}

function getToolArgsDisplayString(description: string): string | undefined {
  return description ? JSON.stringify({ description }) : undefined;
}

function truncateActivityDescription(description: string): string {
  const normalized = normalizeSpace(description);
  return normalized.length > TOOL_ACTIVITY_DESCRIPTION_MAX_LENGTH
    ? `${normalized.slice(0, TOOL_ACTIVITY_DESCRIPTION_MAX_LENGTH)}...`
    : normalized;
}
