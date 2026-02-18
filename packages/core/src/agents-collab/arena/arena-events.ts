/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { EventEmitter } from 'events';
import type {
  ArenaAgentStatus,
  ArenaModelConfig,
  ArenaAgentStats,
  ArenaAgentResult,
  ArenaSessionResult,
} from './types.js';

/**
 * Arena event types.
 */
export enum ArenaEventType {
  /** Arena session started */
  SESSION_START = 'session_start',
  /** Arena session completed */
  SESSION_COMPLETE = 'session_complete',
  /** Arena session failed */
  SESSION_ERROR = 'session_error',
  /** Agent started */
  AGENT_START = 'agent_start',
  /** Agent status changed */
  AGENT_STATUS_CHANGE = 'agent_status_change',
  /** Agent streamed text */
  AGENT_STREAM_TEXT = 'agent_stream_text',
  /** Agent called a tool */
  AGENT_TOOL_CALL = 'agent_tool_call',
  /** Agent tool call completed */
  AGENT_TOOL_RESULT = 'agent_tool_result',
  /** Agent stats updated */
  AGENT_STATS_UPDATE = 'agent_stats_update',
  /** Agent completed */
  AGENT_COMPLETE = 'agent_complete',
  /** Agent error */
  AGENT_ERROR = 'agent_error',
  /** Non-fatal warning (e.g., backend fallback) */
  SESSION_WARNING = 'session_warning',
}

export type ArenaEvent =
  | 'session_start'
  | 'session_complete'
  | 'session_error'
  | 'agent_start'
  | 'agent_status_change'
  | 'agent_stream_text'
  | 'agent_tool_call'
  | 'agent_tool_result'
  | 'agent_stats_update'
  | 'agent_complete'
  | 'agent_error'
  | 'session_warning';

/**
 * Event payload for session start.
 */
export interface ArenaSessionStartEvent {
  sessionId: string;
  task: string;
  models: ArenaModelConfig[];
  timestamp: number;
}

/**
 * Event payload for session complete.
 */
export interface ArenaSessionCompleteEvent {
  sessionId: string;
  result: ArenaSessionResult;
  timestamp: number;
}

/**
 * Event payload for session error.
 */
export interface ArenaSessionErrorEvent {
  sessionId: string;
  error: string;
  timestamp: number;
}

/**
 * Event payload for agent start.
 */
export interface ArenaAgentStartEvent {
  sessionId: string;
  agentId: string;
  model: ArenaModelConfig;
  worktreePath: string;
  timestamp: number;
}

/**
 * Event payload for agent status change.
 */
export interface ArenaAgentStatusChangeEvent {
  sessionId: string;
  agentId: string;
  previousStatus: ArenaAgentStatus;
  newStatus: ArenaAgentStatus;
  timestamp: number;
}

/**
 * Event payload for agent stream text.
 */
export interface ArenaAgentStreamTextEvent {
  sessionId: string;
  agentId: string;
  text: string;
  isThought?: boolean;
  timestamp: number;
}

/**
 * Event payload for agent tool call.
 */
export interface ArenaAgentToolCallEvent {
  sessionId: string;
  agentId: string;
  callId: string;
  toolName: string;
  args: Record<string, unknown>;
  description?: string;
  timestamp: number;
}

/**
 * Event payload for agent tool result.
 */
export interface ArenaAgentToolResultEvent {
  sessionId: string;
  agentId: string;
  callId: string;
  toolName: string;
  success: boolean;
  error?: string;
  durationMs: number;
  timestamp: number;
}

/**
 * Event payload for agent stats update.
 */
export interface ArenaAgentStatsUpdateEvent {
  sessionId: string;
  agentId: string;
  stats: Partial<ArenaAgentStats>;
  timestamp: number;
}

/**
 * Event payload for agent complete.
 */
export interface ArenaAgentCompleteEvent {
  sessionId: string;
  agentId: string;
  result: ArenaAgentResult;
  timestamp: number;
}

/**
 * Event payload for agent error.
 */
export interface ArenaAgentErrorEvent {
  sessionId: string;
  agentId: string;
  error: string;
  timestamp: number;
}

/**
 * Event payload for session warning (non-fatal).
 */
export interface ArenaSessionWarningEvent {
  sessionId: string;
  message: string;
  timestamp: number;
}

/**
 * Type map for arena events.
 */
export interface ArenaEventMap {
  [ArenaEventType.SESSION_START]: ArenaSessionStartEvent;
  [ArenaEventType.SESSION_COMPLETE]: ArenaSessionCompleteEvent;
  [ArenaEventType.SESSION_ERROR]: ArenaSessionErrorEvent;
  [ArenaEventType.AGENT_START]: ArenaAgentStartEvent;
  [ArenaEventType.AGENT_STATUS_CHANGE]: ArenaAgentStatusChangeEvent;
  [ArenaEventType.AGENT_STREAM_TEXT]: ArenaAgentStreamTextEvent;
  [ArenaEventType.AGENT_TOOL_CALL]: ArenaAgentToolCallEvent;
  [ArenaEventType.AGENT_TOOL_RESULT]: ArenaAgentToolResultEvent;
  [ArenaEventType.AGENT_STATS_UPDATE]: ArenaAgentStatsUpdateEvent;
  [ArenaEventType.AGENT_COMPLETE]: ArenaAgentCompleteEvent;
  [ArenaEventType.AGENT_ERROR]: ArenaAgentErrorEvent;
  [ArenaEventType.SESSION_WARNING]: ArenaSessionWarningEvent;
}

/**
 * Event emitter for Arena events.
 */
export class ArenaEventEmitter {
  private ee = new EventEmitter();

  on<E extends keyof ArenaEventMap>(
    event: E,
    listener: (payload: ArenaEventMap[E]) => void,
  ): void {
    this.ee.on(event, listener as (...args: unknown[]) => void);
  }

  off<E extends keyof ArenaEventMap>(
    event: E,
    listener: (payload: ArenaEventMap[E]) => void,
  ): void {
    this.ee.off(event, listener as (...args: unknown[]) => void);
  }

  emit<E extends keyof ArenaEventMap>(
    event: E,
    payload: ArenaEventMap[E],
  ): void {
    this.ee.emit(event, payload);
  }

  once<E extends keyof ArenaEventMap>(
    event: E,
    listener: (payload: ArenaEventMap[E]) => void,
  ): void {
    this.ee.once(event, listener as (...args: unknown[]) => void);
  }

  removeAllListeners(event?: ArenaEvent): void {
    if (event) {
      this.ee.removeAllListeners(event);
    } else {
      this.ee.removeAllListeners();
    }
  }
}
