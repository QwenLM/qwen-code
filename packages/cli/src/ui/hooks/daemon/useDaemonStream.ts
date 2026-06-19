/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * `useDaemonStream` — the opt-in daemon-client counterpart to `useGeminiStream`.
 *
 * It renders a *daemon-hosted* session in the existing TUI: it subscribes to the
 * daemon's SSE event stream, folds each frame through the pure
 * {@link projectDaemonEvent} reducer, and exposes the SAME shape
 * `useGeminiStream` returns so `AppContainer` can swap backends at the component
 * boundary. Tools execute IN THE DAEMON; this hook only renders their display and
 * votes on approvals. See `packages/rc-gateway/docs/phase2-daemon-tui.md`.
 *
 * Decoupling: the daemon client is taken as a structural {@link DaemonSessionDriver}
 * (an attached `DaemonSessionClient` satisfies it) so this package gains no
 * `@qwen-code/sdk` dependency and the hook is unit-testable with a fake driver.
 *
 * Known gaps for the interactive wiring pass (NOT done here):
 * - **Permission UI is non-functional until bound.** The reducer marks a gated
 *   tool `Confirming` but leaves `confirmationDetails` undefined; `ToolGroupMessage`
 *   renders the prompt off `confirmationDetails`, so until the wiring builds an
 *   `onConfirm` that calls {@link UseDaemonStreamResult.respondToPermission}, the
 *   approval prompt shows with no way to answer. The hook exposes `activePermission`
 *   + `respondToPermission` so the wiring can drive it.
 * - **Errored/canceled turns** (`stream_error`/`session_died`) don't reset
 *   streaming state yet (reducer slice-1 gap) — a stuck spinner.
 * - Several contract fields are documented stubs (see the return).
 */
import { appendFileSync } from 'node:fs';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  StreamingState,
  type HistoryItemWithoutId,
  type IndividualToolCallDisplay,
  type ThoughtSummary,
} from '../../types.js';

/**
 * Diagnostic frame log (opt-in via `QWEN_DAEMON_STREAM_DEBUG=<file>`). The TUI
 * owns stdout, so console logging would corrupt the Ink render — this appends to
 * a file instead. Off unless the env var is set.
 */
const dbg = (msg: string): void => {
  const path = process.env['QWEN_DAEMON_STREAM_DEBUG'];
  if (!path) return;
  try {
    appendFileSync(path, `${Date.now()} ${msg}\n`);
  } catch {
    /* best-effort diagnostics only */
  }
};
import {
  activePermissionOf,
  initialDaemonProjectionState,
  pendingHistoryItemsOf,
  pendingToolCallsOf,
  projectDaemonEvent,
  thoughtOf,
  type DaemonFrame,
  type PendingPermission,
} from './projectDaemonEvent.js';

/**
 * A vote on a daemon permission request. The `outcome` is itself an object
 * (matches the SDK's `PermissionResponse`): `{ outcome: { outcome: 'cancelled' } }`
 * or `{ outcome: { outcome: 'selected', optionId } }`.
 */
export interface DaemonPermissionResponse {
  outcome: { outcome: 'cancelled' } | { outcome: 'selected'; optionId: string };
  [key: string]: unknown;
}

/**
 * The minimal slice of `DaemonSessionClient` this hook drives. An attached
 * `DaemonSessionClient` satisfies it structurally (no import needed).
 */
export interface DaemonSessionDriver {
  /** This client's daemon clientId; required so the daemon's self-echo is dropped. */
  readonly clientId?: string;
  events(opts?: {
    signal?: AbortSignal;
  }): AsyncGenerator<DaemonFrame, void, unknown>;
  prompt(req: {
    prompt: Array<{ type: 'text'; text: string }>;
  }): Promise<unknown>;
  cancel(): Promise<void>;
  respondToSessionPermission(
    requestId: string,
    response: DaemonPermissionResponse,
  ): Promise<boolean>;
}

export type AddHistoryItem = (
  item: HistoryItemWithoutId,
  timestamp: number,
) => number;

export interface UseDaemonStreamResult {
  streamingState: StreamingState;
  /** Submit a user turn: echo locally (responsive) + send to the daemon. */
  submitQuery: (query: string) => Promise<void>;
  initError: string | null;
  pendingHistoryItems: HistoryItemWithoutId[];
  thought: ThoughtSummary | null;
  cancelOngoingRequest: () => void;
  pendingToolCalls: IndividualToolCallDisplay[];
  isReceivingContent: boolean;
  streamingResponseLengthRef: React.MutableRefObject<number>;
  /** Daemon-mode permission gate + vote (the interactive wiring binds these). */
  activePermission: PendingPermission | undefined;
  respondToPermission: (optionId: string | null) => Promise<void>;
  // --- contract stubs not yet wired for daemon mode (interactive pass) ---
  retryLastPrompt: () => Promise<void>;
  handleApprovalModeChange: () => Promise<void>;
  activePtyId: number | undefined;
  loopDetectionConfirmationRequest: null;
}

const now = () => Date.now();

export function useDaemonStream(
  driver: DaemonSessionDriver,
  addItem: AddHistoryItem,
): UseDaemonStreamResult {
  // PRECONDITION: the driver must be ATTACHED (clientId set) before mount.
  // Without a clientId the reducer can't distinguish our own echo from a remote
  // turn and falls back to projecting it — double-rendering our input (local
  // echo + daemon echo). `DaemonSessionClient.createOrAttach` always resolves a
  // clientId, so the wiring must await attach before rendering this hook.
  const stateRef = useRef(initialDaemonProjectionState(driver.clientId));
  const [snapshot, setSnapshot] = useState(stateRef.current);
  const [initError, setInitError] = useState<string | null>(null);
  const streamingResponseLengthRef = useRef(0);
  const addItemRef = useRef(addItem);
  addItemRef.current = addItem;

  useEffect(() => {
    const ac = new AbortController();
    let disposed = false;

    void (async () => {
      for (let attempt = 0; !disposed && !ac.signal.aborted; attempt++) {
        try {
          dbg(`subscribe attempt=${attempt} clientId=${driver.clientId}`);
          for await (const frame of driver.events({ signal: ac.signal })) {
            if (disposed) break;
            const { state, committed } = projectDaemonEvent(
              stateRef.current,
              frame,
            );
            const su = (frame.data as { update?: { sessionUpdate?: string } })
              ?.update?.sessionUpdate;
            dbg(
              `frame type=${frame.type}${su ? `/${su}` : ''} oc=${frame.originatorClientId ?? '∅'} -> state=${state.streamingState} committed=${committed.length}`,
            );
            stateRef.current = state;
            for (const item of committed) addItemRef.current(item, now());
            streamingResponseLengthRef.current = state.pendingText.length;
            setSnapshot(state);
          }
          dbg('stream ended normally');
          break; // stream ended normally
        } catch (err) {
          if (disposed || ac.signal.aborted) {
            dbg(`stream aborted (disposed=${disposed})`);
            break;
          }
          const msg = String((err as Error)?.message ?? err);
          dbg(`stream error: ${msg}`);
          // The daemon allows ONE live subscription per session; React
          // StrictMode's mount→unmount→remount can race the previous
          // subscription's teardown. Back off and retry rather than surfacing a
          // transient error to the user.
          if (/already active/i.test(msg) && attempt < 20) {
            await new Promise((r) => setTimeout(r, 25));
            continue;
          }
          setInitError(msg);
          break;
        }
      }
    })();

    return () => {
      disposed = true;
      ac.abort();
    };
  }, [driver]);

  const submitQuery = useCallback(
    async (query: string) => {
      // Echo locally for responsiveness; the reducer drops the daemon's
      // self-echo (matched by originatorClientId === our clientId).
      addItemRef.current({ type: 'user', text: query }, now());
      dbg(`submitQuery len=${query.length}`);
      await driver.prompt({ prompt: [{ type: 'text', text: query }] });
      dbg('prompt() resolved');
    },
    [driver],
  );

  const cancelOngoingRequest = useCallback(() => {
    void driver.cancel();
  }, [driver]);

  const respondToPermission = useCallback(
    async (optionId: string | null) => {
      const gate = stateRef.current.pendingPermission;
      if (!gate) return;
      await driver.respondToSessionPermission(
        gate.requestId,
        optionId === null
          ? { outcome: { outcome: 'cancelled' } }
          : { outcome: { outcome: 'selected', optionId } },
      );
    },
    [driver],
  );

  const pendingHistoryItems = useMemo(
    () => pendingHistoryItemsOf(snapshot),
    [snapshot],
  );
  const thought = useMemo(() => thoughtOf(snapshot), [snapshot]);
  const pendingToolCalls = useMemo(
    () => pendingToolCallsOf(snapshot),
    [snapshot],
  );
  const activePermission = useMemo(
    () => activePermissionOf(snapshot),
    [snapshot],
  );

  return {
    streamingState: snapshot.streamingState,
    submitQuery,
    initError,
    pendingHistoryItems,
    thought,
    cancelOngoingRequest,
    pendingToolCalls,
    isReceivingContent: snapshot.streamingState === StreamingState.Responding,
    streamingResponseLengthRef,
    activePermission,
    respondToPermission,
    // Stubs — these in-process behaviors are wired in the interactive pass.
    retryLastPrompt: async () => {},
    handleApprovalModeChange: async () => {},
    activePtyId: undefined,
    loopDetectionConfirmationRequest: null,
  };
}
