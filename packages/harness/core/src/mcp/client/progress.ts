/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { coreEvents } from '../../utils/events.js';

/**
 * Interface for reporting progress from MCP tool calls.
 */
export interface McpProgressReporter {
  registerProgressToken(
    token: string | number,
    callId: string,
    sessionId: string,
  ): void;
  registerIdleActivity?(
    token: string | number,
    idleActivity?: {
      touch(): void;
      pause(): void;
      resume(): void;
    },
  ): void;
  unregisterProgressToken(token: string | number): void;
  pauseIdleTimeouts?(): void;
  resumeIdleTimeouts?(): void;
  /** Receives an inbound progress notification for a registered token. */
  handleProgress?(notification: {
    params: {
      progressToken: string | number;
      progress: number;
      total?: number;
      message?: string;
    };
  }): void;
}

type McpProgressRegistration = {
  owner?: { callId: string; sessionId: string };
  idleActivity?: {
    touch(): void;
    pause(): void;
    resume(): void;
  };
};

export class McpProgressTracker implements McpProgressReporter {
  private readonly registrations = new Map<
    string | number,
    McpProgressRegistration
  >();

  constructor(private readonly serverName: string) {}

  registerProgressToken(
    token: string | number,
    callId: string,
    sessionId: string,
  ): void {
    this.registrations.set(token, {
      ...this.registrations.get(token),
      owner: { callId, sessionId },
    });
  }

  registerIdleActivity(
    token: string | number,
    idleActivity?: McpProgressRegistration['idleActivity'],
  ): void {
    this.registrations.set(token, {
      ...this.registrations.get(token),
      idleActivity,
    });
  }

  unregisterProgressToken(token: string | number): void {
    this.registrations.delete(token);
  }

  handleProgress(notification: {
    params: {
      progressToken: string | number;
      progress: number;
      total?: number;
      message?: string;
    };
  }): void {
    const { progressToken, progress, total, message } = notification.params;
    const registration = this.registrations.get(progressToken);
    if (!registration) return;

    registration.idleActivity?.touch();
    if (registration.owner) {
      coreEvents.emitMcpProgress({
        ...registration.owner,
        serverName: this.serverName,
        progressToken,
        progress,
        total,
        message,
      });
    }
  }

  pauseIdleTimeouts(): void {
    for (const { idleActivity } of this.registrations.values()) {
      idleActivity?.pause();
    }
  }

  resumeIdleTimeouts(): void {
    for (const { idleActivity } of this.registrations.values()) {
      idleActivity?.resume();
    }
  }
}
