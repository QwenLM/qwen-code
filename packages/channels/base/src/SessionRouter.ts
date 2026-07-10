import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import process from 'node:process';
import type { SessionScope, SessionTarget } from './types.js';
import type { ChannelAgentBridge } from './ChannelAgentBridge.js';
import { sanitizeLogText } from './sanitize.js';

interface PersistedEntry {
  sessionId: string;
  target: SessionTarget;
  cwd: string;
}

interface SessionReservation {
  promise: Promise<string>;
  resolve: (sessionId: string) => void;
  reject: (error: unknown) => void;
}

interface SessionOperation {
  promise: Promise<string>;
  target: SessionTarget;
  lifecycleGeneration: number;
  routeToken: object;
  invalidationError?: Error;
}

type SessionLoadWindow = Set<string>;
interface ResolveOptions {
  routingThreadId?: string;
}

export type SessionRecoveryMode = 'eager' | 'lazy';

export interface SessionRouterOptions {
  recoveryMode?: SessionRecoveryMode;
}

export class SessionRouter {
  private toSession: Map<string, string> = new Map(); // routing key → session ID
  private toTarget: Map<string, SessionTarget> = new Map(); // session ID → target
  private toCwd: Map<string, string> = new Map(); // session ID → cwd
  private creatingSessions: Map<string, SessionOperation> = new Map();
  private sessionLoadWindows: Set<SessionLoadWindow> = new Set();
  private readonly liveSessionIds = new Set<string>();
  private readonly routeTokens = new Map<string, object>();
  private lifecycleGeneration = 0;

  private bridge: ChannelAgentBridge;
  private defaultCwd: string;
  private defaultScope: SessionScope;
  private channelScopes: Map<string, SessionScope> = new Map();
  private channelApprovalModes: Map<string, string> = new Map();
  private persistPath: string | undefined;
  private readonly recoveryMode: SessionRecoveryMode;

  constructor(
    bridge: ChannelAgentBridge,
    defaultCwd: string,
    scope: SessionScope = 'user',
    persistPath?: string,
    options: SessionRouterOptions = {},
  ) {
    this.bridge = bridge;
    this.defaultCwd = defaultCwd;
    this.defaultScope = scope;
    this.persistPath = persistPath;
    this.recoveryMode = options.recoveryMode ?? 'eager';
  }

  /** Replace the bridge instance (used after crash recovery restart). */
  setBridge(bridge: ChannelAgentBridge): void {
    this.bridge = bridge;
  }

  /** Set scope override for a specific channel. */
  setChannelScope(channelName: string, scope: SessionScope): void {
    this.channelScopes.set(channelName, scope);
  }

  setChannelApprovalMode(
    channelName: string,
    approvalMode: string | undefined,
  ): void {
    if (approvalMode) {
      this.channelApprovalModes.set(channelName, approvalMode);
    } else {
      this.channelApprovalModes.delete(channelName);
    }
  }

  private routingKey(
    channelName: string,
    senderId: string,
    chatId: string,
    threadId?: string,
  ): string {
    const scope = this.channelScopes.get(channelName) || this.defaultScope;
    switch (scope) {
      case 'thread':
        return `${channelName}:${threadId || chatId}`;
      case 'single':
        return `${channelName}:__single__`;
      case 'user':
      default:
        return `${channelName}:${senderId}:${chatId}`;
    }
  }

  private sessionOptions(
    channelName: string,
  ): { approvalMode?: string } | undefined {
    const approvalMode = this.channelApprovalModes.get(channelName);
    return approvalMode ? { approvalMode } : undefined;
  }

  async resolve(
    channelName: string,
    senderId: string,
    chatId: string,
    threadId?: string,
    cwd?: string,
    isGroup?: boolean,
    options?: ResolveOptions,
  ): Promise<string> {
    const key = this.routingKey(
      channelName,
      senderId,
      chatId,
      options?.routingThreadId ?? threadId,
    );
    const input = {
      channelName,
      senderId,
      chatId,
      threadId,
      cwd: cwd || this.defaultCwd,
      isGroup,
    };
    let failedWaits = 0;
    for (;;) {
      const existing = this.toSession.get(key);
      if (existing && this.isLive(existing)) {
        this.promoteTargetToGroup(existing, isGroup);
        return existing;
      }

      const creating = this.creatingSessions.get(key);
      if (creating) {
        try {
          const sessionId = await creating.promise;
          try {
            this.assertOperationResultCurrent(key, sessionId, creating);
          } catch (error) {
            this.scheduleDiscardInvalidatedSession(sessionId, creating);
            throw error;
          }
          this.promoteTargetToGroup(sessionId, isGroup);
          return sessionId;
        } catch (error) {
          if (creating.invalidationError) {
            throw creating.invalidationError;
          }
          if (this.creatingSessions.get(key) === creating) {
            this.creatingSessions.delete(key);
          }
          this.releaseRouteToken(key, creating);
          failedWaits++;
          if (failedWaits > 3) throw error;
          continue;
        }
      }

      const operation = this.createSessionOperation(
        key,
        {
          channelName: input.channelName,
          senderId: input.senderId,
          chatId: input.chatId,
          threadId: input.threadId,
          isGroup: input.isGroup,
        },
        (currentOperation) =>
          existing
            ? this.loadOrReplaceSession(key, existing, input, currentOperation)
            : this.createAndStoreSession(key, input, currentOperation),
      );
      this.creatingSessions.set(key, operation);
      try {
        const sessionId = await operation.promise;
        try {
          this.assertOperationResultCurrent(key, sessionId, operation);
        } catch (error) {
          this.scheduleDiscardInvalidatedSession(sessionId, operation);
          throw error;
        }
        this.promoteTargetToGroup(sessionId, isGroup);
        return sessionId;
      } finally {
        if (this.creatingSessions.get(key) === operation) {
          this.creatingSessions.delete(key);
        }
        this.releaseRouteToken(key, operation);
      }
    }
  }

  private isLive(sessionId: string): boolean {
    return this.recoveryMode === 'eager' || this.liveSessionIds.has(sessionId);
  }

  private async createAndStoreSession(
    key: string,
    input: {
      channelName: string;
      senderId: string;
      chatId: string;
      threadId?: string;
      cwd: string;
      isGroup?: boolean;
    },
    operation: SessionOperation,
  ): Promise<string> {
    const loadWindow = this.beginSessionLoad();
    try {
      const sessionId = await this.createLiveSession(
        input.cwd,
        loadWindow,
        key,
        this.sessionOptions(input.channelName),
        operation,
      );
      try {
        this.assertOperationCurrent(operation);
      } catch (error) {
        this.scheduleDiscardInvalidatedSession(sessionId, operation);
        throw error;
      }
      this.toSession.set(key, sessionId);
      this.toTarget.set(sessionId, {
        channelName: input.channelName,
        senderId: input.senderId,
        chatId: input.chatId,
        threadId: input.threadId,
        isGroup: input.isGroup,
      });
      this.toCwd.set(sessionId, input.cwd);
      this.liveSessionIds.add(sessionId);
      this.persist();
      return sessionId;
    } finally {
      this.endSessionLoad(loadWindow);
    }
  }

  private async loadOrReplaceSession(
    key: string,
    savedSessionId: string,
    input: {
      channelName: string;
      senderId: string;
      chatId: string;
      threadId?: string;
      cwd: string;
      isGroup?: boolean;
    },
    operation: SessionOperation,
  ): Promise<string> {
    const savedCwd = this.toCwd.get(savedSessionId) ?? input.cwd;
    const loadWindow = this.beginSessionLoad();
    try {
      try {
        const loadedSessionId = await this.bridge.loadSession(
          savedSessionId,
          savedCwd,
          this.sessionOptions(input.channelName),
          operation,
        );
        try {
          this.assertOperationCurrent(operation);
          if (this.toSession.get(key) !== savedSessionId) {
            this.invalidateOperation(operation);
            this.assertOperationCurrent(operation);
          }
        } catch (error) {
          this.scheduleDiscardInvalidatedSession(loadedSessionId, operation);
          throw error;
        }
        if (
          typeof loadedSessionId !== 'string' ||
          loadedSessionId.length === 0 ||
          loadWindow.delete(loadedSessionId)
        ) {
          throw new Error('Invalid or dead restored session ID');
        }
        if (loadedSessionId !== savedSessionId) {
          const target = this.toTarget.get(savedSessionId);
          this.deleteByKey(key);
          this.toSession.set(key, loadedSessionId);
          if (target) this.toTarget.set(loadedSessionId, target);
          this.toCwd.set(loadedSessionId, savedCwd);
          this.persist();
        }
        this.liveSessionIds.add(loadedSessionId);
        return loadedSessionId;
      } catch (loadError) {
        this.assertOperationCurrent(operation);
        try {
          const replacement = await this.createLiveSession(
            input.cwd,
            loadWindow,
            key,
            this.sessionOptions(input.channelName),
            operation,
          );
          try {
            this.assertOperationCurrent(operation);
          } catch (error) {
            this.scheduleDiscardInvalidatedSession(replacement, operation);
            throw error;
          }
          this.deleteByKey(key);
          this.toSession.set(key, replacement);
          this.toTarget.set(replacement, {
            channelName: input.channelName,
            senderId: input.senderId,
            chatId: input.chatId,
            threadId: input.threadId,
            isGroup: input.isGroup,
          });
          this.toCwd.set(replacement, input.cwd);
          this.liveSessionIds.add(replacement);
          this.persist();
          process.stderr.write(
            `[SessionRouter] Replaced unavailable session ${sanitizeLogText(savedSessionId, 128)} for key ${sanitizeLogText(key, 256)} after load failed: ${sanitizeLogText(loadError instanceof Error ? loadError.message : String(loadError), 512)}\n`,
          );
          return replacement;
        } catch (createError) {
          this.assertOperationCurrent(operation);
          process.stderr.write(
            `[SessionRouter] Failed to load session ${sanitizeLogText(savedSessionId, 128)} for key ${sanitizeLogText(key, 256)} (${sanitizeLogText(loadError instanceof Error ? loadError.message : String(loadError), 512)}) and failed to create a replacement (${sanitizeLogText(createError instanceof Error ? createError.message : String(createError), 512)})\n`,
          );
          throw createError;
        }
      }
    } finally {
      this.endSessionLoad(loadWindow);
    }
  }

  getTarget(sessionId: string): SessionTarget | undefined {
    return this.toTarget.get(sessionId);
  }

  getSession(
    channelName: string,
    senderId: string,
    chatId: string,
    threadId?: string,
  ): string | undefined {
    return this.toSession.get(
      this.routingKey(channelName, senderId, chatId, threadId),
    );
  }

  hasSession(
    channelName: string,
    senderId: string,
    chatId?: string,
    threadId?: string,
  ): boolean {
    const scope = this.channelScopes.get(channelName) || this.defaultScope;
    // If chatId is provided, do an exact scoped lookup; otherwise scan for any
    // sender-owned session on this channel. Single scope has no sender-owned
    // no-chat lookup, so callers must pass chatId for an exact single-session
    // check.
    if (chatId) {
      return this.toSession.has(
        this.routingKey(channelName, senderId, chatId, threadId),
      );
    }
    if (scope === 'single') {
      return false;
    }
    for (const target of this.toTarget.values()) {
      if (target.channelName === channelName && target.senderId === senderId) {
        return true;
      }
    }
    return false;
  }

  /**
   * Remove session(s) for the given sender. Returns the removed session IDs.
   */
  removeSession(
    channelName: string,
    senderId: string,
    chatId?: string,
    threadId?: string,
  ): string[] {
    const removedIds: string[] = [];
    const scope = this.channelScopes.get(channelName) || this.defaultScope;
    if (chatId) {
      const key = this.routingKey(channelName, senderId, chatId, threadId);
      this.invalidateRouteOperation(key);
      const sessionId = this.deleteByKey(key);
      if (sessionId) removedIds.push(sessionId);
    } else if (scope === 'single') {
      return removedIds;
    } else {
      // No chatId: remove all sessions for this sender on this channel.
      for (const [k, mappedSessionId] of [...this.toSession.entries()]) {
        const target = this.toTarget.get(mappedSessionId);
        if (
          target?.channelName === channelName &&
          target.senderId === senderId
        ) {
          this.invalidateRouteOperation(k);
          const sessionId = this.deleteByKey(k);
          if (sessionId) removedIds.push(sessionId);
        }
      }
      for (const [key, operation] of [...this.creatingSessions]) {
        if (
          operation.target.channelName === channelName &&
          operation.target.senderId === senderId
        ) {
          this.invalidateRouteOperation(key);
        }
      }
    }
    if (removedIds.length > 0) this.persist();
    return removedIds;
  }

  /** Remove a session mapping by daemon/ACP session ID. */
  removeSessionId(sessionId: string): boolean {
    let removed = false;
    for (const [key, mappedSessionId] of [...this.toSession.entries()]) {
      if (mappedSessionId === sessionId) {
        this.invalidateRouteOperation(key);
        this.toSession.delete(key);
        removed = true;
      }
    }
    if (this.toTarget.delete(sessionId)) {
      removed = true;
    }
    if (this.toCwd.delete(sessionId)) {
      removed = true;
    }
    this.liveSessionIds.delete(sessionId);
    if (!removed && this.sessionLoadWindows.size > 0) {
      for (const loadWindow of this.sessionLoadWindows) {
        loadWindow.add(sessionId);
      }
    }
    if (removed) {
      this.persist();
    }
    return removed;
  }

  handleSessionDied(sessionId: string): boolean {
    if (this.recoveryMode === 'eager') {
      return this.removeSessionId(sessionId);
    }
    const known = this.toTarget.has(sessionId);
    this.liveSessionIds.delete(sessionId);
    for (const loadWindow of this.sessionLoadWindows) {
      loadWindow.add(sessionId);
    }
    return known;
  }

  private deleteByKey(key: string): string | null {
    const sessionId = this.toSession.get(key);
    if (!sessionId) return null;
    this.toSession.delete(key);
    this.toTarget.delete(sessionId);
    this.toCwd.delete(sessionId);
    this.liveSessionIds.delete(sessionId);
    return sessionId;
  }

  private promoteTargetToGroup(
    sessionId: string,
    isGroup: boolean | undefined,
  ): void {
    const current = this.toTarget.get(sessionId);
    if (!current) return;
    if (current.isGroup === true || isGroup !== true) return;
    this.toTarget.set(sessionId, { ...current, isGroup: true });
    this.persist();
  }

  /** Get all session entries for crash recovery. */
  getAll(): Array<{ key: string; sessionId: string; target: SessionTarget }> {
    const entries: Array<{
      key: string;
      sessionId: string;
      target: SessionTarget;
    }> = [];
    for (const [key, sessionId] of this.toSession) {
      const target = this.toTarget.get(sessionId);
      if (target) {
        entries.push({ key, sessionId, target });
      }
    }
    return entries;
  }

  restoreRoutes(): { restored: number; dropped: number } {
    const persisted = this.readPersistedEntries();
    if (!persisted) return { restored: 0, dropped: 0 };
    this.dispose();
    let restored = 0;
    for (const [key, entry] of Object.entries(persisted.entries)) {
      this.toSession.set(key, entry.sessionId);
      this.toTarget.set(entry.sessionId, entry.target);
      this.toCwd.set(entry.sessionId, entry.cwd);
      restored++;
    }
    if (persisted.dropped > 0) this.persist();
    return { restored, dropped: persisted.dropped };
  }

  /**
   * Restore session mappings from a previous bridge.
   * Called after bridge restart — attempts loadSession for each saved mapping.
   * Failed loads are dropped (new session on next message).
   */
  async restoreSessions(): Promise<{
    restored: number;
    failed: number;
  }> {
    const persisted = this.readPersistedEntries();
    if (!persisted) return { restored: 0, failed: 0 };
    const entries = persisted.entries;
    const restoreGeneration = this.lifecycleGeneration;

    let restored = 0;
    let failed = 0;
    let changed = persisted.dropped > 0;
    const reservations = new Map<
      string,
      { reservation: SessionReservation; operation: SessionOperation }
    >();

    for (const key of persisted.droppedKeys) {
      this.deleteByKey(key);
    }

    // Reserve every persisted key up front so inbound messages during restart
    // wait for restore instead of returning stale IDs or creating duplicates.
    for (const key of Object.keys(entries)) {
      this.deleteByKey(key);
      const reservation = this.createSessionReservation();
      reservation.promise.catch(() => undefined);
      const operation = this.createSessionOperation(
        key,
        entries[key]!.target,
        () => reservation.promise,
      );
      operation.promise.catch(() => undefined);
      this.creatingSessions.set(key, operation);
      reservations.set(key, { reservation, operation });
    }

    const loadWindow = this.beginSessionLoad();
    try {
      for (const [key, entry] of Object.entries(entries)) {
        const reserved = reservations.get(key);
        if (!reserved) continue;
        const { reservation, operation } = reserved;
        try {
          this.assertOperationCurrent(operation);
          const options = this.sessionOptions(entry.target.channelName);
          const sessionId = await this.bridge.loadSession(
            entry.sessionId,
            entry.cwd,
            options,
            operation,
          );
          try {
            this.assertOperationCurrent(operation);
          } catch (error) {
            this.scheduleDiscardInvalidatedSession(sessionId, operation);
            throw error;
          }
          if (typeof sessionId !== 'string' || sessionId.length === 0) {
            throw new Error('Invalid restored session ID');
          }
          if (loadWindow.delete(sessionId)) {
            throw new Error('Restored session died before routing completed');
          }
          this.toSession.set(key, sessionId);
          this.toTarget.set(sessionId, entry.target);
          this.toCwd.set(sessionId, entry.cwd);
          reservation.resolve(sessionId);
          if (sessionId !== entry.sessionId) {
            changed = true;
          }
          restored++;
        } catch (err) {
          const reason = err instanceof Error ? err.message : String(err);
          process.stderr.write(
            `[SessionRouter] Failed to restore session ${sanitizeLogText(entry.sessionId, 128)} for key ${sanitizeLogText(key, 256)}: ${sanitizeLogText(reason, 512)}\n`,
          );
          reservation.reject(
            new Error('Session restore failed', { cause: err }),
          );
          // Session can't be loaded — will create fresh on next message
          failed++;
          changed = true;
        } finally {
          if (this.creatingSessions.get(key) === operation) {
            this.creatingSessions.delete(key);
          }
          this.releaseRouteToken(key, operation);
        }
      }
    } finally {
      this.endSessionLoad(loadWindow);
    }

    // Update persist file to only include successfully restored sessions
    if (changed && restoreGeneration === this.lifecycleGeneration) {
      this.persist();
    }

    return { restored, failed };
  }

  dispose(): void {
    this.lifecycleGeneration++;
    for (const operation of this.creatingSessions.values()) {
      this.invalidateOperation(operation);
    }
    this.toSession.clear();
    this.toTarget.clear();
    this.toCwd.clear();
    this.creatingSessions.clear();
    this.sessionLoadWindows.clear();
    this.liveSessionIds.clear();
    this.routeTokens.clear();
  }

  /** Clear in-memory state and delete persist file. Used on clean shutdown. */
  clearAll(): void {
    this.dispose();
    if (this.persistPath && existsSync(this.persistPath)) {
      try {
        unlinkSync(this.persistPath);
      } catch {
        // best-effort
      }
    }
  }

  private readPersistedEntries():
    | {
        entries: Record<string, PersistedEntry>;
        dropped: number;
        droppedKeys: string[];
      }
    | undefined {
    const persistPath = this.persistPath;
    if (!persistPath || !existsSync(persistPath)) return undefined;

    let parsed: unknown;
    try {
      parsed = JSON.parse(readFileSync(persistPath, 'utf-8'));
    } catch (error) {
      const quarantinePath = `${persistPath}.corrupt-${Date.now()}`;
      try {
        renameSync(persistPath, quarantinePath);
      } catch {
        // Keep startup available even if quarantine itself fails.
      }
      process.stderr.write(
        `[SessionRouter] Corrupted persist file at ${sanitizeLogText(persistPath, 1024)}: ${sanitizeLogText(error instanceof Error ? error.message : String(error), 512)}\n`,
      );
      return undefined;
    }
    if (
      typeof parsed !== 'object' ||
      parsed === null ||
      Array.isArray(parsed)
    ) {
      const quarantinePath = `${persistPath}.corrupt-${Date.now()}`;
      try {
        renameSync(persistPath, quarantinePath);
      } catch {
        // Keep startup available even if quarantine itself fails.
      }
      process.stderr.write(
        `[SessionRouter] Invalid route store at ${sanitizeLogText(persistPath, 1024)}: expected an object\n`,
      );
      return undefined;
    }

    const entries: Record<string, PersistedEntry> = {};
    const droppedKeys: string[] = [];
    for (const [key, value] of Object.entries(parsed)) {
      if (this.isPersistedEntry(value)) entries[key] = value;
      else droppedKeys.push(key);
    }
    return { entries, dropped: droppedKeys.length, droppedKeys };
  }

  private isPersistedEntry(value: unknown): value is PersistedEntry {
    if (typeof value !== 'object' || value === null) return false;
    const entry = value as Record<string, unknown>;
    const target = entry['target'];
    if (typeof target !== 'object' || target === null) return false;
    const typedTarget = target as Record<string, unknown>;
    return (
      typeof entry['sessionId'] === 'string' &&
      entry['sessionId'].length > 0 &&
      typeof entry['cwd'] === 'string' &&
      entry['cwd'].length > 0 &&
      typeof typedTarget['channelName'] === 'string' &&
      typeof typedTarget['senderId'] === 'string' &&
      typeof typedTarget['chatId'] === 'string' &&
      (typedTarget['threadId'] === undefined ||
        typeof typedTarget['threadId'] === 'string') &&
      (typedTarget['isGroup'] === undefined ||
        typeof typedTarget['isGroup'] === 'boolean')
    );
  }

  private persist(): void {
    if (!this.persistPath) return;

    const data: Record<string, PersistedEntry> = {};
    for (const [key, sessionId] of this.toSession) {
      const target = this.toTarget.get(sessionId);
      if (!target) continue;
      data[key] = {
        sessionId,
        target,
        cwd: this.toCwd.get(sessionId) ?? this.defaultCwd,
      };
    }

    const dir = dirname(this.persistPath);
    const tempPath = join(
      dir,
      `${Date.now()}-${process.pid}-${Math.random().toString(16).slice(2)}.tmp`,
    );
    try {
      mkdirSync(dir, { recursive: true, mode: 0o700 });
      try {
        chmodSync(dir, 0o700);
      } catch {
        // Windows and some filesystems do not implement POSIX modes.
      }
      writeFileSync(tempPath, JSON.stringify(data, null, 2), {
        encoding: 'utf-8',
        mode: 0o600,
      });
      renameSync(tempPath, this.persistPath);
      try {
        chmodSync(this.persistPath, 0o600);
      } catch {
        // Windows and some filesystems do not implement POSIX modes.
      }
    } catch (error) {
      process.stderr.write(
        `[SessionRouter] Failed to persist routes at ${sanitizeLogText(this.persistPath, 1024)}: ${sanitizeLogText(error instanceof Error ? error.message : String(error), 512)}\n`,
      );
    } finally {
      try {
        rmSync(tempPath, { force: true });
      } catch {
        // best-effort temp cleanup
      }
    }
  }

  private async createLiveSession(
    cwd: string,
    loadWindow: SessionLoadWindow,
    routingKey: string,
    options: { approvalMode?: string } | undefined,
    operation: SessionOperation,
  ): Promise<string> {
    const maxAttempts = 2;
    let lastDeadSessionId: string | undefined;
    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      const sessionId = await this.bridge.newSession(cwd, options, operation);
      try {
        this.assertOperationCurrent(operation);
      } catch (error) {
        this.scheduleDiscardInvalidatedSession(sessionId, operation);
        throw error;
      }
      if (typeof sessionId !== 'string' || sessionId.length === 0) {
        throw new Error('Invalid session ID from bridge');
      }
      if (!loadWindow.delete(sessionId)) {
        return sessionId;
      }
      lastDeadSessionId = sessionId;
    }
    throw new Error(
      `Session ${lastDeadSessionId ?? 'unknown'} died before routing completed (${maxAttempts}/${maxAttempts} attempts, key ${routingKey})`,
    );
  }

  private beginSessionLoad(): SessionLoadWindow {
    const loadWindow: SessionLoadWindow = new Set();
    this.sessionLoadWindows.add(loadWindow);
    return loadWindow;
  }

  private createSessionOperation(
    key: string,
    target: SessionTarget,
    run: (operation: SessionOperation) => Promise<string>,
  ): SessionOperation {
    let routeToken = this.routeTokens.get(key);
    if (!routeToken) {
      routeToken = {};
      this.routeTokens.set(key, routeToken);
    }
    const operation: SessionOperation = {
      promise: Promise.resolve(''),
      target,
      lifecycleGeneration: this.lifecycleGeneration,
      routeToken,
    };
    operation.promise = Promise.resolve()
      .then(() => run(operation))
      .catch((error: unknown) => {
        this.assertOperationCurrent(operation);
        throw error;
      });
    return operation;
  }

  private invalidateRouteOperation(key: string): void {
    this.routeTokens.delete(key);
    const operation = this.creatingSessions.get(key);
    if (!operation) return;
    this.invalidateOperation(operation);
    this.creatingSessions.delete(key);
  }

  private invalidateOperation(operation: SessionOperation): void {
    operation.invalidationError ??= new Error(
      'Session route operation was invalidated',
    );
  }

  private assertOperationCurrent(operation: SessionOperation): void {
    if (operation.lifecycleGeneration !== this.lifecycleGeneration) {
      this.invalidateOperation(operation);
    }
    if (operation.invalidationError) {
      throw operation.invalidationError;
    }
  }

  private assertOperationResultCurrent(
    key: string,
    sessionId: string,
    operation: SessionOperation,
  ): void {
    if (operation.routeToken !== this.routeTokens.get(key)) {
      this.invalidateOperation(operation);
    }
    if (this.toSession.get(key) !== sessionId) {
      this.invalidateOperation(operation);
    }
    this.assertOperationCurrent(operation);
  }

  private releaseRouteToken(key: string, operation: SessionOperation): void {
    if (
      this.routeTokens.get(key) === operation.routeToken &&
      !this.toSession.has(key) &&
      !this.creatingSessions.has(key)
    ) {
      this.routeTokens.delete(key);
    }
  }

  private scheduleDiscardInvalidatedSession(
    sessionId: string,
    operation: SessionOperation,
  ): void {
    if ([...this.toSession.values()].includes(sessionId)) return;
    try {
      void this.bridge
        .discardSession?.(sessionId, operation)
        .catch(() => undefined);
    } catch {
      // Best-effort cleanup must not replace the terminal invalidation.
    }
  }

  private createSessionReservation(): SessionReservation {
    let resolveReservation!: (sessionId: string) => void;
    let rejectReservation!: (error: unknown) => void;
    const promise = new Promise<string>((resolve, reject) => {
      resolveReservation = resolve;
      rejectReservation = reject;
    });
    return {
      promise,
      resolve: resolveReservation,
      reject: rejectReservation,
    };
  }

  private endSessionLoad(loadWindow: SessionLoadWindow): void {
    this.sessionLoadWindows.delete(loadWindow);
  }
}
