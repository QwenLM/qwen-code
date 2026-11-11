/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * pure headless 的最小 stdio 权限通道：只承载 `--permission-prompt-tool stdio`
 * 的 `can_use_tool` 往返。不注册任何 control_request 方法，也不输出会话正文帧。
 */

import { randomUUID } from 'node:crypto';
import { createInterface, type Interface } from 'node:readline';
import type { Readable, Writable } from 'node:stream';
import {
  getAgentContext,
  ndjsonSafeStringify,
  projectConfirmationDetailsForExternalUse,
  runLogger,
  type PermissionSuggestion,
  type PermissionUpdate,
  type SerializableConfirmationDetails,
} from '@qwen-code/core';
import type {
  ThreadCanUseToolDecision,
  ThreadCanUseToolRequest,
  ThreadReverseRequestOptions,
} from '../thread-manager/thread-session/contract/hostContext.js';
import {
  buildControlCancelRequest,
  buildControlRequest,
  isControlCancelRequest,
  parseControlResponse,
} from '../utils/controlProtocol.js';

export interface StdioCanUseToolResult {
  decision: ThreadCanUseToolDecision;
  updatedPermissions?: readonly PermissionUpdate[];
}

const WITHDRAWN_DECISION: ThreadCanUseToolDecision = {
  behavior: 'deny',
  message: '',
  interrupt: false,
};

const MALFORMED_DECISION: ThreadCanUseToolDecision = {
  behavior: 'deny',
  message: 'Malformed permission response',
  interrupt: false,
};

interface PendingPermission {
  resolve(result: StdioCanUseToolResult): void;
  reject(error: unknown): void;
  cleanup(): void;
}

export class StdioPermissionChannel {
  private readonly reader: Interface;
  private readonly pending = new Map<string, PendingPermission>();
  private writeChain: Promise<void> = Promise.resolve();
  private closed = false;

  constructor(
    input: Readable,
    private readonly output: Writable,
    private readonly sessionId: string,
  ) {
    this.reader = createInterface({ input, crlfDelay: Infinity });
    this.reader.on('line', (line) => this.handleLine(line));
  }

  requestCanUseTool(
    request: ThreadCanUseToolRequest,
    options?: ThreadReverseRequestOptions,
  ): Promise<StdioCanUseToolResult> {
    const signal = options?.signal;
    if (this.closed || signal?.aborted) {
      return Promise.resolve({ decision: WITHDRAWN_DECISION });
    }
    const requestId = randomUUID();
    return new Promise<StdioCanUseToolResult>((resolve, reject) => {
      const cleanup = (): void => {
        signal?.removeEventListener('abort', onAbort);
      };
      const onAbort = (): void => {
        if (!this.withdraw(requestId, true)) {
          cleanup();
          resolve({ decision: WITHDRAWN_DECISION });
        }
      };
      signal?.addEventListener('abort', onAbort, { once: true });
      this.pending.set(requestId, {
        resolve: (result) => {
          cleanup();
          resolve(result);
        },
        reject: (error) => {
          cleanup();
          reject(error);
        },
        cleanup,
      });
      void this.writeFrame(
        this.envelope(
          buildControlRequest(requestId, encodeCanUseToolRequest(request)),
        ),
      );
    });
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.reader.close();
    for (const pending of this.pending.values()) {
      pending.cleanup();
      pending.resolve({ decision: WITHDRAWN_DECISION });
    }
    this.pending.clear();
  }

  private handleLine(line: string): void {
    const trimmed = line.trim();
    if (!trimmed) return;
    let value: unknown;
    try {
      value = JSON.parse(trimmed);
    } catch {
      runLogger.warn('[headless] dropped malformed permission frame');
      return;
    }
    const response = parseControlResponse(value);
    if (response) {
      this.settle(response);
      return;
    }
    if (isControlCancelRequest(value)) {
      this.withdraw(value.request_id, false);
      return;
    }
    runLogger.warn('[headless] dropped non-permission control frame', {
      frameType:
        typeof value === 'object' && value !== null
          ? (value as { type?: unknown }).type
          : undefined,
    });
  }

  private withdraw(requestId: string, emitCancel: boolean): boolean {
    const pending = this.pending.get(requestId);
    if (!pending) return false;
    this.pending.delete(requestId);
    pending.cleanup();
    if (emitCancel) {
      void this.writeFrame(
        this.envelope(buildControlCancelRequest(requestId)),
      );
    }
    pending.resolve({ decision: WITHDRAWN_DECISION });
    return true;
  }

  private settle(
    response: NonNullable<ReturnType<typeof parseControlResponse>>,
  ): void {
    const pending = this.pending.get(response.requestId);
    if (!pending) {
      runLogger.warn('[headless] unmatched permission response', {
        requestId: response.requestId,
      });
      return;
    }
    this.pending.delete(response.requestId);
    if (response.subtype === 'error') {
      pending.reject(new Error(response.error ?? 'permission request failed'));
      return;
    }
    pending.resolve(decodeCanUseToolResponse(response.response));
  }

  private envelope<T extends object>(frame: T): Record<string, unknown> {
    return {
      ...frame,
      ...(this.sessionId ? { session_id: this.sessionId } : {}),
    };
  }

  private writeFrame(frame: Record<string, unknown>): Promise<void> {
    const line = ndjsonSafeStringify(frame) + '\n';
    this.writeChain = this.writeChain.then(
      () =>
        new Promise<void>((resolve) => {
          this.output.write(line, () => resolve());
        }),
    );
    return this.writeChain;
  }
}

function encodeCanUseToolRequest(
  request: ThreadCanUseToolRequest,
): Record<string, unknown> {
  const wire: Record<string, unknown> = {
    subtype: 'can_use_tool',
    tool_name: request.toolName,
    input: request.input,
    tool_use_id: request.toolUseId,
    display_name: request.displayName,
  };
  if (request.details !== undefined) {
    wire['details'] = projectConfirmationDetailsForExternalUse(
      request.details as SerializableConfirmationDetails | undefined,
    );
  }
  if (request.permissionKind !== undefined) {
    wire['permission_kind'] = request.permissionKind;
  }
  if (request.options !== undefined) {
    wire['options'] = request.options;
  }
  if (request.description !== undefined) {
    wire['description'] = request.description;
  }
  if (request.title) {
    wire['title'] = request.title;
  }
  if (request.suggestions.length > 0) {
    wire['permission_suggestions'] = permissionUpdatesToSuggestions(
      request.suggestions as PermissionUpdate[],
    );
  }
  if (request.blockedPath) {
    wire['blocked_path'] = request.blockedPath;
  }
  const agentId = getAgentContext()?.agentId;
  if (agentId) {
    wire['agent_id'] = agentId;
  }
  return wire;
}

function decodeCanUseToolResponse(
  response: Record<string, unknown> | undefined,
): StdioCanUseToolResult {
  if (!isRecord(response)) {
    return { decision: MALFORMED_DECISION };
  }
  if (response['behavior'] === 'deny') {
    return {
      decision: {
        behavior: 'deny',
        message: asString(response['message']),
        interrupt: response['interrupt'] === true,
      },
    };
  }
  if (response['behavior'] !== 'allow') {
    return { decision: MALFORMED_DECISION };
  }
  const updatedInput = isRecord(response['updatedInput'])
    ? response['updatedInput']
    : undefined;
  const updatedPermissions = Array.isArray(response['updatedPermissions'])
    ? (response['updatedPermissions'] as PermissionUpdate[])
    : undefined;
  const permissionScope = toPermissionScope(response['permissionScope']);
  return {
    decision: {
      behavior: 'allow',
      updatedInput,
      ...(permissionScope ? { permissionScope } : {}),
    },
    ...(updatedPermissions ? { updatedPermissions } : {}),
  };
}

function toPermissionScope(
  value: unknown,
): 'once' | 'session' | 'persist' | undefined {
  return value === 'once' || value === 'session' || value === 'persist'
    ? value
    : undefined;
}

function permissionUpdatesToSuggestions(
  updates: PermissionUpdate[] | undefined,
): PermissionSuggestion[] | undefined {
  if (!updates || updates.length === 0) {
    return undefined;
  }
  return updates.map((update): PermissionSuggestion => {
    const suggestion: PermissionSuggestion = { type: update.type };
    if (
      update.type === 'addRules' ||
      update.type === 'replaceRules' ||
      update.type === 'removeRules'
    ) {
      suggestion.rules = update.rules.map((rule) => ({
        toolName: rule.toolName,
        ruleContent: rule.ruleContent ?? '',
      }));
      suggestion.behavior = update.behavior;
      suggestion.destination = update.destination as
        | 'session'
        | 'localSettings'
        | 'projectSettings'
        | 'userSettings';
    }
    if (update.type === 'setMode') {
      suggestion.mode = update.mode;
      suggestion.destination = update.destination as
        | 'session'
        | 'localSettings'
        | 'projectSettings'
        | 'userSettings';
    }
    if (
      update.type === 'addDirectories' ||
      update.type === 'removeDirectories'
    ) {
      suggestion.directories = update.directories;
      suggestion.destination = update.destination as
        | 'session'
        | 'localSettings'
        | 'projectSettings'
        | 'userSettings';
    }
    return suggestion;
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function asString(value: unknown): string {
  return typeof value === 'string' ? value : '';
}
