/**
 * @license
 * Copyright 2025 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { EventEmitter } from 'node:events';

export enum TransientMessageType {
  Warning = 'warning',
  Hint = 'hint',
  Success = 'success',
}

export interface TransientMessagePayload {
  /** Optional key used to replace or clear one specific message. */
  id?: string;
  /** Empty text clears the matching message id. */
  message: string;
  type: TransientMessageType;
  /** When true the message stays visible until replaced by another message. */
  persist?: boolean;
  /** Overrides the default display duration for this message. */
  durationMs?: number;
}

export const LONG_TRANSIENT_MESSAGE_DURATION_MS = 10_000;

export enum AppEvent {
  OpenDebugConsole = 'open-debug-console',
  Flicker = 'flicker',
  TerminalBackground = 'terminal-background',
  TransientMessage = 'transient-message',
  ScrollToBottom = 'scroll-to-bottom',
  UserScrolled = 'user-scrolled',
}

export interface UserScrolledPayload {
  /**
   * Whether the scrollable area is still pinned to the bottom after the user
   * scroll. Omitted when the caller can only report that manual scrolling
   * happened, not the resulting position.
   */
  isAtBottom?: boolean;
}

export interface AppEvents {
  [AppEvent.OpenDebugConsole]: never[];
  [AppEvent.Flicker]: never[];
  [AppEvent.TerminalBackground]: [string];
  [AppEvent.TransientMessage]: [TransientMessagePayload];
  [AppEvent.ScrollToBottom]: never[];
  [AppEvent.UserScrolled]: [UserScrolledPayload?];
}

export const appEvents = new EventEmitter<AppEvents>();
