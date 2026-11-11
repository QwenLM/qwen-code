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
  connect: () => Promise<void>;
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
    };
  }, [sessionId]);

  const disconnect = useCallback(async () => {
    generationRef.current += 1;
    unsubscribeRef.current?.();
    unsubscribeRef.current = undefined;
    await bridgeRef.current?.disconnect();
    bridgeRef.current = undefined;
    // Release the grant so a wrong directory can be undone: Disconnect then
    // Connect must reach the picker again instead of silently reusing it.
    handleRef.current = undefined;
    await storeRef.current?.clear();
    setStatus((current) => (current.phase === 'unavailable' ? current : IDLE));
  }, []);

  // A closed tab stops answering the downlink; unregister the binding on
  // pagehide so the harness stops advertising tools no browser will answer.
  // The stored grant is kept for a silent restore on return; the control
  // plane also drops the binding when the SSE connection errors.
  useEffect(() => {
    if (!win || typeof win.addEventListener !== 'function') return;
    const onPageHide = () => {
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

  const connect = useCallback(async () => {
    if (!win || blocker !== null || !sessionId) return;
    const generation = generationRef.current;
    const stale = () => generationRef.current !== generation;
    let handle = handleRef.current;
    if (!handle) {
      const picked = await pickDirectoryHandle(win);
      if (stale()) return;
      if (picked.kind === 'cancelled') return;
      if (picked.kind === 'unavailable') {
        setStatus({ phase: 'unavailable', blocker: picked.blocker });
        return;
      }
      if (picked.kind === 'failed') {
        setStatus({ phase: 'failed', blocker: null, message: picked.message });
        return;
      }
      handle = picked.handle;
      handleRef.current = handle;
      await storeRef.current?.save(handle);
      if (stale()) return;
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
        ...(state.phase === 'connected' ? { toolCount: state.toolCount } : {}),
        ...(state.phase === 'failed' ? { message: state.message } : {}),
      });
    });
    await bridge.connect();
  }, [win, blocker, sessionId, baseUrl, fetch]);

  if (blocker !== null && status.phase !== 'unavailable') {
    return {
      status: { phase: 'unavailable', blocker },
      connect,
      disconnect,
    };
  }
  return { status, connect, disconnect };
}
