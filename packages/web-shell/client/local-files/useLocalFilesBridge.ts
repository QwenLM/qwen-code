/**
 * 4d — React wiring for the local-files bridge.
 *
 * Owns the whole lifecycle the design doc describes: probe the context, restore
 * a stored grant silently when the browser allows it, otherwise wait for a real
 * click, then run {@link LocalFilesBridge} bound to the active session.
 *
 * Three rules here come from measurement, not preference:
 *  - `requestPermission()` consumes user activation, so a `prompt` state can
 *    only be cleared from inside a click handler — never from an effect.
 *  - Session-scoped registration emits no workspace event, so nothing outside
 *    this hook will report that the bridge came or went; this status is the
 *    only source of truth.
 *  - Registration needs a live session AND a live ACP channel, so a granted
 *    handle is kept even when no session exists yet, and the bridge starts the
 *    moment one appears.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  LocalFilesBridge,
  openBrowserSocket,
  withOwnerLock,
  type AcpWorkspaceSelector,
  type LocalFilesBridgeState,
  type LockManagerLike,
  type OpenSocket,
} from './bridge-client.js';
import {
  detectLocalFilesCapability,
  type LocalFilesBlocker,
  type LocalFilesWindowLike,
} from './capabilities.js';
import {
  createDirectoryHandleStore,
  type DirectoryHandleStore,
} from './directory-handle-store.js';
import { LocalDirectory } from './local-directory.js';
import { LocalFilesMcpServer } from './mcp-server.js';
import {
  ensureReadwritePermission,
  pickDirectoryHandle,
} from './pick-directory.js';

export type LocalFilesPhase =
  | 'unavailable'
  | 'needs-session'
  | 'idle'
  | 'needs-gesture'
  | 'held-elsewhere'
  | 'connecting'
  | 'registering'
  | 'connected'
  | 'reconnecting'
  | 'failed';

export interface LocalFilesStatus {
  phase: LocalFilesPhase;
  /** Set when `phase` is 'unavailable'. */
  blocker: LocalFilesBlocker;
  /** Granted directory name, once known. */
  rootName?: string;
  toolCount?: number;
  /** Reason for 'failed' / 'reconnecting', or a picker error. */
  message?: string;
}

const IDLE: LocalFilesStatus = { phase: 'idle', blocker: null };

/** Phases in which a bound bridge is live and correctly routed. */
const LIVE_BRIDGE_PHASES: ReadonlySet<LocalFilesBridgeState['phase']> = new Set(
  ['connecting', 'registering', 'connected', 'reconnecting'],
);

function selectorKeyOf(selector?: { kind: string; value: string }): string {
  return selector === undefined ? '' : `${selector.kind}:${selector.value}`;
}

export interface UseLocalFilesBridgeOptions {
  /** The session the bridge binds to; undefined until one exists. */
  sessionId: string | undefined;
  baseUrl: string;
  token?: string;
  /** Re-warm the ACP child before a registration retry. */
  rewarm?: () => Promise<void>;
  openSocket?: OpenSocket;
  locks?: LockManagerLike | null;
  store?: DirectoryHandleStore | null;
  win?: LocalFilesWindowLike;
  /** Test seam for the bridge's backoff delays. */
  delay?: (ms: number) => Promise<void>;
  /** The session's workspace when not the primary one; see the bridge. */
  workspaceSelector?: AcpWorkspaceSelector;
  /**
   * Deployment-level blocker the browser probe cannot see (the session's
   * workspace is untrusted or live): withholds the bridge entirely.
   */
  withheldBlocker?: LocalFilesBlocker;
}

function defaultStore(): DirectoryHandleStore | null {
  return typeof indexedDB === 'undefined'
    ? null
    : createDirectoryHandleStore(indexedDB);
}

function defaultWindow(): LocalFilesWindowLike {
  return typeof window === 'undefined'
    ? { isSecureContext: false, self: {}, top: {} }
    : window;
}

function defaultLocks(): LockManagerLike | null {
  return typeof navigator === 'undefined' ? null : (navigator.locks ?? null);
}

function phaseFromBridge(
  state: LocalFilesBridgeState,
  rootName: string | undefined,
): LocalFilesStatus {
  switch (state.phase) {
    case 'held-elsewhere':
      return { phase: 'held-elsewhere', blocker: null, rootName };
    case 'connecting':
      return { phase: 'connecting', blocker: null, rootName };
    case 'registering':
      return { phase: 'registering', blocker: null, rootName };
    case 'connected':
      return {
        phase: 'connected',
        blocker: null,
        rootName,
        toolCount: state.toolCount,
      };
    case 'reconnecting':
      return {
        phase: 'reconnecting',
        blocker: null,
        rootName,
        message: state.reason,
      };
    case 'failed':
      return {
        phase: 'failed',
        blocker: null,
        rootName,
        message: state.message,
      };
    default:
      return { phase: 'idle', blocker: null, rootName };
  }
}

export function useLocalFilesBridge(options: UseLocalFilesBridgeOptions) {
  const { sessionId } = options;
  const win = options.win ?? defaultWindow();
  const store = useMemo(
    () => (options.store === undefined ? defaultStore() : options.store),
    // Resolved once per mount: the injected store is a stable test seam, and
    // re-creating the real one per render would reopen IndexedDB constantly.
    // eslint-disable-next-line react-hooks/exhaustive-deps -- per-mount seam, not a stale copy
    [],
  );
  const capability = useMemo(() => {
    const detected = detectLocalFilesCapability(win);
    // A browser-level probe verdict outranks a deployment-level withheld
    // reason: its copy carries the panel's only recovery affordance (open in
    // a new tab), and on every first paint capabilities are still undefined,
    // so the opposite order would mask cross-origin frames with a transient
    // "resolving" line.
    return {
      ...detected,
      blocker: detected.blocker ?? options.withheldBlocker ?? null,
    };
  }, [win, options.withheldBlocker]);

  const [status, setStatus] = useState<LocalFilesStatus>(() =>
    capability.blocker !== null
      ? { phase: 'unavailable', blocker: capability.blocker }
      : IDLE,
  );

  // Every per-render value the bridge needs is read through this ref, so the
  // callbacks below keep a stable identity. An inline `rewarm` from the caller
  // would otherwise change them on every render and re-run the mount effect.
  const optionsRef = useRef(options);
  optionsRef.current = options;
  // Mirrored like optionsRef so startBridge — the single funnel every
  // continuation (restore, connect, rebind) ends in — fails closed on the
  // LIVE blocker: a withheldBlocker landing while a continuation is parked
  // must register nothing, not just stop a bridge that already exists.
  const capabilityRef = useRef(capability);
  capabilityRef.current = capability;
  // Mirrored so disconnect() can reconcile its optimistic terminal status
  // against what the panel showed before the click.
  const statusRef = useRef(status);
  statusRef.current = status;
  const bridgeRef = useRef<LocalFilesBridge | undefined>(undefined);
  /**
   * The session the current bridge bound to, stamped alongside bridgeRef so
   * the rebind effect can tell a live, correctly-routed bridge from one a
   * session switch left behind.
   */
  const bridgeSessionRef = useRef<string | undefined>(undefined);
  const bridgeSelectorKeyRef = useRef<string>('');
  const bridgeHandleNameRef = useRef<string | undefined>(undefined);
  const handleRef = useRef<FileSystemDirectoryHandle | undefined>(undefined);
  /**
   * True once this mount's current bridge reached a phase that only runs
   * under the owner lock. Disconnect reads it before stopping the bridge: an
   * owned run held the lock exclusively, so after stop() no peer can hold it
   * and the revoke needs no arbitration — while a mount that never owned a
   * run must ask the lock manager before touching the origin-global record.
   */
  const ownedRunRef = useRef(false);
  /**
   * Generation of the connect() currently in flight, so disconnect() can tell
   * a connect it already invalidated (which can never write the record) from
   * one started afterwards (which can).
   */
  const connectGenerationRef = useRef(0);
  /**
   * True once the in-flight connect has persisted its pick or stored
   * handle. Both save sites stamp save()'s outcome, never the attempt: a
   * soft-failed save wrote nothing, so the record is not this connect's
   * own grant and must not veto a pending revoke (the clear() sibling in
   * disconnect honours the same boolean). `?? true`: with no store there
   * is nothing to veto over.
   */
  const connectSavedRef = useRef(false);
  /**
   * The name the in-flight connect loaded or picked, stamped at the save
   * sites and reset at every connect's start. A soft-failed save writes
   * nothing, but the stored-handle arm still binds a bridge to the record's
   * own handle: revoke() reads this to veto a deferred clear of the very
   * record that live bridge serves, while a picker connect that bound a
   * DIFFERENT directory leaves the record to the revoke.
   */
  const connectBoundNameRef = useRef<string | undefined>(undefined);
  /**
   * True once the in-flight connect committed a panel status of its own,
   * so a revoke reconcile handed to its finally restores the pre-click
   * panel only when the connect wrote nothing (a dismissed picker) —
   * never over the connect's own needs-gesture/failed/unavailable write.
   */
  const connectWroteStatusRef = useRef(false);
  /**
   * A revoke — or just its panel reconcile — handed to a connect's finally
   * because that connect may still write.
   */
  const pendingRevokeRef = useRef<(() => Promise<boolean>) | undefined>(
    undefined,
  );
  /** Set when the last revoke deferred instead of deciding, so disconnect does not reconcile over an undecided outcome. */
  const deferredRevokeRef = useRef(false);
  /**
   * Bumped by `disconnect()` and by unmount. Every await in `connect()` and
   * `restore()` re-checks it, because both can be waiting on a native picker
   * for tens of seconds: without this a connect that outlives the view would
   * start a bridge nobody can stop, holding the user's directory grant open.
   */
  const generationRef = useRef(0);
  /**
   * Bumped only by `disconnect()`: the revoke arbitration's cancellation
   * epoch. Unlike `generationRef` an unmount does not bump it, so a view
   * disappearing mid-arbitration cannot silently cancel a revoke the user
   * asked for — only a newer disconnect supersedes an older pending one.
   */
  const revokeGenerationRef = useRef(0);
  const connectInFlightRef = useRef(false);
  /**
   * Set by disconnect(), cleared by connect(). restore() re-attaches from
   * the store, not from handleRef, so clearing the in-memory handle alone
   * cannot stop a later blocker flip from resurrecting a bridge over a
   * record that deliberately survived a declined revoke.
   */
  const detachedRef = useRef(false);
  /**
   * Set when a revoke found the origin-global record holding a peer's grant
   * instead of the one this mount named. While it stands, the revoke guard
   * refuses even a name-less click and no status write names a store-loaded
   * record — the Disconnect a name renders could never clear it. Cleared
   * when this mount binds the record's own handle (restore() or connect()'s
   * stored-handle arm) or saves its own fresh pick over the record.
   */
  const foreignRecordRef = useRef(false);

  const stopBridge = useCallback(() => {
    const bridge = bridgeRef.current;
    bridgeRef.current = undefined;
    // The run ends here (or has already ended): the ownership latch must not
    // outlive it, or a later disconnect would skip arbitration over a lock
    // this mount no longer holds while a peer's live bridge depends on the
    // same origin-global record.
    ownedRunRef.current = false;
    bridge?.stop();
  }, []);

  /**
   * The one gate every store-derived name passes through: while the foreign
   * latch stands, no status write may name the record, because the
   * Disconnect a name renders could never clear it (the revoke guard below
   * vetoes). Binding the record's own handle re-arms naming — see the clear
   * sites in restore() and connect().
   */
  const recordRootName = useCallback(
    (name: string | undefined): string | undefined =>
      foreignRecordRef.current ? undefined : name,
    [],
  );

  const startBridge = useCallback(
    (handle: FileSystemDirectoryHandle) => {
      // A transient verdict (a resolving blip that clears) re-runs restore
      // and the rebind effect; tearing down a live, correctly-routed bridge
      // for it would close the socket and unregister the MCP server mid-
      // turn. Only a real session, selector, or handle change rebuilds; a
      // dead bridge (failed/held-elsewhere) is not exempt, so a withheld
      // verdict still reaches the panel through the blocker path.
      const bound = bridgeRef.current;
      if (
        bound !== undefined &&
        LIVE_BRIDGE_PHASES.has(bound.getState().phase) &&
        bridgeSessionRef.current === optionsRef.current.sessionId &&
        bridgeSelectorKeyRef.current ===
          selectorKeyOf(optionsRef.current.workspaceSelector) &&
        bridgeHandleNameRef.current === handle.name
      ) {
        return;
      }
      stopBridge();
      // stopBridge() first: stopping afterwards would let the 'stopped' ->
      // idle mapping overwrite the unavailable status set here.
      const blocker = capabilityRef.current.blocker;
      if (blocker !== null) {
        // Name the grant: the panel's Disconnect — the only store.clear()
        // caller — must stay reachable over a persisted handle.
        setStatus({ phase: 'unavailable', blocker, rootName: handle.name });
        return;
      }
      // Remember the grant even when we cannot use it yet: a session may not
      // exist at this moment, and losing the handle here would leave the
      // rebind effect with nothing to start.
      handleRef.current = handle;
      const targetSession = optionsRef.current.sessionId;
      if (targetSession === undefined) {
        setStatus({
          phase: 'needs-session',
          blocker: null,
          rootName: handle.name,
        });
        return;
      }
      const current = optionsRef.current;
      ownedRunRef.current = false;
      const bridge = new LocalFilesBridge({
        baseUrl: current.baseUrl,
        sessionId: targetSession,
        server: new LocalFilesMcpServer(new LocalDirectory(handle)),
        openSocket: current.openSocket ?? openBrowserSocket,
        locks: current.locks === undefined ? defaultLocks() : current.locks,
        ...(current.token === undefined ? {} : { token: current.token }),
        ...(current.rewarm === undefined ? {} : { rewarm: current.rewarm }),
        ...(current.workspaceSelector === undefined
          ? {}
          : { workspaceSelector: current.workspaceSelector }),
        ...(current.delay === undefined ? {} : { delay: current.delay }),
        onState: (state) => {
          if (
            state.phase === 'connecting' ||
            state.phase === 'registering' ||
            state.phase === 'connected' ||
            state.phase === 'reconnecting'
          ) {
            ownedRunRef.current = true;
          }
          // A run that ended on its own released the lock without this mount
          // asking: the latch must die with it, not with the next stop.
          if (state.phase === 'failed' || state.phase === 'held-elsewhere') {
            ownedRunRef.current = false;
          }
          setStatus(phaseFromBridge(state, handle.name));
        },
      });
      bridgeRef.current = bridge;
      bridgeSessionRef.current = targetSession;
      bridgeSelectorKeyRef.current = selectorKeyOf(current.workspaceSelector);
      bridgeHandleNameRef.current = handle.name;
      void bridge.start();
    },
    [stopBridge],
  );

  /**
   * Restore a stored grant without a gesture, so a reload reconnects silently
   * when the browser still considers the permission granted.
   */
  const restore = useCallback(async () => {
    if (capability.blocker !== null) {
      // A withheld entry still owes the user a release path: name the stored
      // grant so the panel's Disconnect — the only store.clear() caller —
      // renders, without ever reaching startBridge.
      const generation = generationRef.current;
      const persisted = store ? await store.load() : undefined;
      if (generationRef.current !== generation || !persisted) return;
      setStatus((prev) => {
        if (prev.phase !== 'unavailable') return prev;
        const rootName = recordRootName(persisted.name);
        return rootName === undefined
          ? { phase: 'unavailable', blocker: prev.blocker }
          : { ...prev, rootName };
      });
      return;
    }
    if (!store) return;
    const generation = generationRef.current;
    const stored = await store.load();
    if (!stored || generationRef.current !== generation) return;
    const permission = await ensureReadwritePermission(stored);
    if (generationRef.current !== generation) return;
    if (permission.state !== 'granted') {
      // Deliberately NOT stored in `handleRef`: the session-rebind effect
      // starts a bridge from whatever it holds, and an ungranted handle would
      // register tools whose every call the browser then rejects, while the
      // UI reports a connected bridge. `connect()` re-reads the store instead.
      // Needs a real click; an effect cannot supply the activation.
      const rootName = recordRootName(stored.name);
      setStatus({
        phase: 'needs-gesture',
        blocker: null,
        ...(rootName === undefined ? {} : { rootName }),
      });
      return;
    }
    if (detachedRef.current) {
      // disconnect() latched this mount off and the record survived a
      // declined revoke: keep naming the grant so the panel's Disconnect —
      // the only store.clear() caller — stays reachable, but never
      // re-attach a bridge behind the user's click. The live blocker read
      // matches startBridge: a withhold landing mid-restore must not be
      // clobbered by this parked continuation.
      const blocker = capabilityRef.current.blocker;
      const rootName = recordRootName(stored.name);
      setStatus(
        blocker !== null
          ? {
              phase: 'unavailable',
              blocker,
              ...(rootName === undefined ? {} : { rootName }),
            }
          : { ...IDLE, ...(rootName === undefined ? {} : { rootName }) },
      );
      return;
    }
    // Binding the record's own handle: from here the record is this mount's
    // grant again, so the foreign latch must not veto its later revoke.
    foreignRecordRef.current = false;
    startBridge(stored);
  }, [capability.blocker, recordRootName, startBridge, store]);

  useEffect(() => {
    void restore();
  }, [restore]);

  // A session-scoped server belongs to exactly one session, so switching
  // sessions means registering against the new one. The workspace selector is
  // part of that identity: capabilities arrive asynchronously, and a selector
  // that resolves after the bridge started must rebind it onto the mount that
  // owns the session.
  const selectorKey = options.workspaceSelector
    ? `${options.workspaceSelector.kind}:${options.workspaceSelector.value}`
    : '';
  useEffect(() => {
    // A blocker that activates late (capabilities resolving an ineligible
    // workspace after the bridge started) must stop the running bridge and
    // withhold, instead of letting a rebind dial the primary mount for a
    // workspace the deployment declared ineligible. stopBridge() runs before
    // setStatus because stop() emits 'stopped' (mapped to idle).
    if (capability.blocker !== null) {
      // A transient verdict (the snapshot or the registry entry has not
      // landed yet) must not tear down a bridge still bound to this
      // session: before the connect the same blip produced no blocker at
      // all and left the bridge running. Hard verdicts — ineligible,
      // unsupported — still stop it, as does a real session switch.
      if (
        capability.blocker === 'workspace-resolving' &&
        bridgeRef.current !== undefined &&
        bridgeSessionRef.current === sessionId
      ) {
        return;
      }
      stopBridge();
      // Preserve a name restore() supplied: dropping it here would hide the
      // panel's Disconnect — the only revoke path — over a stored grant.
      setStatus((prev) => {
        const rootName = recordRootName(prev.rootName);
        return {
          phase: 'unavailable',
          blocker: capability.blocker,
          ...(rootName === undefined ? {} : { rootName }),
        };
      });
      return;
    }
    const handle = handleRef.current;
    if (handle === undefined) {
      // Clear the one latch this hook can leave behind: an unavailable
      // status written while a blocker was live must return to idle once the
      // blocker clears, or the panel renders no Connect affordance for the
      // life of the mount. needs-gesture must survive (its handle is not in
      // handleRef either, but its phase is not unavailable).
      setStatus((prev) => (prev.phase === 'unavailable' ? IDLE : prev));
      return;
    }
    // Rebind preconditions, in order: the store must still hold the grant (a
    // peer tab's disconnect clears it with no signal reaching this tab, and
    // the browser permission outlives the store), and the permission must
    // still be granted (a revocation after the original connect would
    // otherwise re-register tools whose every call the browser rejects).
    // An effect cannot supply activation, so never request.
    let cancelled = false;
    const generation = generationRef.current;
    const rebind = async () => {
      if (store) {
        const persisted = await store.load();
        if (cancelled || generationRef.current !== generation) return;
        if (!persisted) {
          handleRef.current = undefined;
          stopBridge();
          setStatus(IDLE);
          return;
        }
      }
      const permission = await ensureReadwritePermission(handle);
      // A disconnect that landed while these awaits were in flight must win:
      // without this the continuation would resurrect the bridge behind it.
      if (cancelled || generationRef.current !== generation) return;
      if (permission.state !== 'granted') {
        // Stop the previous session's bridge first: stop() emits 'stopped'
        // (mapped to idle), so the needs-gesture status must come after it.
        stopBridge();
        setStatus({
          phase: 'needs-gesture',
          blocker: null,
          rootName: handle.name,
        });
        return;
      }
      startBridge(handle);
    };
    void rebind();
    return () => {
      cancelled = true;
    };
  }, [
    sessionId,
    selectorKey,
    startBridge,
    stopBridge,
    store,
    capability.blocker,
    recordRootName,
  ]);

  useEffect(
    () => () => {
      generationRef.current += 1;
      stopBridge();
    },
    [stopBridge],
  );

  /** Must be called from a real click handler (it may open a native picker). */
  const connect = useCallback(async () => {
    if (capability.blocker !== null) {
      // Preserve a name restore() supplied: the revoke path must stay
      // reachable over a stored grant even while the entry is withheld.
      setStatus((prev) => {
        const rootName = recordRootName(prev.rootName);
        return {
          phase: 'unavailable',
          blocker: capability.blocker,
          ...(rootName === undefined ? {} : { rootName }),
        };
      });
      return;
    }
    // One picker at a time: a double click would otherwise open two native
    // dialogs and race two bridges for the same grant.
    if (connectInFlightRef.current) return;
    connectInFlightRef.current = true;
    const generation = generationRef.current;
    connectGenerationRef.current = generation;
    connectSavedRef.current = false;
    connectBoundNameRef.current = undefined;
    connectWroteStatusRef.current = false;
    const stale = () => generationRef.current !== generation;
    try {
      // A peer tab's disconnect clears the store without signaling this tab:
      // an in-memory handle the store no longer holds must not reconnect.
      if (store && handleRef.current) {
        const persisted = await store.load();
        if (stale()) return;
        if (!persisted) handleRef.current = undefined;
      }
      // A stored handle only needs its permission back, not a new picker run.
      const stored = handleRef.current ?? (await store?.load());
      if (stale()) return;
      if (stored) {
        const permission = await ensureReadwritePermission(stored, {
          allowRequest: true,
        });
        if (stale()) return;
        if (permission.state === 'granted') {
          connectBoundNameRef.current = stored.name;
          connectSavedRef.current = (await store?.save(stored)) ?? true;
          // Both latches clear only on the exits that bind a grant: a stale
          // or otherwise non-binding connect (dismissed picker, failed pick,
          // re-armed gesture) must not disarm either guard.
          if (stale()) return;
          // This arm binds the record's own handle — a soft-failed re-save
          // still binds it — so the record is this mount's grant again.
          foreignRecordRef.current = false;
          detachedRef.current = false;
          connectWroteStatusRef.current = true;
          startBridge(stored);
          return;
        }
        // A request that ran consumed the click's transient activation, so a
        // picker opened now would reject SecurityError gesture-less: ask for
        // one more click instead of falling through. Deliberately does NOT
        // touch handleRef: the rebind effect starts a bridge from whatever it
        // holds, and an ungranted handle would register tools whose every
        // call the browser rejects.
        if (permission.requested) {
          connectWroteStatusRef.current = true;
          const rootName = recordRootName(stored.name);
          setStatus({
            phase: 'needs-gesture',
            blocker: null,
            ...(rootName === undefined ? {} : { rootName }),
          });
          return;
        }
        // The query answered denied without any request: activation survived,
        // so a fresh pick is still possible within this click.
      }
      const result = await pickDirectoryHandle(win);
      if (stale()) return;
      if (result.kind === 'cancelled') return;
      if (result.kind === 'unavailable') {
        // Name the record-backed grant: the failure write must not hide the
        // panel's Disconnect, the only revoke path, over a persisted handle.
        const rootName = recordRootName((await store?.load())?.name);
        if (stale()) return;
        connectWroteStatusRef.current = true;
        setStatus({
          phase: 'unavailable',
          blocker: result.blocker,
          ...(rootName === undefined ? {} : { rootName }),
        });
        return;
      }
      if (result.kind === 'failed') {
        const rootName = recordRootName((await store?.load())?.name);
        if (stale()) return;
        connectWroteStatusRef.current = true;
        setStatus({
          phase: 'failed',
          blocker: null,
          message: result.message,
          ...(rootName === undefined ? {} : { rootName }),
        });
        return;
      }
      connectBoundNameRef.current = result.handle.name;
      connectSavedRef.current = (await store?.save(result.handle)) ?? true;
      if (connectSavedRef.current) foreignRecordRef.current = false;
      if (stale()) return;
      detachedRef.current = false;
      connectWroteStatusRef.current = true;
      startBridge(result.handle);
    } finally {
      connectInFlightRef.current = false;
      // A revoke deferred by a disconnect waits for this connect's verdict:
      // it saved, so the record is its own grant and the revoke is dropped;
      // it left without saving, so the revoke proceeds here instead of being
      // swallowed by a veto whose connect never wrote anything.
      const pending = pendingRevokeRef.current;
      pendingRevokeRef.current = undefined;
      if (pending !== undefined && !connectSavedRef.current) await pending();
    }
  }, [capability.blocker, recordRootName, startBridge, store, win]);

  const disconnect = useCallback(async () => {
    // Invalidates any connect() still waiting on the picker, so a grant made
    // after the user asked to disconnect cannot start a bridge behind them.
    const generation = (generationRef.current += 1);
    // The revoke epoch: only a NEWER disconnect supersedes this one's
    // pending revoke — an unmount must not, or a view disappearing inside
    // the arbitration backoff would silently cancel the user's revoke.
    const revokeGeneration = (revokeGenerationRef.current += 1);
    // Read the latch before stopBridge() clears it: an owned run held the
    // lock exclusively, so after stop() no peer can hold it and the revoke
    // needs no arbitration (our own release may still be settling).
    const owned = ownedRunRef.current;
    // Facts the optimistic terminal write below would destroy: the name of
    // a grant still in the store, and the status to restore when no revoke
    // happens (every attempt declined, or the delete failing soft). The
    // parked fact needs the rendered status as well as the bridge: a
    // held-elsewhere bridge has already settled start() terminally, so a
    // second declined click finds bridgeRef empty and would otherwise
    // downgrade a truthful held-elsewhere panel to idle.
    const name = handleRef.current?.name ?? statusRef.current.rootName;
    const parkedBeforeStop =
      bridgeRef.current?.getState().phase === 'held-elsewhere' ||
      statusRef.current.phase === 'held-elsewhere';
    stopBridge();
    handleRef.current = undefined;
    // Latch the detach: restore() re-attaches from the store, and the record
    // can deliberately survive a declined revoke — without the latch a later
    // blocker flip would resurrect a bridge behind the user's click.
    detachedRef.current = true;
    setStatus(
      capability.blocker !== null
        ? { phase: 'unavailable', blocker: capability.blocker }
        : IDLE,
    );
    deferredRevokeRef.current = false;
    // What the panel showed before the click, for every path that leaves
    // the record — and a peer's dependence on it — exactly where it was:
    // a live blocker first (the withhold must survive the click), then the
    // parked bridge's state, else the named grant over an idle panel. The
    // blocker comes from the live mirror: a withhold that cleared while the
    // arbitration settled must not be re-asserted from this click's stale
    // snapshot. The parked arm keys on a genuinely declined arbitration: a
    // granted one whose delete merely failed soft has no peer to attribute
    // the directory to. A record the revoke refused as a peer's is named by
    // no arm: the Disconnect a name would render could never clear it.
    const unclearedStatus = (declined: boolean): LocalFilesStatus => {
      const blocker = capabilityRef.current.blocker;
      const named = recordRootName(name);
      return blocker !== null
        ? {
            phase: 'unavailable',
            blocker,
            ...(named === undefined ? {} : { rootName: named }),
          }
        : named === undefined
          ? IDLE
          : parkedBeforeStop && declined
            ? { phase: 'held-elsewhere', blocker: null, rootName: named }
            : { ...IDLE, rootName: named };
    };
    const clearedStatus = (): LocalFilesStatus => {
      const blocker = capabilityRef.current.blocker;
      return blocker !== null ? { phase: 'unavailable', blocker } : IDLE;
    };
    const revoke = async (): Promise<boolean> => {
      // A later disconnect must win over this one's pending revoke.
      if (revokeGenerationRef.current !== revokeGeneration) return false;
      // A connect stamped at or after this disconnect decides the record's
      // fate, not this revoke: still in flight, the revoke waits for its
      // finally; already finished, whether it saved says if the record is
      // its own grant (keep) or an abandoned attempt (revoke now).
      if (connectGenerationRef.current >= generation) {
        if (connectInFlightRef.current) {
          // Defer the WHOLE arbitrated revoke, never the bare clear: the
          // lock this arbitration holds is released when withOwnerLock's
          // callback returns, so the deferred attempt must re-ask the lock
          // manager — and reconcile the panel with what it then achieves,
          // because nothing else derives the status from its outcome.
          pendingRevokeRef.current = async () => {
            const { cleared: clearedNow, declined: declinedNow } =
              await arbitratedRevoke();
            // A newer disconnect owns the status; leave its writes alone.
            if (revokeGenerationRef.current !== revokeGeneration) {
              return clearedNow;
            }
            // A connect stamped at or after this disconnect that BOUND a
            // grant owns the status: it saved, it is still in flight so
            // this revoke re-deferred to it, or it parked a handle or a
            // live bridge in this mount — a soft-failed save still binds
            // both.
            if (
              connectGenerationRef.current >= generation &&
              (connectInFlightRef.current ||
                connectSavedRef.current ||
                bridgeRef.current !== undefined ||
                handleRef.current !== undefined)
            ) {
              return clearedNow;
            }
            // An unbound connect can still have committed the authoritative
            // status itself (needs-gesture/failed/unavailable); only a
            // connect that wrote nothing gets the pre-click panel back.
            if (!clearedNow && connectWroteStatusRef.current) {
              return clearedNow;
            }
            setStatus(
              clearedNow ? clearedStatus() : unclearedStatus(declinedNow),
            );
            return clearedNow;
          };
          deferredRevokeRef.current = true;
          return false;
        }
        if (connectSavedRef.current) return false;
      }
      // The record is one origin-global slot and this delete can run from a
      // view that no longer exists: a grant a peer stored under a different
      // name while this revoke was deferred is not the grant the user
      // revoked, and a blind clear would delete it anyway.
      const current = await store?.load();
      // A connect stamped at or after this disconnect that bound THIS
      // record owns it: a soft-failed save wrote nothing, but the bridge
      // serving the record is this mount's own, so a deferred revoke must
      // not delete the record from under that live bridge. A picker connect
      // that bound a DIFFERENT directory vetoes nothing: the record is not
      // its grant.
      if (
        current !== undefined &&
        connectGenerationRef.current >= generation &&
        current.name === connectBoundNameRef.current
      ) {
        return false;
      }
      if (
        current !== undefined &&
        (foreignRecordRef.current ||
          (name !== undefined && current.name !== name))
      ) {
        // Not the grant this mount named: remember that the record is
        // foreign, so a later click with no name of its own cannot
        // blind-clear a peer's directory either.
        foreignRecordRef.current = true;
        return false;
      }
      return (await store?.clear()) ?? true;
    };
    const locks =
      optionsRef.current.locks === undefined
        ? defaultLocks()
        : optionsRef.current.locks;
    const arbitratedRevoke = async (): Promise<{
      cleared: boolean;
      declined: boolean;
    }> => {
      // Ownership must be a live fact, not only the click-time latch: the
      // deferred caller re-asks after the connect it yielded to may have
      // started THIS mount's bridge, whose lock must short-circuit the
      // arbitration the same way (a no-op for the direct caller, where
      // stopBridge() already cleared the latch).
      if (owned || ownedRunRef.current || locks === null) {
        // No lock manager: no cross-tab arbitration exists, so this context
        // is the only possible owner of the record.
        return { cleared: await revoke(), declined: false };
      }
      // The store is origin-global and a peer tab's live bridge depends on
      // it, so a mount that never owned a run revokes only while no other
      // context holds the owner lock; withOwnerLock bounds that wait and
      // guards the conformant null decline (Web Locks 4.1).
      const delay =
        optionsRef.current.delay ??
        ((ms: number) => new Promise((resolve) => setTimeout(resolve, ms)));
      let cleared = false;
      const settled = await withOwnerLock({
        locks,
        delay,
        cancelled: () => revokeGenerationRef.current !== revokeGeneration,
        run: async () => {
          cleared = await revoke();
        },
      }).catch(async () => {
        // A rejecting manager is functionally no manager.
        cleared = await revoke();
        return true;
      });
      return { cleared, declined: !settled };
    };
    const { cleared, declined } = await arbitratedRevoke();
    // The optimistic write above is truthful only when the revoke decided;
    // every other path restores what the panel showed before the click and
    // keeps the revoke affordance reachable. A newer disconnect owns the
    // status, and a connect stamped at or after this disconnect that
    // actually wrote is authoritative — reconciling over either would
    // misreport its outcome as parked or idle.
    if (
      cleared ||
      deferredRevokeRef.current ||
      revokeGenerationRef.current !== revokeGeneration
    ) {
      return;
    }
    if (connectGenerationRef.current >= generation) {
      if (connectSavedRef.current) return;
      if (connectInFlightRef.current) {
        // The connect is still out: hand the reconcile to its finally,
        // which runs it only when the connect leaves without saving. The
        // closure then re-checks what the connect committed: a dismissed
        // picker wrote nothing, so the pre-click panel is restored; a
        // needs-gesture/failed/unavailable exit wrote the authoritative
        // status itself and must stand.
        deferredRevokeRef.current = true;
        pendingRevokeRef.current = async () => {
          if (revokeGenerationRef.current !== revokeGeneration) return false;
          if (connectWroteStatusRef.current) return false;
          setStatus(unclearedStatus(declined));
          return false;
        };
        return;
      }
      // A connect that already settled committed its status itself; the
      // pre-click panel is restored only over a connect that wrote nothing.
      if (connectWroteStatusRef.current) return;
    }
    setStatus(unclearedStatus(declined));
  }, [capability.blocker, recordRootName, stopBridge, store]);

  return { status, capability, connect, disconnect, restore };
}
