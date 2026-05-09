import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import type { SessionScope, SessionTarget } from './types.js';
import type { AcpBridge } from './AcpBridge.js';

interface PersistedEntry {
  sessionId: string;
  target: SessionTarget;
  cwd: string;
}

export class SessionRouter {
  private toSession: Map<string, string> = new Map(); // routing key → session ID
  private toTarget: Map<string, SessionTarget> = new Map(); // session ID → target
  private toCwd: Map<string, string> = new Map(); // session ID → cwd

  private bridge: AcpBridge;
  private defaultCwd: string;
  private defaultScope: SessionScope;
  private channelScopes: Map<string, SessionScope> = new Map();
  private persistPath: string | undefined;

  constructor(
    bridge: AcpBridge,
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
  setBridge(bridge: AcpBridge): void {
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
  ): Promise<string> {
    const key = this.routingKey(channelName, senderId, chatId, threadId);
    const existing = this.toSession.get(key);
    if (existing) {
      return existing;
    }

    const sessionCwd = cwd || this.defaultCwd;
    const sessionId = await this.bridge.newSession(sessionCwd);
    this.toSession.set(key, sessionId);
    this.toTarget.set(sessionId, { channelName, senderId, chatId, threadId });
    this.toCwd.set(sessionId, sessionCwd);
    this.persist();
    return sessionId;
  }

  getTarget(sessionId: string): SessionTarget | undefined {
    return this.toTarget.get(sessionId);
  }

  hasSession(channelName: string, senderId: string, chatId?: string): boolean {
    const key = chatId
      ? this.routingKey(channelName, senderId, chatId)
      : `${channelName}:${senderId}`;
    // If chatId is provided, do exact lookup; otherwise prefix-scan for any match
    if (chatId) return this.toSession.has(key);
    for (const k of this.toSession.keys()) {
      if (k.startsWith(`${channelName}:${senderId}`)) return true;
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
  ): string[] {
    const removedIds: string[] = [];
    if (chatId) {
      const key = this.routingKey(channelName, senderId, chatId);
      const sessionId = this.deleteByKey(key);
      if (sessionId) removedIds.push(sessionId);
    } else {
      // No chatId: remove all sessions for this sender on this channel
      const prefix = `${channelName}:${senderId}`;
      for (const k of [...this.toSession.keys()]) {
        if (k.startsWith(prefix)) {
          const sessionId = this.deleteByKey(k);
          if (sessionId) removedIds.push(sessionId);
        }
      }
    }
    if (removedIds.length > 0) this.persist();
    return removedIds;
  }

  private deleteByKey(key: string): string | null {
    const sessionId = this.toSession.get(key);
    if (!sessionId) return null;
    this.toSession.delete(key);
    this.toTarget.delete(sessionId);
    this.toCwd.delete(sessionId);
    return sessionId;
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
   * Failed loads are logged to stderr and dropped from the persist file
   * (a new session will be created on the next incoming message).
   */
  async restoreSessions(): Promise<{
    restored: number;
    failed: number;
  }> {
    if (!this.persistPath || !existsSync(this.persistPath)) {
      return { restored: 0, failed: 0 };
    }

    let entries: Record<string, PersistedEntry>;
    try {
      const raw = readFileSync(this.persistPath, 'utf-8');
      const parsed: unknown = JSON.parse(raw);

      // Guard against JSON.parse(null) and other non-object results
      if (
        parsed === null ||
        typeof parsed !== 'object' ||
        Array.isArray(parsed)
      ) {
        process.stderr.write(
          `[SessionRouter] Corrupted persist file (expected object, got ${parsed === null ? 'null' : Array.isArray(parsed) ? 'array' : typeof parsed}).\n`,
        );
        return { restored: 0, failed: 0 };
      }

      entries = parsed as Record<string, PersistedEntry>;
    } catch {
      // Corrupted file — warn and return empty so the next persist()
      // can write a clean file after a successful restore.
      process.stderr.write(
        `[SessionRouter] Failed to parse persist file: ${this.persistPath}\n`,
      );
      return { restored: 0, failed: 0 };
    }

    let restored = 0;
    let failed = 0;

    for (const [key, entry] of Object.entries(entries)) {
      // Guard against malformed entries from a corrupted persist file.
      if (
        typeof entry?.sessionId !== 'string' ||
        typeof entry?.cwd !== 'string' ||
        typeof entry?.target?.channelName !== 'string'
      ) {
        process.stderr.write(
          `[SessionRouter] Skipping malformed entry for key ${key}\n`,
        );
        failed++;
        continue;
      }

      try {
        const sessionId = await this.bridge.loadSession(
          entry.sessionId,
          entry.cwd,
        );
        this.toSession.set(key, sessionId);
        this.toTarget.set(sessionId, entry.target);
        this.toCwd.set(sessionId, entry.cwd);
        restored++;
      } catch (err: unknown) {
        // Session can't be loaded — remove stale in-memory mapping so
        // subsequent resolve() / persist() don't reference a dead session.
        const msg = err instanceof Error ? err.message : String(err);
        process.stderr.write(
          `[SessionRouter] Failed to restore session ${entry.sessionId}: ${msg}\n`,
        );
        this.toSession.delete(key);
        this.toTarget.delete(entry.sessionId);
        this.toCwd.delete(entry.sessionId);
        failed++;
      }
    }

    // Update persist file to remove failed entries.
    // Only persist if at least one session was successfully restored —
    // an all-failure persist() would write empty {} and permanently delete
    // routing data that might be recoverable on a subsequent attempt.
    //
    // TODO: When failed > 0 && restored === 0, the persist file is never
    // trimmed — every restart retries the same dead session IDs. Consider
    // an escape hatch: after N consecutive all-failure cycles, force-prune
    // entries that the ACP agent explicitly rejects (sessionExists=false).
    if (failed > 0 && restored > 0) {
      this.persist();
    }

    return { restored, failed };
  }

  /** Clear in-memory state. Persist file is left intact for the next start
   *  via {@link restoreSessions}. */
  clearAll(): void {
    this.toSession.clear();
    this.toTarget.clear();
    this.toCwd.clear();
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
}
