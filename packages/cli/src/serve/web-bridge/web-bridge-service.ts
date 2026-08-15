/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { mkdtemp, readdir, rm, stat, writeFile } from 'node:fs/promises';
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

const MAX_SCREENSHOT_BYTES = 16 * 1024 * 1024;
const MAX_PDF_BYTES = 24 * 1024 * 1024;
const MAX_COMMAND_BYTES = 256 * 1024;
const MAX_ARTIFACT_DIRS = 128;
const MAX_PENDING_COMMANDS = 32;
const MAX_SESSIONS = 64;
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

  async execute(body: unknown): Promise<unknown> {
    const command = parseCommand(body);
    if (this.pendingCommands >= MAX_PENDING_COMMANDS) {
      throw new WebBridgeRequestError(
        'Qwen WebBridge command queue is full',
        503,
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

  private async executeNow(command: ParsedCommand): Promise<unknown> {
    const existing = this.sessions.get(command.session);
    if (
      !existing &&
      this.sessions.size >= MAX_SESSIONS &&
      (command.action === 'navigate' || command.action === 'find_tab')
    ) {
      throw new WebBridgeRequestError(
        'Qwen WebBridge session limit reached',
        503,
      );
    }
    const state = existing ?? {
      ownedTabIds: new Set<number>(),
    };
    if (
      command.action === 'close_tab' &&
      state.currentTabId !== undefined
    ) {
      if (state.currentTabId === state.borrowedTabId) {
        throw new WebBridgeRequestError('Cannot close a borrowed tab', 409);
      }
      if (
        this.tabUsedByOtherSessions(state.currentTabId, command.session)
      ) {
        throw new WebBridgeRequestError(
          'Cannot close a tab used by another session',
          409,
        );
      }
    }
    if (command.action === 'close_session') {
      // A tab another session only borrows is excluded from this close set;
      // once this (owning) session is deleted nobody could ever close it.
      // Hand ownership to the borrower so the tab stays closable.
      for (const tabId of state.ownedTabIds) {
        for (const [otherSession, otherState] of this.sessions) {
          if (otherSession === command.session) continue;
          if (otherState.borrowedTabId === tabId) {
            otherState.ownedTabIds.add(tabId);
            otherState.borrowedTabId = undefined;
          }
        }
      }
    }
    const injectedArgs = this.injectSessionArgs(command, state);
    if (command.action === 'close_session') {
      // The extension-side cross-session guard lives in module state that
      // does not survive an MV3 service-worker restart, so the long-lived
      // daemon is the durable enforcement point: never hand another
      // session's owned or borrowed tab to the close set.
      injectedArgs['_tabIds'] = [...state.ownedTabIds].filter(
        (tabId) => !this.tabUsedByOtherSessions(tabId, command.session),
      );
    }
    let result: unknown;
    try {
      result = await this.registry.call(command.action, injectedArgs);
    } catch (error) {
      if (
        command.action === 'navigate' &&
        command.args['newTab'] !== true &&
        state.currentTabId !== undefined &&
        error instanceof Error &&
        STALE_TAB_ERROR.test(error.message)
      ) {
        const staleTabId = state.currentTabId;
        result = await this.registry.call(command.action, {
          ...command.args,
          newTab: true,
          _session: command.session,
          _tabId: undefined,
          _tabIds: [...state.ownedTabIds].filter((id) => id !== staleTabId),
        });
        // Drop the stale tab only after the recovery succeeded: mutating
        // first would leave an emptied session entry behind when the retry
        // itself throws, leaking it against MAX_SESSIONS until restart.
        if (staleTabId !== undefined) state.ownedTabIds.delete(staleTabId);
        state.currentTabId = undefined;
        state.borrowedTabId = undefined;
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
      return this.persistArtifact(command.action, result);
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

  private tabUsedByOtherSessions(
    tabId: number,
    excludedSession: string,
  ): boolean {
    for (const [session, state] of this.sessions) {
      if (session === excludedSession) continue;
      if (state.ownedTabIds.has(tabId) || state.borrowedTabId === tabId) {
        return true;
      }
    }
    return false;
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
      if (data['borrowed'] === true && !state.ownedTabIds.has(tabId)) {
        state.borrowedTabId = tabId;
      } else {
        // A tab this session created stays owned even when re-found via
        // find_tab(active:true): demoting it to borrowed would remove it
        // from the close set forever (close_tab rejects borrowed tabs and
        // close_session filters them out).
        state.borrowedTabId = undefined;
        state.ownedTabIds.add(tabId);
      }
      return;
    }
    if (command.action === 'close_tab' && data['success'] === true) {
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
    await pruneArtifactDirectories();
    const directory = await mkdtemp(path.join(tmpdir(), 'qwen-webbridge-'));
    const filePath = path.join(
      directory,
      `${artifactName(result['pageTitle'])}-${Date.now()}.${extension}`,
    );
    await writeFile(filePath, data, { flag: 'wx', mode: 0o600 });
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

/**
 * Artifacts persist under a fresh tmpdir per screenshot/PDF and callers may
 * read them for a while, so prune by count (oldest first) instead of age.
 */
async function pruneArtifactDirectories(): Promise<void> {
  try {
    const root = tmpdir();
    const entries = await readdir(root);
    const directories: Array<{ name: string; mtimeMs: number }> = [];
    for (const name of entries) {
      if (!name.startsWith('qwen-webbridge-')) continue;
      try {
        const info = await stat(path.join(root, name));
        if (info.isDirectory()) {
          directories.push({ name, mtimeMs: info.mtimeMs });
        }
      } catch {
        // Already gone.
      }
    }
    if (directories.length < MAX_ARTIFACT_DIRS) return;
    directories.sort((a, b) => a.mtimeMs - b.mtimeMs);
    for (const entry of directories.slice(0, directories.length - MAX_ARTIFACT_DIRS + 1)) {
      await rm(path.join(root, entry.name), { recursive: true, force: true });
    }
  } catch {
    // Pruning is best-effort; never fail the artifact write.
  }
}

function parseCommand(body: unknown): ParsedCommand {
  if (!isRecord(body)) {
    throw new WebBridgeRequestError('Request body must be a JSON object');
  }
  if (Buffer.byteLength(JSON.stringify(body), 'utf8') > MAX_COMMAND_BYTES) {
    throw new WebBridgeRequestError('Request body is too large', 413);
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
