/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type {
  AuthenticateResponse,
  ListSessionsResponse,
  LoadSessionResponse,
  ModelInfo,
  NewSessionResponse,
  PromptResponse,
  RequestPermissionRequest,
  RequestPermissionResponse,
  SessionNotification,
  SetSessionModeResponse,
  SetSessionModelResponse,
} from '@agentclientprotocol/sdk';
import { DesktopHttpError } from '../http/errors.js';

export type DesktopApprovalMode = 'plan' | 'default' | 'auto-edit' | 'yolo';

export interface DesktopSessionModelState {
  currentModelId: string;
  availableModels: ModelInfo[];
}

export interface DesktopSessionModeState {
  currentModeId: DesktopApprovalMode;
  availableModes: Array<{
    id: DesktopApprovalMode;
    name: string;
    description: string;
  }>;
}

export interface DesktopSessionRuntimeState {
  models: DesktopSessionModelState | null;
  modes: DesktopSessionModeState | null;
}

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
  authenticate?(methodId?: string): Promise<AuthenticateResponse>;
  setMode?(
    sessionId: string,
    modeId: string,
  ): Promise<SetSessionModeResponse | void>;
  setModel?(
    sessionId: string,
    modelId: string,
  ): Promise<SetSessionModelResponse | void>;
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
  private readonly runtimeStates = new Map<
    string,
    DesktopSessionRuntimeState
  >();

  constructor(private readonly acpClient?: AcpSessionClient) {}

  async listSessions(
    options: SessionListOptions,
  ): Promise<ListSessionsResponse> {
    return this.getClient().then((client) => client.listSessions(options));
  }

  async createSession(cwd: string): Promise<NewSessionResponse> {
    const session = await this.getClient().then((client) =>
      client.newSession(cwd),
    );
    this.captureRuntimeState(session.sessionId, session);
    return session;
  }

  async loadSession(
    sessionId: string,
    cwd: string,
  ): Promise<LoadSessionResponse> {
    const session = await this.getClient().then((client) =>
      client.loadSession(sessionId, cwd),
    );
    this.captureRuntimeState(sessionId, session);
    return session;
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

  getModelState(sessionId: string): DesktopSessionModelState {
    const state = this.runtimeStates.get(sessionId)?.models;
    if (!state) {
      throw new DesktopHttpError(
        404,
        'session_model_state_unavailable',
        'Session model state is not available. Create or load the session first.',
      );
    }

    return state;
  }

  getModeState(sessionId: string): DesktopSessionModeState {
    const state = this.runtimeStates.get(sessionId)?.modes;
    if (!state) {
      throw new DesktopHttpError(
        404,
        'session_mode_state_unavailable',
        'Session mode state is not available. Create or load the session first.',
      );
    }

    return state;
  }

  async setSessionModel(
    sessionId: string,
    modelId: string,
  ): Promise<DesktopSessionModelState> {
    const client = await this.getClient();
    if (!client.setModel) {
      throw new DesktopHttpError(
        501,
        'acp_set_model_unavailable',
        'ACP client does not support setting a session model.',
      );
    }

    await client.setModel(sessionId, modelId);
    const existing = this.runtimeStates.get(sessionId);
    const models = existing?.models;
    const availableModels = models?.availableModels.some(
      (model) => model.modelId === modelId,
    )
      ? models.availableModels
      : [...(models?.availableModels ?? []), { modelId, name: modelId }];
    const nextModels: DesktopSessionModelState = models
      ? { ...models, currentModelId: modelId, availableModels }
      : {
          currentModelId: modelId,
          availableModels,
        };
    this.runtimeStates.set(sessionId, {
      models: nextModels,
      modes: existing?.modes ?? null,
    });
    return nextModels;
  }

  async setSessionMode(
    sessionId: string,
    modeId: DesktopApprovalMode,
  ): Promise<DesktopSessionModeState> {
    const client = await this.getClient();
    if (!client.setMode) {
      throw new DesktopHttpError(
        501,
        'acp_set_mode_unavailable',
        'ACP client does not support setting a session mode.',
      );
    }

    await client.setMode(sessionId, modeId);
    const existing = this.runtimeStates.get(sessionId);
    const modes = existing?.modes;
    const nextModes: DesktopSessionModeState = modes
      ? { ...modes, currentModeId: modeId }
      : {
          currentModeId: modeId,
          availableModes: DEFAULT_DESKTOP_MODES,
        };
    this.runtimeStates.set(sessionId, {
      models: existing?.models ?? null,
      modes: nextModes,
    });
    return nextModes;
  }

  async authenticate(methodId: string): Promise<AuthenticateResponse | void> {
    const client = await this.getClient();
    if (!client.authenticate) {
      throw new DesktopHttpError(
        501,
        'acp_auth_unavailable',
        'ACP client does not support authentication.',
      );
    }

    return client.authenticate(methodId);
  }

  async getAccountInfo(
    sessionId?: string,
  ): Promise<Record<string, unknown> | null> {
    if (!this.acpClient || this.acpClient.isConnected !== true) {
      return null;
    }

    try {
      return await this.acpClient.extMethod('getAccountInfo', { sessionId });
    } catch {
      return null;
    }
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

  private captureRuntimeState(sessionId: string, response: unknown): void {
    this.runtimeStates.set(sessionId, {
      models: extractModelState(response),
      modes: extractModeState(response),
    });
  }
}

export const DEFAULT_DESKTOP_MODES: DesktopSessionModeState['availableModes'] =
  [
    {
      id: 'plan',
      name: 'Plan',
      description: 'Review the plan before changes are applied.',
    },
    {
      id: 'default',
      name: 'Default',
      description: 'Ask before edits and tool actions that need approval.',
    },
    {
      id: 'auto-edit',
      name: 'Auto Edit',
      description:
        'Apply file edits automatically while asking for other tools.',
    },
    {
      id: 'yolo',
      name: 'YOLO',
      description: 'Run without approval prompts.',
    },
  ];

export function isDesktopApprovalMode(
  value: unknown,
): value is DesktopApprovalMode {
  return (
    value === 'plan' ||
    value === 'default' ||
    value === 'auto-edit' ||
    value === 'yolo'
  );
}

function extractModelState(response: unknown): DesktopSessionModelState | null {
  const obj = asRecord(response);
  const models = asRecord(obj?.['models']);
  const availableModelsRaw = models?.['availableModels'];
  if (!Array.isArray(availableModelsRaw)) {
    return null;
  }

  const availableModels = availableModelsRaw
    .map(normalizeModelInfo)
    .filter((model): model is ModelInfo => model !== null);
  if (availableModels.length === 0) {
    return null;
  }

  const currentModelId =
    typeof models?.['currentModelId'] === 'string' &&
    models['currentModelId'].length > 0
      ? models['currentModelId']
      : availableModels[0]?.modelId;

  return currentModelId
    ? {
        currentModelId,
        availableModels,
      }
    : null;
}

function extractModeState(response: unknown): DesktopSessionModeState | null {
  const obj = asRecord(response);
  const modes = asRecord(obj?.['modes']);
  const currentModeId = modes?.['currentModeId'];
  if (!isDesktopApprovalMode(currentModeId)) {
    return null;
  }

  const availableModesRaw = modes?.['availableModes'];
  const availableModes = Array.isArray(availableModesRaw)
    ? availableModesRaw
        .map(normalizeModeInfo)
        .filter(
          (mode): mode is DesktopSessionModeState['availableModes'][number] =>
            mode !== null,
        )
    : DEFAULT_DESKTOP_MODES;

  return {
    currentModeId,
    availableModes:
      availableModes.length > 0 ? availableModes : DEFAULT_DESKTOP_MODES,
  };
}

function normalizeModelInfo(value: unknown): ModelInfo | null {
  const obj = asRecord(value);
  const modelId =
    typeof obj?.['modelId'] === 'string' && obj['modelId'].length > 0
      ? obj['modelId']
      : typeof obj?.['name'] === 'string'
        ? obj['name']
        : '';
  const name =
    typeof obj?.['name'] === 'string' && obj['name'].length > 0
      ? obj['name']
      : modelId;

  if (!modelId || !name) {
    return null;
  }

  return {
    modelId,
    name,
    ...(typeof obj?.['description'] === 'string' ||
    obj?.['description'] === null
      ? { description: obj['description'] }
      : {}),
    ...(asRecord(obj?.['_meta']) ? { _meta: asRecord(obj?.['_meta']) } : {}),
  };
}

function normalizeModeInfo(
  value: unknown,
): DesktopSessionModeState['availableModes'][number] | null {
  const obj = asRecord(value);
  const id = obj?.['id'];
  if (!isDesktopApprovalMode(id)) {
    return null;
  }

  return {
    id,
    name: typeof obj?.['name'] === 'string' ? obj['name'] : id,
    description:
      typeof obj?.['description'] === 'string' ? obj['description'] : '',
  };
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return undefined;
  }

  return value as Record<string, unknown>;
}
