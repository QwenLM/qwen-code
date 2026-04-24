/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type {
  ListSessionsResponse,
  LoadSessionResponse,
  NewSessionResponse,
  PromptResponse,
  RequestPermissionRequest,
  RequestPermissionResponse,
  SessionNotification,
} from '@agentclientprotocol/sdk';
import { DesktopHttpError } from '../http/errors.js';

export interface AcpSessionClient {
  readonly isConnected?: boolean;
  onSessionUpdate?: (notification: SessionNotification) => void;
  onPermissionRequest?: (
    request: RequestPermissionRequest,
  ) => Promise<RequestPermissionResponse>;
  connect?(): Promise<unknown>;
  listSessions(options?: {
    cwd?: string;
    cursor?: number;
    size?: number;
  }): Promise<ListSessionsResponse>;
  newSession(cwd: string): Promise<NewSessionResponse>;
  loadSession(sessionId: string, cwd: string): Promise<LoadSessionResponse>;
  prompt(sessionId: string, prompt: string): Promise<PromptResponse>;
  cancel(sessionId: string): Promise<void>;
  extMethod<T extends Record<string, unknown>>(
    method: string,
    params: Record<string, unknown>,
  ): Promise<T>;
}

export interface SessionListOptions {
  cwd?: string;
  cursor?: number;
  size?: number;
}

export class DesktopSessionService {
  constructor(private readonly acpClient?: AcpSessionClient) {}

  async listSessions(
    options: SessionListOptions,
  ): Promise<ListSessionsResponse> {
    return this.getClient().then((client) => client.listSessions(options));
  }

  async createSession(cwd: string): Promise<NewSessionResponse> {
    return this.getClient().then((client) => client.newSession(cwd));
  }

  async loadSession(
    sessionId: string,
    cwd: string,
  ): Promise<LoadSessionResponse> {
    return this.getClient().then((client) =>
      client.loadSession(sessionId, cwd),
    );
  }

  async renameSession(
    sessionId: string,
    title: string,
    cwd?: string,
  ): Promise<Record<string, unknown>> {
    return this.getClient().then((client) =>
      client.extMethod('renameSession', { sessionId, title, cwd }),
    );
  }

  async deleteSession(
    sessionId: string,
    cwd?: string,
  ): Promise<Record<string, unknown>> {
    return this.getClient().then((client) =>
      client.extMethod('deleteSession', { sessionId, cwd }),
    );
  }

  private async getClient(): Promise<AcpSessionClient> {
    if (!this.acpClient) {
      throw new DesktopHttpError(
        503,
        'acp_unavailable',
        'ACP client is not configured.',
      );
    }

    if (this.acpClient.connect && this.acpClient.isConnected === false) {
      await this.acpClient.connect();
    }

    return this.acpClient;
  }
}
