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
    // A withheld session workspace (untrusted/live) is a deployment-level
    // blocker the browser probe cannot see; injecting it here routes every
    // downstream guard (restore, connect, status) through one path.
    return options.withheldBlocker === undefined
      ? detected
      : { ...detected, blocker: options.withheldBlocker };
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
  const bridgeRef = useRef<LocalFilesBridge | undefined>(undefined);
  const handleRef = useRef<FileSystemDirectoryHandle | undefined>(undefined);
  /**
   * Bumped by `disconnect()` and by unmount. Every await in `connect()` and
   * `restore()` re-checks it, because both can be waiting on a native picker
   * for tens of seconds: without this a connect that outlives the view would
   * start a bridge nobody can stop, holding the user's directory grant open.
   */
  const generationRef = useRef(0);
  const connectInFlightRef = useRef(false);

  const stopBridge = useCallback(() => {
    const bridge = bridgeRef.current;
    bridgeRef.current = undefined;
    bridge?.stop();
  }, []);

  const startBridge = useCallback(
    (handle: FileSystemDirectoryHandle) => {
      stopBridge();
      // stopBridge() first: stopping afterwards would let the 'stopped' ->
      // idle mapping overwrite the unavailable status set here.
      const blocker = capabilityRef.current.blocker;
      if (blocker !== null) {
        setStatus({ phase: 'unavailable', blocker });
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
          setStatus(phaseFromBridge(state, handle.name));
        },
      });
      bridgeRef.current = bridge;
      void bridge.start();
    },
    [stopBridge],
  );

  /**
   * Restore a stored grant without a gesture, so a reload reconnects silently
   * when the browser still considers the permission granted.
   */
  const restore = useCallback(async () => {
    if (capability.blocker !== null || !store) return;
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
      setStatus({
        phase: 'needs-gesture',
        blocker: null,
        rootName: stored.name,
      });
      return;
    }
    startBridge(stored);
  }, [capability.blocker, startBridge, store]);

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
      stopBridge();
      setStatus({ phase: 'unavailable', blocker: capability.blocker });
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
      setStatus({ phase: 'unavailable', blocker: capability.blocker });
      return;
    }
    // One picker at a time: a double click would otherwise open two native
    // dialogs and race two bridges for the same grant.
    if (connectInFlightRef.current) return;
    connectInFlightRef.current = true;
    const generation = generationRef.current;
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
          await store?.save(stored);
          if (stale()) return;
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
          setStatus({
            phase: 'needs-gesture',
            blocker: null,
            rootName: stored.name,
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
        setStatus({ phase: 'unavailable', blocker: result.blocker });
        return;
      }
      if (result.kind === 'failed') {
        setStatus({ phase: 'failed', blocker: null, message: result.message });
        return;
      }
      await store?.save(result.handle);
      if (stale()) return;
      startBridge(result.handle);
    } finally {
      connectInFlightRef.current = false;
    }
  }, [capability.blocker, startBridge, store, win]);

  const disconnect = useCallback(() => {
    // Invalidates any connect() still waiting on the picker, so a grant made
    // after the user asked to disconnect cannot start a bridge behind them.
    generationRef.current += 1;
    stopBridge();
    handleRef.current = undefined;
    void store?.clear();
    setStatus(
      capability.blocker !== null
        ? { phase: 'unavailable', blocker: capability.blocker }
        : IDLE,
    );
  }, [capability.blocker, stopBridge, store]);

  return { status, capability, connect, disconnect, restore };
}
