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
  headers?: () => Record<string, string>;
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
  connect: (options?: { forcePicker?: boolean }) => Promise<void>;
  disconnect: () => Promise<void>;
} {
  const { sessionId, baseUrl, fetch, headers } = options;
  const win =
    options.win ?? (typeof window !== 'undefined' ? window : undefined);
  const [status, setStatus] = useState<LocalFilesStatus>(IDLE);
  const handleRef = useRef<FileSystemDirectoryHandle | undefined>(undefined);
  const bridgeRef = useRef<ManagedClientFilesBridge | undefined>(undefined);
  const storeRef = useRef<DirectoryHandleStore | undefined>(undefined);

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
      void bridgeRef.current?.disconnect();
      bridgeRef.current = undefined;
    };
  }, [sessionId]);

  const disconnect = useCallback(async () => {
    await bridgeRef.current?.disconnect();
    bridgeRef.current = undefined;
    setStatus((current) => (current.phase === 'unavailable' ? current : IDLE));
  }, []);

  const connect = useCallback(
    async (options?: { forcePicker?: boolean }) => {
      if (!win || blocker !== null || !sessionId) return;
      const forcePicker = options?.forcePicker === true;
      let handle = forcePicker ? undefined : handleRef.current;
      if (!handle) {
        const picked = await pickDirectoryHandle(win);
        if (picked.kind === 'cancelled') return;
        // A failed re-pick must not misreport the still-running bridge; leave
        // the connected status and the old grant untouched.
        if (
          forcePicker &&
          (picked.kind === 'unavailable' || picked.kind === 'failed')
        ) {
          return;
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
        handle = picked.handle;
        handleRef.current = handle;
        await storeRef.current?.save(handle);
      }
      const server = new LocalFilesMcpServer(new LocalDirectory(handle));
      const bridge = new ManagedClientFilesBridge({
        baseUrl,
        sessionId,
        server,
        fetch,
        headers,
      });
      bridgeRef.current?.disconnect();
      bridgeRef.current = bridge;
      bridge.onState((state) => {
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
      await bridge.connect();
    },
    [win, blocker, sessionId, baseUrl, fetch, headers],
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
