import { existsSync, readFileSync, writeFileSync, unlinkSync } from 'node:fs';
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
  private scope: SessionScope;
  private persistPath: string | undefined;

  constructor(
    bridge: AcpBridge,
    defaultCwd: string,
    scope: SessionScope = 'user',
    persistPath?: string,
  ) {
    this.bridge = bridge;
    this.defaultCwd = defaultCwd;
    this.scope = scope;
    this.persistPath = persistPath;
  }

  /** Replace the bridge instance (used after crash recovery restart). */
  setBridge(bridge: AcpBridge): void {
    this.bridge = bridge;
  }

  private routingKey(
    channelName: string,
    senderId: string,
    chatId: string,
    threadId?: string,
  ): string {
    switch (this.scope) {
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

  removeSession(
    channelName: string,
    senderId: string,
    chatId?: string,
  ): boolean {
    if (chatId) {
      const key = this.routingKey(channelName, senderId, chatId);
      return this.deleteByKey(key);
    }
    // No chatId: remove all sessions for this sender on this channel
    let removed = false;
    const prefix = `${channelName}:${senderId}`;
    for (const k of [...this.toSession.keys()]) {
      if (k.startsWith(prefix)) {
        this.deleteByKey(k);
        removed = true;
      }
    }
    if (removed) this.persist();
    return removed;
  }

  private deleteByKey(key: string): boolean {
    const sessionId = this.toSession.get(key);
    if (!sessionId) return false;
    this.toSession.delete(key);
    this.toTarget.delete(sessionId);
    this.toCwd.delete(sessionId);
    return true;
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
   * Failed loads are silently dropped (new session on next message).
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
      entries = JSON.parse(readFileSync(this.persistPath, 'utf-8'));
    } catch {
      return { restored: 0, failed: 0 };
    }

    let restored = 0;
    let failed = 0;

    for (const [key, entry] of Object.entries(entries)) {
      try {
        const sessionId = await this.bridge.loadSession(
          entry.sessionId,
          entry.cwd,
        );
        this.toSession.set(key, sessionId);
        this.toTarget.set(sessionId, entry.target);
        this.toCwd.set(sessionId, entry.cwd);
        restored++;
      } catch {
        // Session can't be loaded — will create fresh on next message
        failed++;
      }
    }

    // Update persist file to only include successfully restored sessions
    if (failed > 0) {
      this.persist();
    }

    return { restored, failed };
  }

  /** Clear in-memory state and delete persist file. Used on clean shutdown. */
  clearAll(): void {
    this.toSession.clear();
    this.toTarget.clear();
    this.toCwd.clear();
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
}
