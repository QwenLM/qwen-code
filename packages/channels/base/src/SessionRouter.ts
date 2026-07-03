import { existsSync, readFileSync, writeFileSync, unlinkSync } from 'node:fs';
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

type SessionLoadWindow = Set<string>;

export class SessionRouter {
  private toSession: Map<string, string> = new Map(); // routing key → session ID
  private toTarget: Map<string, SessionTarget> = new Map(); // session ID → target
  private toCwd: Map<string, string> = new Map(); // session ID → cwd
  private creatingSessions: Map<string, Promise<string>> = new Map();
  private sessionLoadWindows: Set<SessionLoadWindow> = new Set();

  private bridge: ChannelAgentBridge;
  private defaultCwd: string;
  private defaultScope: SessionScope;
  private channelScopes: Map<string, SessionScope> = new Map();
  private persistPath: string | undefined;

  constructor(
    bridge: ChannelAgentBridge,
    defaultCwd: string,
    scope: SessionScope = 'user',
    persistPath?: string,
  ) {
    this.bridge = bridge;
    this.defaultCwd = defaultCwd;
    this.defaultScope = scope;
    this.persistPath = persistPath;
  }

  /** Replace the bridge instance (used after crash recovery restart). */
  setBridge(bridge: ChannelAgentBridge): void {
    this.bridge = bridge;
  }

  /** Set scope override for a specific channel. */
  setChannelScope(channelName: string, scope: SessionScope): void {
    this.channelScopes.set(channelName, scope);
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

  async resolve(
    channelName: string,
    senderId: string,
    chatId: string,
    threadId?: string,
    cwd?: string,
    isGroup?: boolean,
  ): Promise<string> {
    const key = this.routingKey(channelName, senderId, chatId, threadId);
    let failedCreateWaits = 0;
    for (;;) {
      const existing = this.toSession.get(key);
      if (existing) {
        this.updateTarget(existing, {
          channelName,
          senderId,
          chatId,
          threadId,
          isGroup,
        });
        return existing;
      }

      const creating = this.creatingSessions.get(key);
      if (creating) {
        try {
          const sessionId = await creating;
          this.updateTarget(sessionId, {
            channelName,
            senderId,
            chatId,
            threadId,
            isGroup,
          });
          return sessionId;
        } catch (err) {
          if (this.creatingSessions.get(key) === creating) {
            this.creatingSessions.delete(key);
          }
          failedCreateWaits++;
          if (failedCreateWaits > 3) {
            throw err;
          }
          continue;
        }
      }

      // Register the in-flight route before starting newSession(), because a
      // bridge can emit sessionDied synchronously while creating the session.
      const created = Promise.resolve().then(async () => {
        const sessionCwd = cwd || this.defaultCwd;
        const loadWindow = this.beginSessionLoad();
        try {
          const sessionId = await this.createLiveSession(
            sessionCwd,
            loadWindow,
            key,
          );
          this.toSession.set(key, sessionId);
          this.toTarget.set(sessionId, {
            channelName,
            senderId,
            chatId,
            threadId,
            isGroup,
          });
          this.toCwd.set(sessionId, sessionCwd);
          this.persist();
          return sessionId;
        } finally {
          this.endSessionLoad(loadWindow);
        }
      });
      this.creatingSessions.set(key, created);
      try {
        return await created;
      } finally {
        if (this.creatingSessions.get(key) === created) {
          this.creatingSessions.delete(key);
        }
      }
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
          const sessionId = this.deleteByKey(k);
          if (sessionId) removedIds.push(sessionId);
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

  private deleteByKey(key: string): string | null {
    const sessionId = this.toSession.get(key);
    if (!sessionId) return null;
    this.toSession.delete(key);
    this.toTarget.delete(sessionId);
    this.toCwd.delete(sessionId);
    return sessionId;
  }

  private updateTarget(sessionId: string, next: SessionTarget): void {
    const current = this.toTarget.get(sessionId);
    if (!current) return;
    const changed =
      current.channelName !== next.channelName ||
      current.senderId !== next.senderId ||
      current.chatId !== next.chatId ||
      current.threadId !== next.threadId ||
      current.isGroup !== next.isGroup;
    if (!changed) return;
    this.toTarget.set(sessionId, next);
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

  /**
   * Restore session mappings from a previous bridge.
   * Called after bridge restart — attempts loadSession for each saved mapping.
   * Failed loads are dropped (new session on next message).
   */
  async restoreSessions(): Promise<{
    restored: number;
    failed: number;
  }> {
    const persistPath = this.persistPath;
    if (!persistPath || !existsSync(persistPath)) {
      return { restored: 0, failed: 0 };
    }

    let entries: Record<string, PersistedEntry>;
    try {
      entries = JSON.parse(readFileSync(persistPath, 'utf-8'));
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      process.stderr.write(
        `[SessionRouter] Corrupted persist file at ${sanitizeLogText(persistPath, 1024)}: ${sanitizeLogText(reason, 512)}\n`,
      );
      return { restored: 0, failed: 0 };
    }

    let restored = 0;
    let failed = 0;
    let changed = false;
    const reservations = new Map<string, SessionReservation>();

    // Reserve every persisted key up front so inbound messages during restart
    // wait for restore instead of returning stale IDs or creating duplicates.
    for (const key of Object.keys(entries)) {
      this.deleteByKey(key);
      const reservation = this.createSessionReservation();
      reservation.promise.catch(() => undefined);
      this.creatingSessions.set(key, reservation.promise);
      reservations.set(key, reservation);
    }

    const loadWindow = this.beginSessionLoad();
    try {
      for (const [key, entry] of Object.entries(entries)) {
        const reservation = reservations.get(key);
        if (!reservation) continue;
        try {
          const sessionId = await this.bridge.loadSession(
            entry.sessionId,
            entry.cwd,
          );
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
          if (this.creatingSessions.get(key) === reservation.promise) {
            this.creatingSessions.delete(key);
          }
        }
      }
    } finally {
      this.endSessionLoad(loadWindow);
    }

    // Update persist file to only include successfully restored sessions
    if (changed) {
      this.persist();
    }

    return { restored, failed };
  }

  /** Clear in-memory state and delete persist file. Used on clean shutdown. */
  clearAll(): void {
    this.toSession.clear();
    this.toTarget.clear();
    this.toCwd.clear();
    this.creatingSessions.clear();
    this.sessionLoadWindows.clear();
    if (this.persistPath && existsSync(this.persistPath)) {
      try {
        unlinkSync(this.persistPath);
      } catch {
        // best-effort
      }
    }
  }

  private persist(): void {
    if (!this.persistPath) return;

    const data: Record<string, PersistedEntry> = {};
    for (const [key, sessionId] of this.toSession) {
      const target = this.toTarget.get(sessionId);
      if (target) {
        data[key] = {
          sessionId,
          target,
          cwd: this.toCwd.get(sessionId) || this.defaultCwd,
        };
      }
    }

    try {
      writeFileSync(this.persistPath, JSON.stringify(data, null, 2), 'utf-8');
    } catch {
      // best-effort — don't break message flow for persistence failure
    }
  }

  private async createLiveSession(
    cwd: string,
    loadWindow: SessionLoadWindow,
    routingKey: string,
  ): Promise<string> {
    const maxAttempts = 2;
    let lastDeadSessionId: string | undefined;
    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      const sessionId = await this.bridge.newSession(cwd);
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
