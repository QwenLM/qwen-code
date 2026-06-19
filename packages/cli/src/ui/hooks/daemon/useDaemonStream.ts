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
 * Approval wiring (verified end-to-end on a real 0.17.x daemon): the reducer marks
 * a gated tool `Confirming`; this hook attaches a `confirmationDetails` (built by
 * {@link buildDaemonConfirmation}) to that tool in `pendingHistoryItems`, so
 * `ToolGroupMessage`/`ToolConfirmationMessage` render an answerable prompt whose
 * `onConfirm` maps the chosen `ToolConfirmationOutcome` to the daemon `optionId`
 * and posts the vote. Approving executes the tool in the daemon and the turn
 * completes; Esc declines (that component's keypress handler only mounts once
 * `confirmationDetails` is present), and `permission_resolved` folds state back to
 * `Responding`.
 *
 * Known gaps for a later pass (NOT done here):
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
import { buildDaemonConfirmation } from './daemonConfirmation.js';

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

  // Fold one frame into the projection and reflect it in the UI. Shared by the
  // event loop and the prompt()-resolution finalizer.
  const applyFrame = useCallback((frame: DaemonFrame) => {
    const { state, committed } = projectDaemonEvent(stateRef.current, frame);
    const su = (frame.data as { update?: { sessionUpdate?: string } })?.update
      ?.sessionUpdate;
    dbg(
      `frame type=${frame.type}${su ? `/${su}` : ''} oc=${frame.originatorClientId ?? '∅'} -> state=${state.streamingState} tools=${state.tools.length} pending=${pendingHistoryItemsOf(state).length} committed=${committed.length}`,
    );
    if (frame.type === 'permission_request') {
      const tc = (frame.data as { toolCall?: Record<string, unknown> })
        ?.toolCall;
      const opts =
        (frame.data as { options?: Array<Record<string, unknown>> })?.options ??
        [];
      dbg(
        `  perm toolCall keys=[${Object.keys(tc ?? {}).join(',')}] toolCallId=${String(tc?.['toolCallId'])} options=${opts.map((o) => `${o['kind']}:${o['optionId']}`).join('|')}`,
      );
    }
    stateRef.current = state;
    for (const item of committed) addItemRef.current(item, now());
    streamingResponseLengthRef.current = state.pendingText.length;
    setSnapshot(state);
  }, []);

  // Finalize the in-flight turn (commit pending text, return to Idle).
  //
  // IMPORTANT: this codebase's daemon (0.17.x) signals turn completion via the
  // prompt() HTTP RESPONSE (`stopReason`), NOT a `turn_complete` SSE frame — so
  // we synthesize one when prompt() resolves (and when the SSE closes mid-turn).
  // Newer daemons (0.18+) also emit the frame; the duplicate is a harmless no-op
  // (pending already cleared → Idle).
  const finalizeTurn = useCallback(
    (stopReason?: unknown) => {
      if (stateRef.current.streamingState === StreamingState.Idle) return;
      applyFrame({ type: 'turn_complete', data: { stopReason } });
    },
    [applyFrame],
  );

  useEffect(() => {
    const ac = new AbortController();
    let disposed = false;

    void (async () => {
      for (let attempt = 0; !disposed && !ac.signal.aborted; attempt++) {
        try {
          dbg(`subscribe attempt=${attempt} clientId=${driver.clientId}`);
          for await (const frame of driver.events({ signal: ac.signal })) {
            if (disposed) break;
            applyFrame(frame);
          }
          dbg('stream ended');
          if (disposed || ac.signal.aborted) break;
          // The daemon may close the SSE when idle (0.17.x closes per-turn/idle).
          // Finalize any in-flight turn, then re-subscribe so the session keeps
          // working across reconnects (resume picks up after the last event id).
          finalizeTurn();
          await new Promise((r) => setTimeout(r, 500));
          continue;
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
  }, [driver, applyFrame, finalizeTurn]);

  const submitQuery = useCallback(
    async (query: string) => {
      // Echo locally for responsiveness; the reducer drops the daemon's
      // self-echo (matched by originatorClientId === our clientId).
      addItemRef.current({ type: 'user', text: query }, now());
      dbg(`submitQuery len=${query.length}`);
      const result = await driver.prompt({
        prompt: [{ type: 'text', text: query }],
      });
      dbg('prompt() resolved');
      // 0.17.x completion signal: prompt() resolves with the turn's stopReason.
      finalizeTurn((result as { stopReason?: unknown } | null)?.stopReason);
    },
    [driver, finalizeTurn],
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

  const pendingHistoryItems = useMemo(() => {
    const items = pendingHistoryItemsOf(snapshot);
    // Bind the approval prompt: attach a `confirmationDetails` (with an
    // outcome→optionId-mapping `onConfirm`) to the gated tool so
    // `ToolConfirmationMessage` renders an answerable Yes/Always/No. The reducer
    // can't build this — `onConfirm` closes over the impure `respondToPermission`.
    const gate = activePermissionOf(snapshot);
    if (!gate?.toolCallId) return items;
    const details = buildDaemonConfirmation(gate, respondToPermission);
    return items.map((item) =>
      item.type === 'tool_group'
        ? {
            ...item,
            tools: item.tools.map((tool) =>
              tool.callId === gate.toolCallId
                ? { ...tool, confirmationDetails: details }
                : tool,
            ),
          }
        : item,
    );
  }, [snapshot, respondToPermission]);
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
