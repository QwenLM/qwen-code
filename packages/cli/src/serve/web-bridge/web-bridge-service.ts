/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { WebBridgeRegistry } from './web-bridge-registry.js';

export const WEB_BRIDGE_ACTIONS = [
  'navigate',
  'find_tab',
  'evaluate',
  'network',
  'snapshot',
  'click',
  'fill',
  'mouse_click',
  'cdp',
  'key_type',
  'send_keys',
  'screenshot',
  'save_as_pdf',
  'upload',
  'close_tab',
  'list_tabs',
  'close_session',
] as const;

export type WebBridgeAction = (typeof WEB_BRIDGE_ACTIONS)[number];

interface SessionState {
  currentTabId?: number;
  readonly ownedTabIds: Set<number>;
  borrowedTabId?: number;
}

interface ParsedCommand {
  action: WebBridgeAction;
  args: Record<string, unknown>;
  session: string;
}

export class WebBridgeRequestError extends Error {
  constructor(
    message: string,
    readonly statusCode = 400,
  ) {
    super(message);
    this.name = 'WebBridgeRequestError';
  }
}

const MAX_SCREENSHOT_BYTES = 64 * 1024 * 1024;
const MAX_PDF_BYTES = 100 * 1024 * 1024;
const MAX_PENDING_COMMANDS = 32;
const MAX_QUEUE_WAIT_MS = 60_000;
const STALE_TAB_ERROR = /no tab|tab not found|invalid tab id/i;

export class WebBridgeService {
  private readonly sessions = new Map<string, SessionState>();
  private operationTail: Promise<void> = Promise.resolve();
  private pendingCommands = 0;
  private readonly startedAt = Date.now();

  constructor(
    private readonly registry: WebBridgeRegistry,
    private readonly daemonVersion: string,
  ) {}

  execute(body: unknown): Promise<unknown> {
    let command: ParsedCommand;
    try {
      command = parseCommand(body);
    } catch (error) {
      return Promise.reject(error);
    }
    if (this.pendingCommands >= MAX_PENDING_COMMANDS) {
      return Promise.reject(
        new WebBridgeRequestError('Qwen WebBridge command queue is full', 503),
      );
    }
    this.pendingCommands++;
    const queuedAt = Date.now();
    const previous = this.operationTail;
    let release!: () => void;
    this.operationTail = new Promise<void>((resolve) => {
      release = resolve;
    });
    return previous
      .then(() => {
        if (Date.now() - queuedAt >= MAX_QUEUE_WAIT_MS) {
          throw new WebBridgeRequestError(
            'Qwen WebBridge command expired while queued',
            503,
          );
        }
        return this.executeNow(command);
      })
      .finally(() => {
        this.pendingCommands--;
        release();
      });
  }

  status(): {
    running: true;
    version: string;
    extension_connected: boolean;
    extension_id: string;
    extension_version: string;
    uptime_seconds: number;
  } {
    const extension = this.registry.status();
    return {
      running: true,
      version: this.daemonVersion,
      extension_connected: extension.extensionConnected,
      extension_id: extension.extensionId ?? '',
      extension_version: extension.version ?? '',
      uptime_seconds: Math.floor((Date.now() - this.startedAt) / 1000),
    };
  }

  sessionSnapshot(session: string): {
    currentTabId?: number;
    ownedTabIds: number[];
    borrowedTabId?: number;
  } | null {
    const state = this.sessions.get(session);
    if (!state) return null;
    return {
      currentTabId: state.currentTabId,
      ownedTabIds: [...state.ownedTabIds],
      borrowedTabId: state.borrowedTabId,
    };
  }

  private async executeNow(command: ParsedCommand): Promise<unknown> {
    const state = this.sessions.get(command.session) ?? {
      ownedTabIds: new Set<number>(),
    };
    const injectedArgs = this.injectSessionArgs(command, state);
    let result: unknown;
    try {
      result = await this.registry.call(command.action, injectedArgs);
    } catch (error) {
      if (
        command.action === 'navigate' &&
        state.currentTabId !== undefined &&
        error instanceof Error &&
        STALE_TAB_ERROR.test(error.message)
      ) {
        state.ownedTabIds.delete(state.currentTabId);
        state.currentTabId = undefined;
        state.borrowedTabId = undefined;
        result = await this.registry.call(command.action, {
          ...command.args,
          newTab: true,
          _session: command.session,
          _tabId: undefined,
          _tabIds: [...state.ownedTabIds],
        });
      } else {
        throw error;
      }
    }
    this.captureSessionResult(command, state, result);
    if (
      command.action !== 'close_session' &&
      (state.currentTabId !== undefined || state.ownedTabIds.size > 0)
    ) {
      this.sessions.set(command.session, state);
    } else {
      this.sessions.delete(command.session);
    }
    if (command.action === 'screenshot' || command.action === 'save_as_pdf') {
      return this.persistArtifact(command.action, command.args, result);
    }
    return result;
  }

  private injectSessionArgs(
    command: ParsedCommand,
    state: SessionState,
  ): Record<string, unknown> {
    return {
      ...command.args,
      _session: command.session,
      _tabId: state.currentTabId,
      _tabIds: [...state.ownedTabIds],
    };
  }

  private captureSessionResult(
    command: ParsedCommand,
    state: SessionState,
    result: unknown,
  ): void {
    const data = isRecord(result) ? result : {};
    if (command.action === 'navigate') {
      const tabId = integer(data['tabId']);
      if (tabId !== undefined) {
        const remainsBorrowed =
          state.borrowedTabId === tabId && command.args['newTab'] !== true;
        if (!remainsBorrowed) state.ownedTabIds.add(tabId);
        state.currentTabId = tabId;
        state.borrowedTabId = remainsBorrowed ? tabId : undefined;
      }
      return;
    }
    if (command.action === 'find_tab') {
      const tabId = integer(data['tabId']);
      if (tabId === undefined) return;
      state.currentTabId = tabId;
      if (data['borrowed'] === true) {
        state.borrowedTabId = tabId;
      } else {
        state.borrowedTabId = undefined;
        state.ownedTabIds.add(tabId);
      }
      return;
    }
    if (command.action === 'close_tab' && data['closed'] === true) {
      const closed = state.currentTabId;
      if (closed !== undefined) state.ownedTabIds.delete(closed);
      if (state.borrowedTabId === closed) state.borrowedTabId = undefined;
      state.currentTabId = [...state.ownedTabIds].at(-1);
      return;
    }
    if (command.action === 'list_tabs' && Array.isArray(data['tabs'])) {
      const existing = new Set(
        data['tabs']
          .map((tab) => (isRecord(tab) ? integer(tab['tabId']) : undefined))
          .filter((tabId): tabId is number => tabId !== undefined),
      );
      for (const tabId of state.ownedTabIds) {
        if (!existing.has(tabId)) state.ownedTabIds.delete(tabId);
      }
      if (
        state.currentTabId !== state.borrowedTabId &&
        state.currentTabId !== undefined &&
        !existing.has(state.currentTabId)
      ) {
        state.currentTabId = [...state.ownedTabIds].at(-1);
      }
      return;
    }
    if (command.action === 'close_session') {
      this.sessions.delete(command.session);
    }
  }

  private async persistArtifact(
    action: 'screenshot' | 'save_as_pdf',
    args: Record<string, unknown>,
    result: unknown,
  ): Promise<Record<string, unknown>> {
    if (!isRecord(result) || typeof result['data'] !== 'string') {
      throw new Error(`${action}: extension returned no artifact data`);
    }
    const data = Buffer.from(result['data'], 'base64');
    const maxBytes =
      action === 'save_as_pdf' ? MAX_PDF_BYTES : MAX_SCREENSHOT_BYTES;
    if (data.byteLength > maxBytes) {
      throw new Error(
        `${action}: decoded artifact exceeds ${Math.floor(maxBytes / 1024 / 1024)} MB`,
      );
    }
    const extension =
      action === 'save_as_pdf'
        ? 'pdf'
        : result['format'] === 'jpeg'
          ? 'jpg'
          : 'png';
    const requestedPath =
      typeof args['path'] === 'string' && args['path'].length > 0
        ? path.resolve(args['path'])
        : undefined;
    const filePath =
      requestedPath ??
      path.join(
        tmpdir(),
        'qwen-webbridge',
        `${artifactName(result['pageTitle'])}-${Date.now()}.${extension}`,
      );
    await mkdir(path.dirname(filePath), { recursive: true });
    await writeFile(filePath, data);
    const { data: _data, dataLength: _dataLength, ...metadata } = result;
    return {
      ...metadata,
      path: filePath,
      sizeBytes: data.byteLength,
      mimeType:
        action === 'save_as_pdf'
          ? 'application/pdf'
          : extension === 'jpg'
            ? 'image/jpeg'
            : 'image/png',
    };
  }
}

function parseCommand(body: unknown): ParsedCommand {
  if (!isRecord(body)) {
    throw new WebBridgeRequestError('Request body must be a JSON object');
  }
  const action = body['action'];
  if (
    typeof action !== 'string' ||
    !WEB_BRIDGE_ACTIONS.includes(action as WebBridgeAction)
  ) {
    throw new WebBridgeRequestError(
      `Unknown WebBridge action: ${String(action)}`,
    );
  }
  const args = body['args'] ?? {};
  if (!isRecord(args)) {
    throw new WebBridgeRequestError("'args' must be a JSON object");
  }
  const session = body['session'];
  if (typeof session !== 'string' || session.trim().length === 0) {
    throw new WebBridgeRequestError("'session' must be a non-empty string");
  }
  if (session.length > 128) {
    throw new WebBridgeRequestError("'session' cannot exceed 128 characters");
  }
  return {
    action: action as WebBridgeAction,
    args,
    session,
  };
}

function artifactName(value: unknown): string {
  const title = typeof value === 'string' ? value.trim() : '';
  const sanitized = title
    .replace(/[^a-z0-9._-]+/gi, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 80);
  return sanitized || 'artifact';
}

function integer(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isInteger(value)
    ? value
    : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
