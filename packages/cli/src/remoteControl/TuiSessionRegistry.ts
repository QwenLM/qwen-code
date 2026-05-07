/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  appendFileSync,
  createReadStream,
  statSync,
  unwatchFile,
  watchFile,
} from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import type { PermissionMode } from '../nonInteractive/types.js';
import { EventLog } from './EventLog.js';
import {
  isRecord,
  type RemoteEvent,
  type RemoteSessionCreatePayload,
  type RemoteSessionSnapshot,
  type RemoteSessionState,
  type RemoteToolResponsePayload,
} from './protocol.js';
import type {
  RemoteControlSessionRegistry,
  SessionEventListener,
} from './SessionRegistry.js';

export interface TuiSessionRegistryOptions {
  sessionId: string;
  cwd: string;
  model?: string;
  permissionMode?: PermissionMode;
  inputFilePath: string;
  outputFilePath: string;
  pollIntervalMs?: number;
}

export class TuiSessionRegistry implements RemoteControlSessionRegistry {
  private readonly log = new EventLog();
  private readonly listeners = new Set<SessionEventListener>();
  private readonly inputFilePath: string;
  private readonly outputFilePath: string;
  private readonly pollIntervalMs: number;
  private snapshot: RemoteSessionSnapshot;
  private bytesRead = 0;
  private pendingOutput = '';
  private reading = false;
  private active = true;

  constructor(options: TuiSessionRegistryOptions) {
    const now = new Date().toISOString();
    this.inputFilePath = options.inputFilePath;
    this.outputFilePath = options.outputFilePath;
    this.pollIntervalMs = options.pollIntervalMs ?? 250;
    this.snapshot = {
      id: options.sessionId,
      cwd: options.cwd,
      model: options.model,
      permissionMode: options.permissionMode,
      mode: 'tui',
      state: 'starting',
      createdAt: now,
      updatedAt: now,
    };
    this.append('session/state', this.getSession(options.sessionId));
    this.startWatchingOutput();
  }

  subscribe(listener: SessionEventListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  createSession(
    payload: RemoteSessionCreatePayload = {},
  ): RemoteSessionSnapshot {
    if (payload.mode && payload.mode !== 'tui') {
      throw new Error(`Unsupported remote session mode: ${payload.mode}`);
    }
    if (payload.cwd && path.resolve(payload.cwd) !== path.resolve(this.cwd)) {
      throw new Error('Attached TUI sessions cannot change working directory');
    }
    if (payload.name) {
      this.snapshot = {
        ...this.snapshot,
        name: payload.name,
      };
      this.touch();
    }
    if (payload.model) {
      this.setModel(this.snapshot.id, payload.model);
    }
    if (payload.permissionMode) {
      this.setPermissionMode(this.snapshot.id, payload.permissionMode);
    }
    this.setState('idle');
    return this.getSession(this.snapshot.id);
  }

  listSessions(): RemoteSessionSnapshot[] {
    return [this.getSession(this.snapshot.id)];
  }

  getSession(sessionId: string): RemoteSessionSnapshot {
    this.assertSession(sessionId);
    return { ...this.snapshot };
  }

  replay(
    sessionId: string,
    since?: number,
  ): {
    events: RemoteEvent[];
    truncated: boolean;
  } {
    this.assertSession(sessionId);
    return this.log.replay(since);
  }

  submit(sessionId: string, text: string): void {
    this.assertSession(sessionId);
    if (!text.trim()) {
      throw new Error('Prompt text is required');
    }
    this.writeInputCommand({ type: 'submit', text });
    this.setState('working');
    this.append('event/append', { type: 'remote_user_submit', text });
  }

  respondToTool(sessionId: string, payload: RemoteToolResponsePayload): void {
    this.assertSession(sessionId);
    this.writeInputCommand({
      type: 'confirmation_response',
      request_id: payload.requestId,
      allowed: payload.behavior === 'allow',
    });
    this.setState('working');
  }

  interrupt(sessionId: string): string {
    this.assertSession(sessionId);
    const requestId = randomUUID();
    this.writeInputCommand({ type: 'interrupt', request_id: requestId });
    this.setState('interrupted');
    return requestId;
  }

  setModel(sessionId: string, model: string): string {
    this.assertSession(sessionId);
    if (!model.trim()) {
      throw new Error('Model is required');
    }
    const requestId = randomUUID();
    this.snapshot = { ...this.snapshot, model };
    this.touch();
    this.writeInputCommand({ type: 'set_model', request_id: requestId, model });
    this.append('session/state', this.getSession(sessionId));
    return requestId;
  }

  setPermissionMode(sessionId: string, mode: PermissionMode): string {
    this.assertSession(sessionId);
    const requestId = randomUUID();
    this.snapshot = { ...this.snapshot, permissionMode: mode };
    this.touch();
    this.writeInputCommand({
      type: 'set_permission_mode',
      request_id: requestId,
      mode,
    });
    this.append('session/state', this.getSession(sessionId));
    return requestId;
  }

  getContextUsage(sessionId: string, _showDetails: boolean = false): string {
    this.assertSession(sessionId);
    const requestId = randomUUID();
    this.append('control/response', {
      type: 'control_response',
      response: {
        subtype: 'error',
        request_id: requestId,
        error: 'Context usage is not available for attached TUI sessions yet.',
      },
    });
    return requestId;
  }

  closeSession(sessionId: string): void {
    this.assertSession(sessionId);
    this.append('event/append', {
      type: 'remote_session_close_ignored',
      message: 'Attached TUI sessions are detached, not terminated.',
    });
  }

  closeAll(): void {
    // The remote server must not terminate the current interactive terminal.
  }

  shutdown(): void {
    this.active = false;
    unwatchFile(this.outputFilePath);
  }

  checkForOutput(): Promise<void> {
    return this.readNewOutput();
  }

  private get cwd(): string {
    return this.snapshot.cwd;
  }

  private startWatchingOutput(): void {
    try {
      this.bytesRead = statSync(this.outputFilePath).size;
    } catch {
      this.bytesRead = 0;
    }

    watchFile(this.outputFilePath, { interval: this.pollIntervalMs }, () => {
      if (!this.active) return;
      void this.readNewOutput();
    });
  }

  private readNewOutput(): Promise<void> {
    if (!this.active || this.reading) return Promise.resolve();

    let currentSize: number;
    try {
      currentSize = statSync(this.outputFilePath).size;
    } catch {
      return Promise.resolve();
    }

    if (currentSize < this.bytesRead) {
      this.bytesRead = 0;
    }
    if (currentSize <= this.bytesRead) {
      return Promise.resolve();
    }

    this.reading = true;
    const chunks: string[] = [];
    const stream = createReadStream(this.outputFilePath, {
      start: this.bytesRead,
      end: currentSize - 1,
      encoding: 'utf-8',
    });

    return new Promise<void>((resolve) => {
      stream.on('data', (chunk) => {
        chunks.push(String(chunk));
      });
      stream.on('error', (error) => {
        this.append('error', { message: error.message });
        this.reading = false;
        resolve();
      });
      stream.on('end', () => {
        const text = this.pendingOutput + chunks.join('');
        const lines = text.split(/\r?\n/);
        this.pendingOutput = lines.pop() ?? '';
        for (const line of lines) {
          this.handleOutputLine(line);
        }
        this.bytesRead = currentSize;
        this.reading = false;
        resolve();
      });
    });
  }

  private handleOutputLine(line: string): void {
    const trimmed = line.trim();
    if (!trimmed) return;
    try {
      this.handleOutputMessage(JSON.parse(trimmed));
    } catch (error) {
      this.append('error', {
        message:
          error instanceof Error
            ? error.message
            : `Failed to parse TUI output line: ${trimmed}`,
      });
    }
  }

  private handleOutputMessage(message: unknown): void {
    if (!isRecord(message)) {
      this.append('event/append', message);
      return;
    }

    if (message['type'] === 'control_request') {
      const request = message as Record<string, unknown>;
      const body = isRecord(request['request']) ? request['request'] : {};
      if (body['subtype'] === 'can_use_tool') {
        this.setState('waiting_for_approval');
      }
      this.append('control/request', request);
      return;
    }

    if (message['type'] === 'control_response') {
      this.append('control/response', message);
      return;
    }

    if (message['type'] === 'system' && message['subtype'] === 'session_end') {
      this.setState('closed');
      this.append('event/append', message);
      return;
    }

    if (
      message['type'] === 'system' &&
      message['subtype'] === 'session_start'
    ) {
      this.setState('idle');
      this.append('event/append', message);
      return;
    }

    if (
      message['type'] === 'user' ||
      message['type'] === 'assistant' ||
      message['type'] === 'stream_event' ||
      message['type'] === 'system'
    ) {
      this.setState('working');
    }

    if (message['type'] === 'result') {
      this.setState('idle');
    }

    this.append('event/append', message);
  }

  private setState(state: RemoteSessionState, lastError?: string): void {
    const previousState = this.snapshot.state;
    this.snapshot = {
      ...this.snapshot,
      state,
      updatedAt: new Date().toISOString(),
      ...(lastError && { lastError }),
    };
    if (previousState !== state || lastError) {
      this.append('session/state', this.getSession(this.snapshot.id));
    }
  }

  private touch(): void {
    this.snapshot = {
      ...this.snapshot,
      updatedAt: new Date().toISOString(),
    };
  }

  private append<TPayload>(
    type: string,
    payload: TPayload,
  ): RemoteEvent<TPayload> {
    const event = this.log.append(this.snapshot.id, type, payload);
    for (const listener of this.listeners) {
      listener(this.snapshot.id, event);
    }
    return event;
  }

  private writeInputCommand(command: Record<string, unknown>): void {
    appendFileSync(this.inputFilePath, `${JSON.stringify(command)}\n`, {
      encoding: 'utf-8',
    });
  }

  private assertSession(sessionId: string): void {
    if (sessionId !== this.snapshot.id) {
      throw new Error(`Unknown remote session: ${sessionId}`);
    }
  }
}
