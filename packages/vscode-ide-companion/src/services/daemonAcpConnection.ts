/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type {
  AuthenticateResponse,
  ContentBlock,
  ListSessionsResponse,
  LoadSessionResponse,
  NewSessionResponse,
  PromptResponse,
  SetSessionModeResponse,
  SetSessionModelResponse,
} from '@agentclientprotocol/sdk';
import type { ApprovalModeValue } from '../types/approvalModeValueTypes.js';
import { AcpConnection } from './acpConnection.js';
import { DaemonIdeConnection } from './daemonIdeConnection.js';

export interface DaemonAcpConnectionOptions {
  baseUrl: string;
  token?: string;
  modelServiceId?: string;
}

export type DaemonAcpConnectionOptionsProvider =
  () => DaemonAcpConnectionOptions;

/**
 * Adapter that lets the existing IDE manager/webview path exercise the daemon
 * transport without spawning a local ACP child process.
 *
 * It intentionally preserves AcpConnection's public shape so the first
 * daemon-backed IDE draft can stay small and fully flag-gated. Unsupported
 * session-management APIs remain explicit no-ops/failures until the daemon
 * protocol grows matching endpoints.
 */
export class DaemonAcpConnection extends AcpConnection {
  private readonly daemon = new DaemonIdeConnection();
  private daemonWorkingDir = process.cwd();

  constructor(
    private readonly optionsProvider: DaemonAcpConnectionOptionsProvider,
  ) {
    super();
  }

  override async connect(
    _cliEntryPath: string,
    workingDir: string = process.cwd(),
    _extraArgs: string[] = [],
  ): Promise<void> {
    this.daemonWorkingDir = workingDir;
    this.wireDaemonCallbacks();
    const options = this.optionsProvider();
    const baseUrl = options.baseUrl || 'http://127.0.0.1:4170';
    await this.daemon.connect({
      baseUrl,
      token: options.token || undefined,
      workspaceCwd: workingDir,
      modelServiceId: options.modelServiceId || undefined,
      lastEventId: this.daemon.lastEventId,
    });
  }

  override async authenticate(
    _methodId?: string,
  ): Promise<AuthenticateResponse> {
    return {} as AuthenticateResponse;
  }

  override async newSession(
    cwd: string = process.cwd(),
  ): Promise<NewSessionResponse> {
    if (!this.daemon.isConnected) {
      await this.connect('', cwd);
    }
    const sessionId = this.daemon.currentSessionId;
    if (!sessionId) {
      throw new Error('Daemon IDE session was not created');
    }
    return { sessionId } as NewSessionResponse;
  }

  override async sendPrompt(
    prompt: string | ContentBlock[],
  ): Promise<PromptResponse> {
    return (await this.daemon.sendPrompt(prompt)) as PromptResponse;
  }

  override async cancelSession(): Promise<void> {
    await this.daemon.cancelSession();
  }

  override async setModel(modelId: string): Promise<SetSessionModelResponse> {
    return (await this.daemon.setModel(modelId)) as SetSessionModelResponse;
  }

  override async setMode(
    _modeId: ApprovalModeValue,
  ): Promise<SetSessionModeResponse> {
    return {} as SetSessionModeResponse;
  }

  override async getAccountInfo(): Promise<{
    authType: string | null;
    model: string | null;
    baseUrl: string | null;
    apiKeyEnvKey: string | null;
  }> {
    return {
      authType: 'daemon',
      model: null,
      baseUrl: this.optionsProvider().baseUrl || 'http://127.0.0.1:4170',
      apiKeyEnvKey: null,
    };
  }

  override async listSessions(): Promise<ListSessionsResponse> {
    const sessionId = this.daemon.currentSessionId;
    return {
      sessions: sessionId
        ? [
            {
              sessionId,
              cwd: this.daemonWorkingDir,
            },
          ]
        : [],
    } as ListSessionsResponse;
  }

  override async loadSession(
    sessionId: string,
    _cwdOverride?: string,
  ): Promise<LoadSessionResponse> {
    if (sessionId === this.daemon.currentSessionId) {
      return { sessionId } as LoadSessionResponse;
    }
    throw new Error('Daemon IDE session/load is not wired in this draft');
  }

  override async deleteSession(
    _sessionId: string,
  ): Promise<{ success: boolean }> {
    return { success: false };
  }

  override async renameSession(
    _sessionId: string,
    _title: string,
  ): Promise<{ success: boolean }> {
    return { success: false };
  }

  override async switchSession(sessionId: string): Promise<void> {
    if (sessionId !== this.daemon.currentSessionId) {
      throw new Error(
        'Daemon IDE session switching is not wired in this draft',
      );
    }
  }

  override async rewindSession(
    _targetTurnIndex: number,
  ): Promise<{ historyBeforeRewind?: unknown[] }> {
    throw new Error('Daemon IDE rewind is not wired in this draft');
  }

  override async restoreSessionHistory(_history: unknown[]): Promise<void> {
    throw new Error('Daemon IDE history restore is not wired in this draft');
  }

  override disconnect(): void {
    void this.daemon.disconnect();
  }

  override get isConnected(): boolean {
    return this.daemon.isConnected;
  }

  override get currentSessionId(): string | null {
    return this.daemon.currentSessionId;
  }

  private wireDaemonCallbacks(): void {
    this.daemon.onSessionUpdate = (data) => this.onSessionUpdate(data);
    this.daemon.onPermissionRequest = (data) => this.onPermissionRequest(data);
    this.daemon.onAskUserQuestion = (data) => this.onAskUserQuestion(data);
    this.daemon.onEndTurn = (reason) => this.onEndTurn(reason);
    this.daemon.onDisconnected = (code, signal) =>
      this.onDisconnected(code, signal);
  }
}
