/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { EventEmitter } from 'events';
import type {
  ArenaAgentStatus,
  ArenaModelConfig,
  ArenaAgentResult,
  ArenaSessionResult,
} from './types.js';

/**
 * Arena event types.
 */
export enum ArenaEventType {
  /** Arena session started */
  SESSION_START = 'session_start',
  /** Informational or warning update during session lifecycle */
  SESSION_UPDATE = 'session_update',
  /** Arena session completed */
  SESSION_COMPLETE = 'session_complete',
  /** Arena session failed */
  SESSION_ERROR = 'session_error',
  /** Agent started */
  AGENT_START = 'agent_start',
  /** Agent status changed */
  AGENT_STATUS_CHANGE = 'agent_status_change',
  /** Agent completed */
  AGENT_COMPLETE = 'agent_complete',
  /** Agent error */
  AGENT_ERROR = 'agent_error',
}

export type ArenaEvent =
  | 'session_start'
  | 'session_update'
  | 'session_complete'
  | 'session_error'
  | 'agent_start'
  | 'agent_status_change'
  | 'agent_complete'
  | 'agent_error';

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
 * Event payload for agent error.
 */
export interface ArenaAgentErrorEvent {
  sessionId: string;
  agentId: string;
  error: string;
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
 * Event payload for session update (informational or warning).
 */
export type ArenaSessionUpdateType = 'info' | 'warning';

export interface ArenaSessionUpdateEvent {
  sessionId: string;
  type: ArenaSessionUpdateType;
  message: string;
  timestamp: number;
}

/**
 * Type map for arena events.
 */
export interface ArenaEventMap {
  [ArenaEventType.SESSION_START]: ArenaSessionStartEvent;
  [ArenaEventType.SESSION_UPDATE]: ArenaSessionUpdateEvent;
  [ArenaEventType.SESSION_COMPLETE]: ArenaSessionCompleteEvent;
  [ArenaEventType.SESSION_ERROR]: ArenaSessionErrorEvent;
  [ArenaEventType.AGENT_START]: ArenaAgentStartEvent;
  [ArenaEventType.AGENT_STATUS_CHANGE]: ArenaAgentStatusChangeEvent;
  [ArenaEventType.AGENT_COMPLETE]: ArenaAgentCompleteEvent;
  [ArenaEventType.AGENT_ERROR]: ArenaAgentErrorEvent;
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
