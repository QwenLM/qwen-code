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
import type {
  SessionRotationConfig,
  SessionScope,
  SessionTarget,
} from './types.js';
import type {
  ChannelAgentBridge,
  ChannelAgentBridgeSessionOptions,
} from './ChannelAgentBridge.js';
import { sanitizeLogText } from './sanitize.js';

interface PersistedEntry {
  sessionId: string;
  target: SessionTarget;
  cwd: string;
  /** Messages routed to this session so far. Absent on pre-rotation stores. */
  turns?: number;
  /** Epoch ms the session was first routed to. Absent on pre-rotation stores. */
  startedAt?: number;
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
  private toTurns: Map<string, number> = new Map(); // session ID → messages routed
  private toStartedAt: Map<string, number> = new Map(); // session ID → epoch ms
  private sessionRoutingLeases: Map<string, number> = new Map(); // session ID → routed-but-unsettled messages
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
  private readonly channelsWithoutLoops = new Set<string>();
  private channelRotations: Map<string, SessionRotationConfig> = new Map();
  private sessionActivityCheckers = new Map<
    string,
    (sessionId: string) => boolean
  >();
  private rotationListeners = new Set<
    (sessionId: string, target: SessionTarget | undefined) => void
  >();
  private persistPath: string | undefined;
  private persistSuspendDepth = 0;
  private persistRequestedWhileSuspended = false;
  // Rotation-state writes (countTurn, uncountTurn, leaseSession,
  // releaseRoutingLease) that land while a restore's reservation pass holds
  // the session wiped, keyed by the wiped session ID. The restore's carry
  // nets them against the captured baseline instead of overwriting them.
  private readonly rotationDeltas = new Map<
    string,
    { turns: number; leases: number }
  >();
  // Routing keys removed while persistence is suspended: the removal only
  // reaches disk at the last restore's flush, and any restore reading the
  // stale snapshot until then must skip them instead of resurrecting them.
  private readonly suspendedDeletionKeys = new Set<string>();
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
    this.liveSessionIds.clear();
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

  setChannelLoopsEnabled(channelName: string, enabled: boolean): void {
    if (enabled) {
      this.channelsWithoutLoops.delete(channelName);
    } else {
      this.channelsWithoutLoops.add(channelName);
    }
  }

  /** Set session auto-rotation bounds for a specific channel. */
  setChannelRotation(
    channelName: string,
    rotation: SessionRotationConfig | undefined,
  ): void {
    const maxTurns = isValidTurnCount(rotation?.maxTurns)
      ? rotation.maxTurns
      : undefined;
    const maxAgeHours = normalizeRotationBound(rotation?.maxAgeHours);
    if (maxTurns === undefined && maxAgeHours === undefined) {
      this.channelRotations.delete(channelName);
      return;
    }
    this.channelRotations.set(channelName, {
      ...(maxTurns !== undefined ? { maxTurns } : {}),
      ...(maxAgeHours !== undefined ? { maxAgeHours } : {}),
    });
  }

  /**
   * Whether `sessionId` has outgrown its channel's rotation bounds. Checked
   * before a message reuses the session, so the bound is a ceiling on what the
   * session carries into a turn rather than what it is left holding after one.
   */
  private shouldRotate(channelName: string, sessionId: string): boolean {
    const rotation = this.channelRotations.get(channelName);
    if (!rotation) return false;

    const { maxTurns, maxAgeHours } = rotation;
    if (
      maxTurns !== undefined &&
      (this.toTurns.get(sessionId) ?? 0) >= maxTurns
    ) {
      return true;
    }
    if (maxAgeHours !== undefined) {
      const startedAt = this.toStartedAt.get(sessionId);
      // A session with no recorded start (restored from a pre-rotation store)
      // gets its clock started here rather than rotating immediately. The
      // stamp is persisted: age-only bounds write nothing per message, so a
      // memory-only stamp would let restarts re-arm the clock indefinitely.
      if (startedAt === undefined) {
        this.toStartedAt.set(sessionId, Date.now());
        this.persist();
        return false;
      }
      if (Date.now() - startedAt >= maxAgeHours * 60 * 60 * 1000) return true;
    }
    return false;
  }

  /**
   * Register a checker reporting whether sessions on `channelName` still have
   * a turn running or queued. Rotation defers while one does, so a route is
   * never retired out from under an in-flight turn.
   */
  setSessionActivityChecker(
    channelName: string,
    checker: ((sessionId: string) => boolean) | undefined,
  ): void {
    if (checker) {
      this.sessionActivityCheckers.set(channelName, checker);
    } else {
      this.sessionActivityCheckers.delete(channelName);
    }
  }

  /**
   * Subscribe to rotation retirements. Fires after the route is dropped and
   * before the retired session is discarded, so owners can purge per-session
   * state and notify the chat. Returns an unsubscribe function.
   */
  onSessionRotated(
    listener: (sessionId: string, target: SessionTarget | undefined) => void,
  ): () => void {
    this.rotationListeners.add(listener);
    return () => {
      this.rotationListeners.delete(listener);
    };
  }

  /**
   * Retire a route so the next resolve starts a fresh session on it. The
   * outgoing session goes through the same retirement machinery as the other
   * paths: owners purge their per-session state, then the bridge discards it —
   * otherwise nothing would ever reclaim a rotated session.
   */
  private rotateRoute(
    key: string,
    sessionId: string,
    channelName: string,
    target: SessionTarget | undefined,
  ): void {
    this.invalidateRouteOperation(key);
    this.deleteByKey(key);
    this.tombstoneSuspendedKey(key);
    // Persist the retirement now: if the successor creation fails before its
    // own persist, a restart must not restore the stale route and re-fire the
    // whole rotation (a second notice and discard for what was one rotation).
    // Mid-restore this write is suspended like any other and only becomes
    // durable with the restore's end flush, so a crash in that window
    // re-fires the rotation once on the next start.
    this.persist();
    process.stderr.write(
      `[SessionRouter] Rotated session for key ${sanitizeLogText(key, 256)} on ${sanitizeLogText(channelName, 128)}: ` +
        `${sanitizeLogText(sessionId, 128)} reached its configured limit; ` +
        `starting a new session.\n`,
    );
    for (const listener of this.rotationListeners) {
      try {
        listener(sessionId, target);
      } catch (error) {
        process.stderr.write(
          `[SessionRouter] Rotation listener error for session ${sanitizeLogText(sessionId, 128)}: ` +
            `${sanitizeLogText(error instanceof Error ? error.message : String(error), 512)}\n`,
        );
      }
    }
    this.discardRotatedSession(sessionId);
  }

  private discardRotatedSession(sessionId: string): void {
    if ([...this.toSession.values()].includes(sessionId)) return;
    try {
      void this.bridge.discardSession?.(sessionId).catch(() => undefined);
    } catch {
      // Best-effort cleanup must not fail the incoming message.
    }
  }

  private isSessionActive(channelName: string, sessionId: string): boolean {
    const checker = this.sessionActivityCheckers.get(channelName);
    return checker ? checker(sessionId) : false;
  }

  private leaseSession(sessionId: string): void {
    const delta = this.rotationDeltas.get(sessionId);
    if (delta) {
      delta.leases += 1;
      return;
    }
    this.sessionRoutingLeases.set(
      sessionId,
      (this.sessionRoutingLeases.get(sessionId) ?? 0) + 1,
    );
  }

  private hasRoutingLease(sessionId: string): boolean {
    return (this.sessionRoutingLeases.get(sessionId) ?? 0) > 0;
  }

  /**
   * Release the routing lease resolve() took when handing out `sessionId`.
   * Call exactly once per successful resolve: when the routed message is
   * enqueued as a turn, or when it settles without one (buffered, handled as
   * a shell command). Rotation defers while a lease is held, so a session is
   * never retired out from under a message that resolved it but has not yet
   * registered its turn.
   */
  releaseRoutingLease(sessionId: string): void {
    const delta = this.rotationDeltas.get(sessionId);
    if (delta) {
      delta.leases -= 1;
      return;
    }
    const leases = this.sessionRoutingLeases.get(sessionId) ?? 0;
    if (leases <= 1) {
      this.sessionRoutingLeases.delete(sessionId);
    } else {
      this.sessionRoutingLeases.set(sessionId, leases - 1);
    }
  }

  /**
   * Counting turns costs a persist per message, and only the turns bound ever
   * reads the counter, so channels without maxTurns opt out of both.
   */
  private countTurn(channelName: string, sessionId: string): void {
    const rotation = this.channelRotations.get(channelName);
    if (rotation?.maxTurns === undefined) return;
    const delta = this.rotationDeltas.get(sessionId);
    if (delta) {
      delta.turns += 1;
      this.persist();
      return;
    }
    this.toTurns.set(sessionId, (this.toTurns.get(sessionId) ?? 0) + 1);
    this.persist();
  }

  /**
   * Reverse countTurn for a routed message that settled without starting a
   * turn (buffered in collect mode, dropped loop firing, shell command):
   * the bound counts turns actually started. Zero is an absent counter, so
   * a session whose only count was given back rotates exactly on schedule.
   */
  uncountTurn(channelName: string, sessionId: string): void {
    const rotation = this.channelRotations.get(channelName);
    if (rotation?.maxTurns === undefined) return;
    const delta = this.rotationDeltas.get(sessionId);
    if (delta) {
      delta.turns -= 1;
      this.persist();
      return;
    }
    const turns = this.toTurns.get(sessionId);
    if (turns === undefined) return;
    if (turns <= 1) {
      this.toTurns.delete(sessionId);
    } else {
      this.toTurns.set(sessionId, turns - 1);
    }
    this.persist();
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
      case 'chat_thread':
        return threadId
          ? `${channelName}:${chatId}:${threadId}`
          : `${channelName}:${chatId}`;
      case 'single':
        return `${channelName}:__single__`;
      case 'user':
      default:
        return `${channelName}:${senderId}:${chatId}`;
    }
  }

  private sessionOptions(
    channelName: string,
  ): ChannelAgentBridgeSessionOptions {
    const approvalMode = this.channelApprovalModes.get(channelName);
    const loopsDisabled = this.channelsWithoutLoops.has(channelName);
    return {
      ...(approvalMode ? { approvalMode } : {}),
      ...(loopsDisabled ? { enableChannelLoops: false } : {}),
      sourceId: channelName,
    };
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
      let existing = this.toSession.get(key);
      // Checked before both the live-reuse and the lazy-reload path so a route
      // cannot dodge its bound by having been evicted from memory. Skipped
      // while a creation is in flight on this key: invalidating it would fail
      // the concurrent message instead of rotating it, and the bound is just as
      // well enforced on the next one. Deferred while the outgoing session
      // still has a turn running or queued, or while a routed message has not
      // settled yet (a resolve whose turn is registered only in a later
      // microtask): retiring it then would discard a session a concurrent
      // message is about to prompt, or auto-cancel its pending approvals and
      // drop its late output — so the bound is enforced on the next message
      // instead. Each deferred message enqueues a turn of its own, so a route
      // whose messages never pause defers until the first idle gap; that
      // limit is documented in the Session Rotation docs.
      if (
        existing &&
        !this.creatingSessions.has(key) &&
        !this.isSessionActive(channelName, existing) &&
        !this.hasRoutingLease(existing) &&
        this.shouldRotate(channelName, existing)
      ) {
        this.rotateRoute(key, existing, channelName, {
          channelName: input.channelName,
          senderId: input.senderId,
          chatId: input.chatId,
          threadId: input.threadId,
          isGroup: input.isGroup,
        });
        existing = undefined;
      }
      if (existing && this.isLive(existing)) {
        this.promoteTargetToGroup(existing, isGroup);
        this.countTurn(channelName, existing);
        this.leaseSession(existing);
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
          // A restore reservation can hand back a session whose persisted
          // counters are already at the bound. No lease or count is taken
          // yet and the reservation is already cleared, so re-entering the
          // loop routes this message through the rotation gate above.
          if (this.shouldRotate(channelName, sessionId)) {
            continue;
          }
          this.promoteTargetToGroup(sessionId, isGroup);
          this.countTurn(channelName, sessionId);
          this.leaseSession(sessionId);
          return sessionId;
        } catch (error) {
          if (creating.invalidationError) {
            // A rotation or reload can hand the key to a successor operation
            // while this waiter is parked; route against the successor
            // instead of failing the message. Without a successor the
            // invalidation was a deliberate rejection (e.g. removeSession),
            // which stays terminal.
            if (this.creatingSessions.has(key) || this.toSession.has(key)) {
              failedWaits++;
              if (failedWaits > 3) throw creating.invalidationError;
              continue;
            }
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
        this.leaseSession(sessionId);
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
      this.seedRotationCounters(input.channelName, sessionId);
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
          // The reload is the same conversation under a new ID, so its age and
          // turn count carry over — otherwise reloading would reset the bound.
          const turns = this.toTurns.get(savedSessionId);
          const startedAt = this.toStartedAt.get(savedSessionId);
          this.deleteByKey(key);
          this.toSession.set(key, loadedSessionId);
          if (target) this.toTarget.set(loadedSessionId, target);
          this.toCwd.set(loadedSessionId, savedCwd);
          if (turns !== undefined) this.toTurns.set(loadedSessionId, turns);
          if (startedAt !== undefined) {
            this.toStartedAt.set(loadedSessionId, startedAt);
          }
          // Age-only channels get no countTurn persist below, so this is
          // their only writer of the new ID and carried counters; maxTurns
          // channels persist again in countTurn immediately below, and this
          // write would be fully subsumed by it.
          if (
            this.channelRotations.get(input.channelName)?.maxTurns === undefined
          ) {
            this.persist();
          }
        }
        this.countTurn(input.channelName, loadedSessionId);
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
          this.seedRotationCounters(input.channelName, replacement);
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

  getSessionCwd(sessionId: string): string | undefined {
    return this.toCwd.get(sessionId);
  }

  async createManagedSession(
    target: SessionTarget,
    cwd: string,
  ): Promise<string> {
    const loadWindow = this.beginSessionLoad();
    const lifecycleGeneration = this.lifecycleGeneration;
    const bridge = this.bridge;
    const bindingToken = {};
    try {
      let lastDeadSessionId: string | undefined;
      for (let attempt = 0; attempt < 2; attempt++) {
        const sessionId = await bridge.newSession(
          cwd,
          {
            ...this.sessionOptions(target.channelName),
            sourceId: target.channelName,
          },
          bindingToken,
        );
        if (
          lifecycleGeneration !== this.lifecycleGeneration ||
          bridge !== this.bridge
        ) {
          this.scheduleManagedDiscard(bridge, sessionId, bindingToken);
          throw new Error('Managed session creation was invalidated');
        }
        if (typeof sessionId !== 'string' || sessionId.length === 0) {
          throw new Error('Invalid session ID from bridge');
        }
        if (loadWindow.delete(sessionId)) {
          lastDeadSessionId = sessionId;
          await bridge.discardSession?.(sessionId, bindingToken);
          continue;
        }
        this.toTarget.set(sessionId, target);
        this.toCwd.set(sessionId, cwd);
        this.liveSessionIds.add(sessionId);
        return sessionId;
      }
      throw new Error(
        `Managed session ${lastDeadSessionId ?? 'unknown'} died before creation completed`,
      );
    } finally {
      this.endSessionLoad(loadWindow);
    }
  }

  async loadManagedSession(
    sessionId: string,
    target: SessionTarget,
    cwd: string,
  ): Promise<{ loaded: boolean }> {
    if (this.liveSessionIds.has(sessionId)) {
      this.toTarget.set(sessionId, target);
      this.toCwd.set(sessionId, cwd);
      return { loaded: false };
    }

    const loadWindow = this.beginSessionLoad();
    const lifecycleGeneration = this.lifecycleGeneration;
    const bridge = this.bridge;
    const bindingToken = {};
    let loadedSessionId: string | undefined;
    try {
      loadedSessionId = await bridge.loadSession(
        sessionId,
        cwd,
        this.sessionOptions(target.channelName),
        bindingToken,
      );
      if (
        lifecycleGeneration !== this.lifecycleGeneration ||
        bridge !== this.bridge
      ) {
        this.scheduleManagedDiscard(bridge, loadedSessionId, bindingToken);
        loadedSessionId = undefined;
        throw new Error('Managed session load was invalidated');
      }
      if (loadedSessionId !== sessionId) {
        const unexpectedSessionId = loadedSessionId;
        await bridge.discardSession?.(unexpectedSessionId, bindingToken);
        loadedSessionId = undefined;
        throw new Error(
          `Bridge returned session ${unexpectedSessionId || 'unknown'} while loading ${sessionId}`,
        );
      }
      if (loadWindow.delete(sessionId)) {
        throw new Error(
          `Managed session ${sessionId} died before loading completed`,
        );
      }
      this.toTarget.set(sessionId, target);
      this.toCwd.set(sessionId, cwd);
      this.liveSessionIds.add(sessionId);
      return { loaded: true };
    } catch (error) {
      if (loadedSessionId) {
        await bridge
          .discardSession?.(loadedSessionId, bindingToken)
          .catch(() => undefined);
      }
      throw error;
    } finally {
      this.endSessionLoad(loadWindow);
    }
  }

  activateManagedSession(
    sessionId: string,
    target: SessionTarget,
    cwd: string,
  ): void {
    const key = this.routingKey(
      target.channelName,
      target.senderId,
      target.chatId,
      target.threadId,
    );
    if (this.toSession.get(key) === sessionId) return;
    this.invalidateRouteOperation(key);
    this.toSession.set(key, sessionId);
    this.toTarget.set(sessionId, target);
    this.toCwd.set(sessionId, cwd);
    this.persist();
  }

  forgetManagedSession(sessionId: string): void {
    let changed = false;
    for (const [key, mappedSessionId] of this.toSession) {
      if (mappedSessionId !== sessionId) continue;
      this.invalidateRouteOperation(key);
      this.toSession.delete(key);
      changed = true;
    }
    changed = this.toTarget.delete(sessionId) || changed;
    changed = this.toCwd.delete(sessionId) || changed;
    changed = this.liveSessionIds.delete(sessionId) || changed;
    if (changed) this.persist();
  }

  async detachManagedSession(sessionId: string): Promise<void> {
    try {
      if (this.liveSessionIds.has(sessionId)) {
        if (!this.bridge.discardSession) {
          throw new Error('Managed session detach is not supported');
        }
        await this.bridge.discardSession(sessionId);
      }
    } finally {
      this.forgetManagedSession(sessionId);
    }
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
      this.tombstoneSuspendedKey(key);
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
          this.tombstoneSuspendedKey(k);
        }
      }
      for (const [key, operation] of [...this.creatingSessions]) {
        if (
          operation.target.channelName === channelName &&
          operation.target.senderId === senderId
        ) {
          this.invalidateRouteOperation(key);
          this.tombstoneSuspendedKey(key);
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
        this.tombstoneSuspendedKey(key);
        removed = true;
      }
    }
    if (this.toTarget.delete(sessionId)) {
      removed = true;
    }
    if (this.toCwd.delete(sessionId)) {
      removed = true;
    }
    this.toTurns.delete(sessionId);
    this.toStartedAt.delete(sessionId);
    this.sessionRoutingLeases.delete(sessionId);
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
    this.toTurns.delete(sessionId);
    this.toStartedAt.delete(sessionId);
    this.sessionRoutingLeases.delete(sessionId);
    this.rotationDeltas.delete(sessionId);
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
    if (this.recoveryMode !== 'lazy') {
      throw new Error('restoreRoutes requires lazy recovery mode');
    }
    const persisted = this.readPersistedEntries();
    if (!persisted) return { restored: 0, dropped: 0 };
    this.dispose();
    let restored = 0;
    for (const [key, entry] of Object.entries(persisted.entries)) {
      this.toSession.set(key, entry.sessionId);
      this.toTarget.set(entry.sessionId, entry.target);
      this.toCwd.set(entry.sessionId, entry.cwd);
      this.restoreRotationState(entry.sessionId, entry);
      restored++;
    }
    if (persisted.dropped > 0) this.persist();
    return { restored, dropped: persisted.dropped };
  }

  /**
   * Restore session mappings from a previous bridge.
   * Called after bridge restart — attempts loadSession for each saved mapping.
   * Failed loads are dropped (new session on next message). Overlapping
   * restores (e.g. a reconnect READY mid cold-start restore) are safe:
   * persistence stays suspended until the last one finishes, and rotation
   * state already live in memory survives the later restore's reservation
   * pass.
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
      {
        reservation: SessionReservation;
        operation: SessionOperation;
        liveSessionId?: string;
        liveRotation?: {
          turns?: number;
          startedAt?: number;
          leases?: number;
        };
      }
    >();

    for (const key of persisted.droppedKeys) {
      this.deleteByKey(key);
    }

    // Released waiters route (and persist) while this loop still restores
    // later keys; suspend persistence so a store holding only the restored
    // prefix cannot become durable. Restores can overlap (a reconnect READY
    // can fire while a cold-start restore still runs), so suspension is a
    // depth and only the last restore to finish flushes the whole store.
    this.persistSuspendDepth++;
    let completed = false;
    try {
      // Reserve every persisted key up front so inbound messages during restart
      // wait for restore instead of returning stale IDs or creating duplicates.
      for (const key of Object.keys(entries)) {
        // A route removed while persistence stays suspended only reaches
        // disk at the last restore's flush; until then this restore reads
        // the stale pre-deletion snapshot and must not resurrect the key.
        if (this.suspendedDeletionKeys.has(key)) continue;
        const liveSessionId = this.toSession.get(key);
        // A route already back in memory can have routed messages newer than
        // the persisted snapshot (persists stay suspended across the restore
        // window); carry its rotation state across the wipe so the reload
        // below cannot rewind it.
        const liveRotation = liveSessionId
          ? {
              turns: this.toTurns.get(liveSessionId),
              startedAt: this.toStartedAt.get(liveSessionId),
              leases: this.sessionRoutingLeases.get(liveSessionId),
            }
          : undefined;
        this.deleteByKey(key);
        if (liveSessionId) {
          this.rotationDeltas.set(liveSessionId, { turns: 0, leases: 0 });
        }
        const reservation = this.createSessionReservation();
        reservation.promise.catch(() => undefined);
        const operation = this.createSessionOperation(
          key,
          entries[key]!.target,
          () => reservation.promise,
        );
        operation.promise.catch(() => undefined);
        this.creatingSessions.set(key, operation);
        reservations.set(key, {
          reservation,
          operation,
          liveSessionId,
          liveRotation,
        });
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
            this.liveSessionIds.add(sessionId);
            this.restoreRotationState(sessionId, entry);
            if (reserved.liveRotation && reserved.liveSessionId) {
              this.carryLiveRotationState(
                sessionId,
                reserved.liveRotation,
                reserved.liveSessionId,
              );
            }
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
            if (reserved.liveSessionId) {
              this.rotationDeltas.delete(reserved.liveSessionId);
            }
            // The drop must reach disk even when an overlapping restore
            // flushes last: the last finisher only reads its own `changed`.
            this.persistRequestedWhileSuspended = true;
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
      completed = true;
    } finally {
      this.persistSuspendDepth--;
      // Update persist file to only include successfully restored sessions.
      // A persist requested while suspended counts: the mid-restore write
      // was skipped to keep a truncated store from becoming durable. An
      // earlier finisher leaves the suspension and the pending flush to the
      // restore still running — flushing sooner would persist the other
      // restore's partial prefix.
      if (
        completed &&
        this.persistSuspendDepth === 0 &&
        (changed || this.persistRequestedWhileSuspended) &&
        restoreGeneration === this.lifecycleGeneration
      ) {
        this.persistRequestedWhileSuspended = false;
        this.suspendedDeletionKeys.clear();
        this.persist();
      }
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
    this.toTurns.clear();
    this.toStartedAt.clear();
    this.sessionRoutingLeases.clear();
    this.rotationDeltas.clear();
    this.creatingSessions.clear();
    this.sessionLoadWindows.clear();
    this.liveSessionIds.clear();
    this.routeTokens.clear();
    this.suspendedDeletionKeys.clear();
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

  /**
   * Seed rotation counters for a freshly created session. The creating
   * message is turn one, so a turns-bound channel starts at 1 and the
   * creation persist doubles as its count — no second write per new session.
   */
  private seedRotationCounters(channelName: string, sessionId: string): void {
    const rotation = this.channelRotations.get(channelName);
    if (!rotation) return;
    if (rotation.maxTurns !== undefined) this.toTurns.set(sessionId, 1);
    if (rotation.maxAgeHours !== undefined) {
      this.toStartedAt.set(sessionId, Date.now());
    }
  }

  /** Carry a persisted entry's rotation counters back into memory. */
  private restoreRotationState(sessionId: string, entry: PersistedEntry): void {
    if (entry.turns !== undefined) this.toTurns.set(sessionId, entry.turns);
    if (entry.startedAt !== undefined) {
      this.toStartedAt.set(sessionId, entry.startedAt);
    }
  }

  /**
   * Re-apply the rotation state a route had live in memory when a restore
   * reserved it: routed messages made it newer than the persisted snapshot
   * the restore reads, so it wins over restoreRotationState's seed. Writes
   * that landed between the reservation's wipe and this carry waited in
   * rotationDeltas; net them so a mid-restore release or uncount cannot
   * resurface as a phantom lease or count. Zero turns stay absent, matching
   * uncountTurn's representation.
   */
  private carryLiveRotationState(
    sessionId: string,
    liveRotation: {
      turns?: number;
      startedAt?: number;
      leases?: number;
    },
    wipedSessionId: string,
  ): void {
    const delta = this.rotationDeltas.get(wipedSessionId);
    this.rotationDeltas.delete(wipedSessionId);
    const turns = (liveRotation.turns ?? 0) + (delta?.turns ?? 0);
    if (turns > 0) {
      this.toTurns.set(sessionId, turns);
    } else {
      this.toTurns.delete(sessionId);
    }
    if (liveRotation.startedAt !== undefined) {
      this.toStartedAt.set(sessionId, liveRotation.startedAt);
    }
    const leases = (liveRotation.leases ?? 0) + (delta?.leases ?? 0);
    if (leases > 0) {
      this.sessionRoutingLeases.set(sessionId, leases);
    } else {
      this.sessionRoutingLeases.delete(sessionId);
    }
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
      (entry['turns'] === undefined || isValidTurnCount(entry['turns'])) &&
      (entry['startedAt'] === undefined ||
        isValidRotationBound(entry['startedAt'])) &&
      typeof typedTarget['channelName'] === 'string' &&
      typeof typedTarget['senderId'] === 'string' &&
      typeof typedTarget['chatId'] === 'string' &&
      (typedTarget['threadId'] === undefined ||
        typeof typedTarget['threadId'] === 'string') &&
      (typedTarget['isGroup'] === undefined ||
        typeof typedTarget['isGroup'] === 'boolean')
    );
  }

  /**
   * Record a route removed while persistence is suspended mid-restore, and
   * ask the last restore's flush to write the removal out. Without the
   * record an overlapping restore reading the stale snapshot would re-add
   * the route and the flush would persist it again.
   */
  private tombstoneSuspendedKey(key: string): void {
    if (this.persistSuspendDepth === 0) return;
    this.suspendedDeletionKeys.add(key);
    this.persist();
  }

  private persist(): void {
    if (!this.persistPath) return;
    if (this.persistSuspendDepth > 0) {
      // Mid-restore the store holds only the restored prefix; let
      // restoreSessions() flush once the store is whole again.
      this.persistRequestedWhileSuspended = true;
      return;
    }

    const data: Record<string, PersistedEntry> = {};
    for (const [key, sessionId] of this.toSession) {
      const target = this.toTarget.get(sessionId);
      if (!target) continue;
      const turns = this.toTurns.get(sessionId);
      const startedAt = this.toStartedAt.get(sessionId);
      data[key] = {
        sessionId,
        target,
        cwd: this.toCwd.get(sessionId) ?? this.defaultCwd,
        ...(turns !== undefined ? { turns } : {}),
        ...(startedAt !== undefined ? { startedAt } : {}),
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
    options: ChannelAgentBridgeSessionOptions,
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

  private scheduleManagedDiscard(
    bridge: ChannelAgentBridge,
    sessionId: string,
    bindingToken: object,
  ): void {
    try {
      void bridge
        .discardSession?.(sessionId, bindingToken)
        .catch(() => undefined);
    } catch {
      // Best-effort cleanup must not block bridge recovery.
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

/**
 * The single definition of a valid rotation bound, shared by parse-time
 * validation (fail loudly) and the router (defensively drop). A bound is only
 * meaningful when positive and finite; anything else (0, negative, NaN, a stray
 * string from a hand-edited config) is not a bound.
 */
export function isValidRotationBound(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value > 0;
}

/**
 * The single definition of a valid turn-count value, shared by parse-time
 * validation, the settings store, and the persisted-entry gate: turns are
 * whole messages, so a bound (or a restored counter) must be a positive
 * integer. Fractional values would rotate from the second message on (0 < x
 * <= 1) or silently act as their ceiling (x > 1).
 */
export function isValidTurnCount(value: unknown): value is number {
  return typeof value === 'number' && Number.isInteger(value) && value > 0;
}

function normalizeRotationBound(value: unknown): number | undefined {
  return isValidRotationBound(value) ? value : undefined;
}
