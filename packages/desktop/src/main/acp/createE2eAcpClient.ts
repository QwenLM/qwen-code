/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type {
  AuthenticateResponse,
  ListSessionsResponse,
  LoadSessionResponse,
  NewSessionResponse,
  PromptResponse,
  RequestPermissionRequest,
  RequestPermissionResponse,
  SessionNotification,
  SetSessionModeResponse,
  SetSessionModelResponse,
} from '@agentclientprotocol/sdk';
import type {
  AcpSessionClient,
  DesktopApprovalMode,
} from '../../server/services/sessionService.js';

const E2E_MODEL_ID = 'e2e/qwen-code';
const E2E_MODES = [
  {
    id: 'default' as const,
    name: 'Default',
    description: 'Ask before running commands.',
  },
  {
    id: 'auto-edit' as const,
    name: 'Auto Edit',
    description: 'Allow edits while keeping command approvals visible.',
  },
];

interface E2eSessionRecord {
  sessionId: string;
  cwd: string;
  title: string;
  updatedAt: string;
}

export class E2eAcpClient implements AcpSessionClient {
  readonly isConnected = true;
  private readonly sessions: E2eSessionRecord[] = [];
  private nextSessionId = 1;
  private currentMode: DesktopApprovalMode = 'default';
  private currentModelId = E2E_MODEL_ID;

  onSessionUpdate: (notification: SessionNotification) => void = () => {};
  onPermissionRequest: (
    request: RequestPermissionRequest,
  ) => Promise<RequestPermissionResponse> = async () => ({
    outcome: { outcome: 'cancelled' },
  });

  async connect(): Promise<void> {}

  disconnect(): void {}

  async listSessions(
    options: {
      cwd?: string;
    } = {},
  ): Promise<ListSessionsResponse> {
    return {
      sessions: this.sessions
        .filter((session) => !options.cwd || session.cwd === options.cwd)
        .map((session) => ({
          sessionId: session.sessionId,
          cwd: session.cwd,
          title: session.title,
          updatedAt: session.updatedAt,
        })),
    };
  }

  async newSession(cwd: string): Promise<NewSessionResponse> {
    const session: E2eSessionRecord = {
      sessionId: `session-e2e-${this.nextSessionId}`,
      cwd,
      title: 'E2E desktop task',
      updatedAt: new Date().toISOString(),
    };
    this.nextSessionId += 1;
    this.sessions.unshift(session);

    return {
      sessionId: session.sessionId,
      models: this.getModels(),
      modes: this.getModes(),
    };
  }

  async loadSession(
    sessionId: string,
    cwd: string,
  ): Promise<LoadSessionResponse> {
    if (!this.sessions.some((session) => session.sessionId === sessionId)) {
      this.sessions.unshift({
        sessionId,
        cwd,
        title: 'Loaded E2E desktop task',
        updatedAt: new Date().toISOString(),
      });
    }

    return {
      models: this.getModels(),
      modes: this.getModes(),
    };
  }

  async prompt(sessionId: string, prompt: string): Promise<PromptResponse> {
    this.emit(sessionId, {
      sessionUpdate: 'plan',
      entries: [
        {
          content: 'Inspect the opened project',
          priority: 'high',
          status: 'completed',
        },
        {
          content: 'Request command approval',
          priority: 'high',
          status: 'in_progress',
        },
      ],
    });

    const permission = await this.onPermissionRequest({
      sessionId,
      toolCall: {
        toolCallId: 'e2e-terminal-check',
        kind: 'execute',
        title: 'Run desktop E2E command',
        status: 'pending',
        rawInput: 'printf desktop-e2e',
      },
      options: [
        {
          optionId: 'approve_once',
          name: 'Approve Once',
          kind: 'allow_once',
        },
        {
          optionId: 'approve_for_thread',
          name: 'Approve for Thread',
          kind: 'allow_always',
        },
        {
          optionId: 'deny',
          name: 'Deny',
          kind: 'reject_once',
        },
      ],
    });

    this.emit(sessionId, {
      sessionUpdate: 'tool_call_update',
      toolCallId: 'e2e-terminal-check',
      kind: 'execute',
      title: 'Run desktop E2E command',
      status:
        permission.outcome.outcome === 'selected' &&
        permission.outcome.optionId !== 'deny'
          ? 'completed'
          : 'failed',
      rawInput: 'printf desktop-e2e',
      rawOutput:
        permission.outcome.outcome === 'selected'
          ? 'desktop-e2e command completed'
          : permission.outcome.outcome,
      locations: [{ path: 'README.md', line: 1 }],
    });
    this.emit(sessionId, {
      sessionUpdate: 'agent_message_chunk',
      content: {
        type: 'text',
        text: `E2E fake ACP response received: ${prompt}\n\nUpdated README.md:1 for review.`,
      },
    });

    return { stopReason: 'end_turn' };
  }

  async cancel(_sessionId: string): Promise<void> {}

  async authenticate(_methodId = 'default'): Promise<AuthenticateResponse> {
    return {};
  }

  async setMode(
    _sessionId: string,
    modeId: string,
  ): Promise<SetSessionModeResponse | void> {
    if (modeId === 'default' || modeId === 'auto-edit') {
      this.currentMode = modeId;
    }
  }

  async setModel(
    _sessionId: string,
    modelId: string,
  ): Promise<SetSessionModelResponse | void> {
    this.currentModelId = modelId;
  }

  async extMethod<T extends Record<string, unknown>>(
    method: string,
    params: Record<string, unknown>,
  ): Promise<T> {
    if (method === 'getAccountInfo') {
      return {
        authType: 'e2e',
        model: this.currentModelId,
        baseUrl: 'http://127.0.0.1/e2e',
        apiKeyEnvKey: null,
      } as unknown as T;
    }

    if (method === 'renameSession') {
      const session = this.sessions.find(
        (entry) => entry.sessionId === params['sessionId'],
      );
      if (session && typeof params['title'] === 'string') {
        session.title = params['title'];
      }
      return {} as T;
    }

    if (method === 'deleteSession') {
      const sessionIndex = this.sessions.findIndex(
        (entry) => entry.sessionId === params['sessionId'],
      );
      if (sessionIndex >= 0) {
        this.sessions.splice(sessionIndex, 1);
      }
      return {} as T;
    }

    return {} as T;
  }

  private getModels(): NonNullable<NewSessionResponse['models']> {
    return {
      currentModelId: this.currentModelId,
      availableModels: [
        {
          modelId: E2E_MODEL_ID,
          name: 'Qwen Code E2E',
        },
      ],
    };
  }

  private getModes(): NonNullable<NewSessionResponse['modes']> {
    return {
      currentModeId: this.currentMode,
      availableModes: E2E_MODES,
    };
  }

  private emit(sessionId: string, update: SessionNotification['update']): void {
    this.onSessionUpdate({ sessionId, update });
  }
}

export function createE2eAcpClient(): E2eAcpClient {
  return new E2eAcpClient();
}
