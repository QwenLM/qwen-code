/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Public aliases over the message contract plus the permission/turn-collapse
 * shapes the panel renders. Host-specific composer types (CommandInfo, ModelInfo)
 * stay in each host — they are not part of the shared panel contract.
 */
import type {
  DaemonMessage,
  DaemonMessageToolCall,
  DaemonMessageToolCallContent,
  DaemonMessageToolCallStatus,
  DaemonMessageToolKind,
  DaemonMessageToolCallLocation,
  DaemonMessageTodoItem,
} from './messageTypes';

export type Message = DaemonMessage;
export type ACPToolCall = DaemonMessageToolCall;
export type ToolCallContent = DaemonMessageToolCallContent;
export type ToolCallStatus = DaemonMessageToolCallStatus;
export type ToolKind = DaemonMessageToolKind;
export type ToolCallLocation = DaemonMessageToolCallLocation;
export type TodoItem = DaemonMessageTodoItem;

// Per-variant message types are addressed via the `Daemon*` names (see
// ./messageTypes) or the discriminated `Message` union; no bare aliases here,
// so the names stay free for the message *components* of the same role.

/**
 * Collapse state attached to a turn's leading user-message row. A "turn" spans
 * one user message up to (but not including) the next, and when collapsed its
 * intermediate steps (thinking, tool calls, mid-turn assistant text) are hidden,
 * leaving only the prompt and the final answer. Carried on the user
 * `DisplayItem` so the row can render its own expand/collapse toggle.
 */
export interface TurnCollapseHead {
  /** id of the turn's user message; the key used to toggle the turn. */
  turnId: string;
  /** whether the turn's intermediate steps are currently hidden. */
  collapsed: boolean;
  /** number of display rows hidden behind the toggle while collapsed. */
  hiddenCount: number;
  /**
   * Wall-clock span from the prompt to the turn's last step, in ms. Derived
   * from block timestamps (so it survives replay); undefined when either end
   * lacks a timestamp. Approximate — a step's own runtime past its start is not
   * captured.
   */
  elapsedMs?: number;
  /**
   * Per-turn token usage, summed from the turn's assistant messages. Both fields
   * are present together or the pair is undefined (older sessions stamp no
   * usage). Sub-agent tokens are included (see the SDK reducer).
   */
  inputTokens?: number;
  outputTokens?: number;
  /** Cached-read tokens — a subset of inputTokens, surfaced only when > 0. */
  cachedTokens?: number;
  /** Number of tool calls shown in this turn. */
  toolCallCount?: number;
  /** Number of assistant thinking blocks shown in this turn. */
  thinkingCount?: number;
  /**
   * Prompt wall-clock (ms) for a still-running turn. Present only while the turn
   * is active; the row ticks `now - liveStartedAt` once a second so the elapsed
   * advances smoothly instead of jumping per step. Absent once complete, when
   * the frozen `elapsedMs` is shown.
   */
  liveStartedAt?: number;
}

export interface ContentBlock {
  type: 'text' | 'image';
  text?: string;
  source?: { type: string; media_type: string; data: string };
}

export type PermissionOptionKind =
  | 'allow_once'
  | 'allow_always'
  | 'reject_once'
  | 'reject_always';

export interface PermissionOption {
  id: string;
  label: string;
  kind?: PermissionOptionKind;
}

export interface PermissionRequest {
  id: string;
  sessionId?: string;
  toolCallId?: string;
  title?: string;
  toolKind?: string;
  /** Canonical tool name (from the ACP frame's `_meta.toolName`). */
  toolName?: string;
  content: ContentBlock[];
  options: PermissionOption[];
  rawInput?: Record<string, unknown>;
  kind?: string;
}
