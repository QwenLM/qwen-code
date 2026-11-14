/**
 * React wiring for the Managed-mode client filesystem bridge.
 *
 * The Managed control plane has no WebSocket and no ACP child to re-warm, so
 * this hook is deliberately simpler than the daemon's `useLocalFilesBridge`:
 * it reuses the same directory grant acquisition ({@link pickDirectoryHandle},
 * {@link createDirectoryHandleStore}) and the same {@link LocalFilesMcpServer},
 * but drives {@link ManagedClientFilesBridge} (HTTP register + SSE downlink +
 * POST responses) instead of the daemon WebSocket state machine.
 *
 * The grant is gesture-bound: a stored handle is restored silently when the
 * browser still allows it, otherwise `connect()` must run inside a real click.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { detectLocalFilesCapability } from './capabilities.js';
import {
  createDirectoryHandleStore,
  type DirectoryHandleStore,
} from './directory-handle-store.js';
import { LocalDirectory } from './local-directory.js';
import {
  ManagedClientFilesBridge,
  type ManagedClientFilesState,
  type ManagedFetch,
} from './managed-client-files-bridge.js';
import { LocalFilesMcpServer } from './mcp-server.js';
import {
  ensureReadwritePermission,
  pickDirectoryHandle,
} from './pick-directory.js';
import type {
  LocalFilesPhase,
  LocalFilesStatus,
} from './useLocalFilesBridge.js';

export interface UseManagedLocalFilesBridgeOptions {
  sessionId: string | undefined;
  /** The Managed WebShell API base, e.g. `/api/agent/web-shell/v1`. */
  baseUrl: string;
  fetch: ManagedFetch;
  /** Injected for tests; defaults to the live window. */
  win?: Window;
  idb?: IDBFactory;
}

const IDLE: LocalFilesStatus = { phase: 'idle', blocker: null };

function phaseOf(
  state: ManagedClientFilesState,
  hasSession: boolean,
): LocalFilesPhase {
  switch (state.phase) {
    case 'idle':
      return hasSession ? 'idle' : 'needs-session';
    case 'connecting':
      return 'connecting';
    case 'connected':
      return 'connected';
    case 'stopped':
      return 'idle';
    case 'failed':
      return 'failed';
  }
}

export function useManagedLocalFilesBridge(
  options: UseManagedLocalFilesBridgeOptions,
): {
  status: LocalFilesStatus;
  connect: (options?: {
    forcePicker?: boolean;
  }) => Promise<{ kind: 'repick-failed' } | undefined>;
  disconnect: () => Promise<void>;
} {
  const { sessionId, baseUrl, fetch } = options;
  const win =
    options.win ?? (typeof window !== 'undefined' ? window : undefined);
  const [status, setStatus] = useState<LocalFilesStatus>(IDLE);
  const handleRef = useRef<FileSystemDirectoryHandle | undefined>(undefined);
  const bridgeRef = useRef<ManagedClientFilesBridge | undefined>(undefined);
  // The live bridge's status unsubscribe: a superseded bridge's late `stopped`
  // (emitted after its awaited unregister) must not overwrite the new bridge's
  // status, so the listener is detached before the bridge is replaced/torn down.
  const unsubscribeRef = useRef<(() => void) | undefined>(undefined);
  const storeRef = useRef<DirectoryHandleStore | undefined>(undefined);
  // Bumped on teardown/session change/disconnect so a connect() parked on the
  // native picker does not save a grant and register a bridge after the view
  // unmounted or the session changed (mirrors the daemon hook's generationRef).
  const generationRef = useRef(0);
  // Re-entrancy guard: two rapid Connect clicks must not run two connect()
  // bodies concurrently (both would pick/register and race the bridge ref).
  const connectingRef = useRef(false);

  const blocker = useMemo(
    () =>
      win ? detectLocalFilesCapability(win).blocker : 'unsupported-browser',
    [win],
  );

  // Restore a stored grant silently when the browser still permits it.
  useEffect(() => {
    if (!win || blocker !== null) {
      setStatus({
        phase: 'unavailable',
        blocker: blocker ?? 'unsupported-browser',
      });
      return;
    }
    const idb = options.idb ?? win.indexedDB;
    const store = createDirectoryHandleStore(idb, baseUrl, win.location.origin);
    storeRef.current = store;
    let cancelled = false;
    void store.load().then(async (handle) => {
      if (cancelled || !handle) return;
      const permission = await ensureReadwritePermission(handle);
      if (cancelled) return;
      if (permission.state === 'granted') {
        handleRef.current = handle;
        setStatus((current) =>
          current.phase === 'unavailable' ? IDLE : current,
        );
      }
    });
    return () => {
      cancelled = true;
    };
  }, [win, blocker, baseUrl, options.idb]);

  // Tear the bridge down when the session changes or the hook unmounts.
  useEffect(() => {
    return () => {
      generationRef.current += 1;
      unsubscribeRef.current?.();
      unsubscribeRef.current = undefined;
      void bridgeRef.current?.disconnect();
      bridgeRef.current = undefined;
      // The listener is detached, so the old bridge's late `stopped` can no
      // longer reset the panel; settle it here so a Session switch does not
      // keep the previous Session's connected state (which would hide Connect).
      setStatus((current) =>
        current.phase === 'unavailable' ? current : IDLE,
      );
    };
  }, [sessionId]);

  const disconnect = useCallback(async () => {
    generationRef.current += 1;
    unsubscribeRef.current?.();
    unsubscribeRef.current = undefined;
    await bridgeRef.current?.disconnect();
    bridgeRef.current = undefined;
    // Release this mount's handle so a wrong directory can be undone:
    // Disconnect then Connect must reach the picker again instead of silently
    // reusing it.
    const bound = handleRef.current;
    handleRef.current = undefined;
    // The grant slot is origin-scoped — one record shared by every tab — so
    // only clear it while it still holds THIS mount's directory. A peer tab
    // may have re-granted a different directory into the slot, and a blind
    // clear would delete that peer's grant. Entry identity fails closed: with
    // no bound handle, or an isSameEntry that rejects, leave the stored record
    // alone rather than risk deleting a grant this tab does not own.
    const stored = await storeRef.current?.load();
    if (stored && bound) {
      let same = false;
      try {
        same = await bound.isSameEntry(stored);
      } catch {
        same = false;
      }
      if (same) await storeRef.current?.clear();
    }
    setStatus((current) => (current.phase === 'unavailable' ? current : IDLE));
  }, []);

  // A closed tab stops answering the downlink; unregister the binding on
  // pagehide so the harness stops advertising tools no browser will answer.
  // The stored grant is kept for a silent restore on return; the control
  // plane also drops the binding when the SSE connection errors.
  useEffect(() => {
    if (!win || typeof win.addEventListener !== 'function') return;
    const onPageHide = () => {
      // Bump the generation like disconnect() and the session cleanup do, so a
      // connect() still parked in the picker fails its stale() checkpoints and
      // cannot register a binding the closed tab is trying to release.
      generationRef.current += 1;
      const bridge = bridgeRef.current;
      // Clear the ref so a later Connect cannot call disconnect() a second
      // time on the already-disconnected bridge (an identity-less teardown).
      unsubscribeRef.current?.();
      unsubscribeRef.current = undefined;
      bridgeRef.current = undefined;
      void bridge?.disconnect();
      // The listener is detached, so the bridge's late `stopped` no longer
      // drives the panel; settle the status here like disconnect() does.
      setStatus((current) =>
        current.phase === 'unavailable' ? current : IDLE,
      );
    };
    win.addEventListener('pagehide', onPageHide);
    return () => win.removeEventListener('pagehide', onPageHide);
  }, [win]);

  const connect = useCallback(
    async (options?: { forcePicker?: boolean }) => {
      if (!win || blocker !== null || !sessionId) return;
      if (connectingRef.current) return;
      connectingRef.current = true;
      try {
        const forcePicker = options?.forcePicker === true;
        const generation = generationRef.current;
        const stale = () => generationRef.current !== generation;
        // forcePicker (Change directory) skips grant reuse so the picker opens
        // even though a grant exists; the fresh pick is saved over the record.
        let handle = forcePicker ? undefined : handleRef.current;
        if (handle) {
          // Reuse preconditions, mirroring the daemon hook: the store must still
          // hold the grant (a peer tab may have disconnected it) and the browser
          // permission must still be granted (it can be revoked while the tab
          // stays open). Trusting handleRef outright would register a directory
          // the user just disconnected or no longer allows.
          const stored = await storeRef.current?.load();
          if (stale()) return;
          if (!stored) {
            handleRef.current = undefined;
            handle = undefined;
          } else {
            const permission = await ensureReadwritePermission(handle);
            if (stale()) return;
            if (permission.state !== 'granted') {
              // Do not register on a handle the browser no longer allows. Drop the
              // retained handle and fall through to the picker in this same
              // gesture, so the Connect click is not a silent no-op that only
              // reaches the picker on a second click.
              handleRef.current = undefined;
              handle = undefined;
            }
          }
        }
        if (!handle) {
          const picked = await pickDirectoryHandle(win);
          if (stale()) return;
          if (picked.kind === 'cancelled') return;
          // A failed re-pick must not misreport the still-running bridge; leave
          // the connected status and the old grant untouched. Report the outcome
          // so the Change-directory handler can surface it (R1-5).
          if (
            forcePicker &&
            (picked.kind === 'unavailable' || picked.kind === 'failed')
          ) {
            return { kind: 'repick-failed' } as const;
          }
          if (picked.kind === 'unavailable') {
            setStatus({ phase: 'unavailable', blocker: picked.blocker });
            return;
          }
          if (picked.kind === 'failed') {
            setStatus({
              phase: 'failed',
              blocker: null,
              message: picked.message,
            });
            return;
          }
          const previousHandle = handleRef.current;
          // Re-confirming the already-bound entry is not a change: the picker
          // reopens the last choice (fixed PICKER_ID), so pressing Select
          // without navigating must not tear down and re-register the live
          // bridge. Identity, not basename — a same-named folder elsewhere is
          // a real change; a throwing isSameEntry fails closed (not same).
          if (forcePicker && previousHandle) {
            let same = false;
            try {
              same = await previousHandle.isSameEntry(picked.handle);
            } catch {
              same = false;
            }
            if (stale()) return;
            if (same) {
              handleRef.current = picked.handle;
              return;
            }
          }
          handle = picked.handle;
          handleRef.current = handle;
          const saved = (await storeRef.current?.save(handle)) ?? false;
          if (stale()) return;
          // A change that failed to persist must not leave the old directory
          // as the stored grant while the panel serves the new one: reject the
          // re-pick wholesale and keep the live bridge, exactly as the daemon
          // hook does. The record still holds the directory the bridge serves,
          // so a reload stays consistent and the handler's toast fires.
          if (forcePicker && !saved) {
            handleRef.current = previousHandle;
            return { kind: 'repick-failed' } as const;
          }
        }
        if (stale()) return;
        const server = new LocalFilesMcpServer(new LocalDirectory(handle));
        const bridge = new ManagedClientFilesBridge({
          baseUrl,
          sessionId,
          server,
          fetch,
        });
        // Detach the previous bridge's listener before tearing it down: its
        // disconnect() awaits the unregister POST and only then emits `stopped`,
        // which would otherwise land after the new bridge's `connecting`/`connected`
        // and overwrite the live panel status with a stale idle.
        unsubscribeRef.current?.();
        unsubscribeRef.current = undefined;
        bridgeRef.current?.disconnect();
        bridgeRef.current = bridge;
        unsubscribeRef.current = bridge.onState((state) => {
          setStatus({
            phase: phaseOf(state, true),
            blocker: null,
            rootName: handle.name,
            ...(state.phase === 'connected'
              ? { toolCount: state.toolCount }
              : {}),
            ...(state.phase === 'failed' ? { message: state.message } : {}),
          });
        });
        // Do not await the drain loop: it stays pending for the bridge's whole
        // connected lifetime, and awaiting it would hold the re-entrancy guard
        // for that entire span, making a later "Change directory" click return
        // at the guard before the picker opens. The guard only needs to cover
        // grant acquisition; connect() publishes its outcome (including
        // failure) through onState, so nothing is lost by not awaiting it.
        void bridge.connect();
      } finally {
        connectingRef.current = false;
      }
    },
    [win, blocker, sessionId, baseUrl, fetch],
  );

  if (blocker !== null && status.phase !== 'unavailable') {
    return {
      status: { phase: 'unavailable', blocker },
      connect,
      disconnect,
    };
  }
  return { status, connect, disconnect };
}
