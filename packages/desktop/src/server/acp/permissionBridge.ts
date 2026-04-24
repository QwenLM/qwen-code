/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { randomUUID } from 'node:crypto';
import type {
  PermissionOption,
  RequestPermissionRequest,
  RequestPermissionResponse,
} from '@agentclientprotocol/sdk';
import type {
  DesktopAskUserQuestion,
  DesktopAskUserQuestionRequest,
  DesktopClientMessage,
  DesktopPermissionRequest,
  DesktopServerMessage,
  DesktopToolCallUpdate,
} from '../../shared/desktopProtocol.js';

const DEFAULT_PERMISSION_TIMEOUT_MS = 120_000;

type PendingKind = 'permission' | 'ask_user_question';

interface PendingRequest {
  kind: PendingKind;
  sessionId: string;
  timeout: NodeJS.Timeout;
  resolve(response: RequestPermissionResponse): void;
}

export interface PermissionBridgeOptions {
  timeoutMs?: number;
  broadcast(sessionId: string, message: DesktopServerMessage): void;
}

export class PermissionBridge {
  private readonly pending = new Map<string, PendingRequest>();
  private readonly timeoutMs: number;

  constructor(private readonly options: PermissionBridgeOptions) {
    this.timeoutMs = options.timeoutMs ?? DEFAULT_PERMISSION_TIMEOUT_MS;
  }

  async requestPermission(
    request: RequestPermissionRequest,
  ): Promise<RequestPermissionResponse> {
    if (isAskUserQuestionRequest(request)) {
      return this.requestAskUserQuestion(request);
    }

    const requestId = randomUUID();
    const response = this.waitForResponse(
      requestId,
      request.sessionId,
      'permission',
    );
    this.options.broadcast(request.sessionId, {
      type: 'permission_request',
      requestId,
      request: normalizePermissionRequest(request),
    });
    return response;
  }

  handleClientMessage(message: DesktopClientMessage): boolean {
    if (message.type === 'permission_response') {
      return this.resolvePending(message.requestId, {
        outcome: toPermissionOutcome(message.optionId),
      });
    }

    if (message.type === 'ask_user_question_response') {
      return this.resolvePending(message.requestId, {
        outcome: toPermissionOutcome(message.optionId),
        answers: message.answers,
      } as RequestPermissionResponse);
    }

    return false;
  }

  cancelSession(sessionId: string): void {
    for (const [requestId, pending] of this.pending) {
      if (pending.sessionId === sessionId) {
        this.resolvePending(requestId, createCancelledResponse());
      }
    }
  }

  close(): void {
    for (const requestId of this.pending.keys()) {
      this.resolvePending(requestId, createCancelledResponse());
    }
  }

  private async requestAskUserQuestion(
    request: RequestPermissionRequest,
  ): Promise<RequestPermissionResponse> {
    const requestId = randomUUID();
    const response = this.waitForResponse(
      requestId,
      request.sessionId,
      'ask_user_question',
    );
    this.options.broadcast(request.sessionId, {
      type: 'ask_user_question',
      requestId,
      request: normalizeAskUserQuestionRequest(request),
    });
    return response;
  }

  private waitForResponse(
    requestId: string,
    sessionId: string,
    kind: PendingKind,
  ): Promise<RequestPermissionResponse> {
    return new Promise((resolve) => {
      const timeout = setTimeout(() => {
        this.resolvePending(requestId, createCancelledResponse());
      }, this.timeoutMs);
      this.pending.set(requestId, {
        kind,
        sessionId,
        timeout,
        resolve,
      });
    });
  }

  private resolvePending(
    requestId: string,
    response: RequestPermissionResponse,
  ): boolean {
    const pending = this.pending.get(requestId);
    if (!pending) {
      return false;
    }

    clearTimeout(pending.timeout);
    this.pending.delete(requestId);
    pending.resolve(response);
    return true;
  }
}

function normalizePermissionRequest(
  request: RequestPermissionRequest,
): DesktopPermissionRequest {
  return {
    sessionId: request.sessionId,
    options: request.options.map(normalizePermissionOption),
    toolCall: normalizePermissionToolCall(request.toolCall),
  };
}

function normalizePermissionOption(option: PermissionOption) {
  return {
    optionId: option.optionId,
    name: option.name,
    kind: option.kind,
  };
}

function normalizePermissionToolCall(
  toolCall: RequestPermissionRequest['toolCall'],
): DesktopToolCallUpdate {
  return {
    toolCallId: toolCall.toolCallId,
    kind: toolCall.kind ?? undefined,
    title: toolCall.title ?? undefined,
    status: toolCall.status ?? undefined,
    rawInput: toolCall.rawInput,
    rawOutput: toolCall.rawOutput,
    content: toolCall.content ?? undefined,
    locations: toolCall.locations ?? undefined,
  };
}

function normalizeAskUserQuestionRequest(
  request: RequestPermissionRequest,
): DesktopAskUserQuestionRequest {
  const rawInput = getRecord(request.toolCall.rawInput);
  return {
    sessionId: request.sessionId,
    questions: getQuestions(rawInput?.['questions']),
    metadata: getRecord(rawInput?.['metadata']),
  };
}

function isAskUserQuestionRequest(request: RequestPermissionRequest): boolean {
  const rawInput = getRecord(request.toolCall.rawInput);
  return Array.isArray(rawInput?.['questions']);
}

function getQuestions(value: unknown): DesktopAskUserQuestion[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return value.map((question) => {
    const record = getRecord(question);
    return {
      question: getString(record?.['question']),
      header: getString(record?.['header']),
      options: getQuestionOptions(record?.['options']),
      multiSelect: record?.['multiSelect'] === true,
    };
  });
}

function getQuestionOptions(value: unknown) {
  if (!Array.isArray(value)) {
    return [];
  }

  return value.map((option) => {
    const record = getRecord(option);
    return {
      label: getString(record?.['label']),
      description: getString(record?.['description']),
    };
  });
}

function toPermissionOutcome(
  optionId: string,
): RequestPermissionResponse['outcome'] {
  if (optionId === 'cancel' || optionId.includes('reject')) {
    return { outcome: 'cancelled' };
  }

  return {
    outcome: 'selected',
    optionId,
  };
}

function createCancelledResponse(): RequestPermissionResponse {
  return { outcome: { outcome: 'cancelled' } };
}

function getRecord(value: unknown): Record<string, unknown> | undefined {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return undefined;
  }

  return value as Record<string, unknown>;
}

function getString(value: unknown): string {
  return typeof value === 'string' ? value : '';
}
