/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { randomUUID } from 'node:crypto';
import type {
  CLIControlRequest,
  CLIControlResponse,
  PermissionMode,
} from '../nonInteractive/types.js';
import { EventLog } from './EventLog.js';
import {
  isRecord,
  type RemoteChildMessage,
  type RemoteEvent,
  type RemoteSessionCreatePayload,
  type RemoteSessionSnapshot,
  type RemoteSessionState,
  type RemoteToolResponsePayload,
} from './protocol.js';
import {
  RemoteSessionRunner,
  type RemoteSessionRunnerOptions,
} from './RemoteSessionRunner.js';

export interface RemoteSessionRunnerLike {
  start(): void;
  getPid(): number | undefined;
  getInitializeRequestId(): string | null;
  submit(text: string): void;
  respondToTool(payload: RemoteToolResponsePayload): void;
  interrupt(): string;
  setModel(model: string): string;
  setPermissionMode(mode: PermissionMode): string;
  getContextUsage(showDetails?: boolean): string;
  close(): void;
}

export interface SessionRegistryOptions {
  cwd: string;
  cliEntryPath: string;
  defaultModel?: string;
  defaultPermissionMode?: PermissionMode;
  runnerFactory?: (
    options: RemoteSessionRunnerOptions,
  ) => RemoteSessionRunnerLike;
}

interface RemoteSessionRecord {
  snapshot: RemoteSessionSnapshot;
  log: EventLog;
  runner: RemoteSessionRunnerLike;
}

export type SessionEventListener = (
  sessionId: string,
  event: RemoteEvent,
) => void;

export interface RemoteControlSessionRegistry {
  subscribe(listener: SessionEventListener): () => void;
  createSession(payload?: RemoteSessionCreatePayload): RemoteSessionSnapshot;
  listSessions(): RemoteSessionSnapshot[];
  getSession(sessionId: string): RemoteSessionSnapshot;
  replay(
    sessionId: string,
    since?: number,
  ): {
    events: RemoteEvent[];
    truncated: boolean;
  };
  submit(sessionId: string, text: string): void;
  respondToTool(sessionId: string, payload: RemoteToolResponsePayload): void;
  interrupt(sessionId: string): string;
  setModel(sessionId: string, model: string): string;
  setPermissionMode(sessionId: string, mode: PermissionMode): string;
  getContextUsage(sessionId: string, showDetails?: boolean): string;
  closeSession(sessionId: string): void;
  closeAll(): void;
}

export class SessionRegistry implements RemoteControlSessionRegistry {
  private readonly sessions = new Map<string, RemoteSessionRecord>();
  private readonly listeners = new Set<SessionEventListener>();
  private readonly options: SessionRegistryOptions;

  constructor(options: SessionRegistryOptions) {
    this.options = options;
  }

  subscribe(listener: SessionEventListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  createSession(
    payload: RemoteSessionCreatePayload = {},
  ): RemoteSessionSnapshot {
    if (payload.mode && payload.mode !== 'worker') {
      throw new Error(`Unsupported remote session mode: ${payload.mode}`);
    }

    const id = randomUUID();
    const now = new Date().toISOString();
    const log = new EventLog();
    const snapshot: RemoteSessionSnapshot = {
      id,
      ...(payload.name && { name: payload.name }),
      cwd: payload.cwd ?? this.options.cwd,
      model: payload.model ?? this.options.defaultModel,
      permissionMode:
        payload.permissionMode ?? this.options.defaultPermissionMode,
      mode: 'worker',
      state: 'starting',
      createdAt: now,
      updatedAt: now,
    };

    const runnerOptions: RemoteSessionRunnerOptions = {
      sessionId: id,
      cwd: snapshot.cwd,
      cliEntryPath: this.options.cliEntryPath,
      model: snapshot.model,
      permissionMode: snapshot.permissionMode,
      onMessage: (message) => this.handleChildMessage(id, message),
      onStderr: (line) => this.append(id, 'event/append', { stderr: line }),
      onExit: ({ code, signal }) => {
        const details = { code, signal };
        this.append(id, 'event/append', { childExit: details });
        this.setState(id, 'closed');
      },
      onError: (error) => {
        this.setState(id, 'error', error.message);
        this.append(id, 'error', { message: error.message });
      },
    };
    const runner =
      this.options.runnerFactory?.(runnerOptions) ??
      new RemoteSessionRunner(runnerOptions);

    const record: RemoteSessionRecord = {
      snapshot,
      log,
      runner,
    };
    this.sessions.set(id, record);
    runner.start();
    snapshot.pid = runner.getPid();
    this.append(id, 'session/state', this.getSession(id));
    return this.getSession(id);
  }

  listSessions(): RemoteSessionSnapshot[] {
    return [...this.sessions.values()].map((record) => ({
      ...record.snapshot,
    }));
  }

  getSession(sessionId: string): RemoteSessionSnapshot {
    const record = this.getRecord(sessionId);
    return { ...record.snapshot };
  }

  replay(
    sessionId: string,
    since?: number,
  ): {
    events: RemoteEvent[];
    truncated: boolean;
  } {
    return this.getRecord(sessionId).log.replay(since);
  }

  submit(sessionId: string, text: string): void {
    if (!text.trim()) {
      throw new Error('Prompt text is required');
    }
    const record = this.getRecord(sessionId);
    this.setState(sessionId, 'working');
    this.append(sessionId, 'event/append', {
      type: 'remote_user_submit',
      text,
    });
    record.runner.submit(text);
  }

  respondToTool(sessionId: string, payload: RemoteToolResponsePayload): void {
    const record = this.getRecord(sessionId);
    record.runner.respondToTool(payload);
    this.setState(sessionId, 'working');
  }

  interrupt(sessionId: string): string {
    const requestId = this.getRecord(sessionId).runner.interrupt();
    this.setState(sessionId, 'interrupted');
    return requestId;
  }

  setModel(sessionId: string, model: string): string {
    if (!model.trim()) {
      throw new Error('Model is required');
    }
    const record = this.getRecord(sessionId);
    record.snapshot.model = model;
    this.touch(record);
    return record.runner.setModel(model);
  }

  setPermissionMode(sessionId: string, mode: PermissionMode): string {
    const record = this.getRecord(sessionId);
    record.snapshot.permissionMode = mode;
    this.touch(record);
    return record.runner.setPermissionMode(mode);
  }

  getContextUsage(sessionId: string, showDetails: boolean = false): string {
    return this.getRecord(sessionId).runner.getContextUsage(showDetails);
  }

  closeSession(sessionId: string): void {
    const record = this.getRecord(sessionId);
    record.runner.close();
    this.setState(sessionId, 'closed');
  }

  closeAll(): void {
    for (const sessionId of this.sessions.keys()) {
      this.closeSession(sessionId);
    }
  }

  private handleChildMessage(
    sessionId: string,
    message: RemoteChildMessage,
  ): void {
    if (!isRecord(message)) {
      this.append(sessionId, 'event/append', message);
      return;
    }

    if (message['type'] === 'control_request') {
      this.handleControlRequest(
        sessionId,
        message as unknown as CLIControlRequest,
      );
      return;
    }
    if (message['type'] === 'control_response') {
      this.handleControlResponse(
        sessionId,
        message as unknown as CLIControlResponse,
      );
      return;
    }

    if (
      message['type'] === 'assistant' ||
      message['type'] === 'stream_event' ||
      message['type'] === 'system'
    ) {
      this.setState(sessionId, 'working');
    }
    if (message['type'] === 'result') {
      this.setState(sessionId, 'idle');
    }
    this.append(sessionId, 'event/append', message);
  }

  private handleControlRequest(
    sessionId: string,
    request: CLIControlRequest,
  ): void {
    if (request.request.subtype === 'can_use_tool') {
      this.setState(sessionId, 'waiting_for_approval');
    }
    this.append(sessionId, 'control/request', request);
  }

  private handleControlResponse(
    sessionId: string,
    response: CLIControlResponse,
  ): void {
    const record = this.getRecord(sessionId);
    if (
      response.response.request_id === record.runner.getInitializeRequestId() &&
      response.response.subtype === 'success'
    ) {
      this.setState(sessionId, 'idle');
    }
    this.append(sessionId, 'control/response', response);
  }

  private setState(
    sessionId: string,
    state: RemoteSessionState,
    lastError?: string,
  ): void {
    const record = this.getRecord(sessionId);
    const previousState = record.snapshot.state;
    record.snapshot.state = state;
    if (lastError) {
      record.snapshot.lastError = lastError;
    }
    this.touch(record);
    if (previousState !== state || lastError) {
      this.append(sessionId, 'session/state', this.getSession(sessionId));
    }
  }

  private append<TPayload>(
    sessionId: string,
    type: string,
    payload: TPayload,
  ): RemoteEvent<TPayload> {
    const record = this.getRecord(sessionId);
    const event = record.log.append(sessionId, type, payload);
    for (const listener of this.listeners) {
      listener(sessionId, event);
    }
    return event;
  }

  private touch(record: RemoteSessionRecord): void {
    record.snapshot.updatedAt = new Date().toISOString();
  }

  private getRecord(sessionId: string): RemoteSessionRecord {
    const record = this.sessions.get(sessionId);
    if (!record) {
      throw new Error(`Unknown remote session: ${sessionId}`);
    }
    return record;
  }
}
