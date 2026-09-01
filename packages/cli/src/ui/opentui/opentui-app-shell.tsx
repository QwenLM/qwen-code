/* eslint-disable react/no-unknown-property */
/** @jsxImportSource @opentui/react */
/**
 * @license
 * Copyright 2026 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * OpenTUI app shell — the backend composition root (Batch 5).
 *
 * It assembles the four pieces the migration design names for this batch —
 * command bridge (host + dispatcher + gateway), dialog mount, error boundary —
 * and wires the composer to the slash dispatcher. Input submitted through the
 * composer is routed through the gateway: a slash command is dispatched and its
 * {@link OpenTuiDispatchOutcome} applied (a dialog request opens
 * {@link OpenTuiDialogMount}; a quit reaches the entry), while a plain prompt or
 * a `submit_prompt` outcome is handed to the live-turn seam.
 *
 * What it deliberately does NOT do (owned by the renderer-bootstrap batch, and
 * each one is an explicitly-named seam so nothing is silently dropped):
 *  - rendering the live transcript (`renderMain`): the shell holds no streaming
 *    model — folding `livePromptEvents` into visible rows is the view layer's
 *    job, and it needs the real OpenTUI renderer to be verifiable;
 *  - driving a model turn (`onSubmitPrompt`) and the tool-approval UI;
 *  - session-switch transcript replay (`onTranscriptReset`), Vim owner
 *    (`onToggleVim`), and session stats (`getSessionStats`, a provider read).
 *
 * Not the ink `AppContainer`: there is no provider tree to build here — the
 * OpenTUI widgets are prop-driven and read keys through `@opentui/react`.
 */

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from 'react';
import type { Config, Logger, ApprovalMode } from '@qwen-code/qwen-code-core';
import type { PartListUnion } from '@google/genai';
import type { LoadedSettings } from '../../config/settings.js';
import type { ExtensionRefreshState } from '../../config/extension-refresh-state.js';
import type { SlashCommand } from '../commands/types.js';
import type { SessionStatsState } from '../contexts/SessionContext.js';
import type { HistoryItem } from '../types.js';
import type { OpenTuiRuntime } from './opentui-runtime.js';
import type { OpenTuiDialogRequest } from './commands-registry.js';
import type { OpenTuiStreamEvent } from './event-adapter.js';
import type { ShellConfirmationResolution } from './commands-context.js';
import type { WaitingCallInfo } from './live-session.js';
import { OpenTuiAppHost } from './opentui-host.js';
import { OpenTuiSlashGateway } from './slash-gateway.js';
import {
  OpenTuiSlashDispatcher,
  type OpenTuiDispatchOutcome,
} from './commands-dispatch.js';
import { OpenTuiErrorBoundary } from './opentui-error-boundary.js';
import { OpenTuiDialogMount } from './opentui-dialog-mount.js';
import { OpenTuiInputPrompt } from './input-prompt.js';
import {
  OpenTuiActionConfirmation,
  OpenTuiShellConfirmation,
  OpenTuiToolConfirmation,
} from './dialogs-confirm.js';

export interface OpenTuiAppProps {
  config: Config;
  settings: LoadedSettings;
  logger: Logger | null;
  /** Preloaded slash registry; when omitted the shell loads it on mount. */
  commands?: readonly SlashCommand[];
  /** Owned by a Batch-6 stats provider; commands read it through the host. */
  getSessionStats: () => SessionStatsState;
  /** Runtime sidecar, created by the entry and passed straight through. */
  runtime?: OpenTuiRuntime;
  extensionRefreshState?: ExtensionRefreshState;

  // --- seams owned by the renderer / entry layer ---------------------------
  /** Renders the transcript + status line (needs the real OpenTUI renderer). */
  renderMain?: () => ReactNode;
  /**
   * Runs a model turn for a plain prompt or a `submit_prompt` outcome. A
   * composer prompt passes its pasted image paths as a second, structured
   * argument: turning them into image parts (ink: attachments) belongs to the
   * entry layer, so the shell must not flatten them into the prompt text.
   */
  onSubmitPrompt?: (
    content: PartListUnion,
    imagePaths?: readonly string[],
  ) => void;
  /** Reaches the entry after `/quit`; receives the closing history rows. */
  onQuit?: (messages: readonly HistoryItem[]) => void;
  /** Replays a transcript batch (session switch / resume). */
  onTranscriptReset?: (events: OpenTuiStreamEvent[]) => void;
  /**
   * Re-keys UI-side session state (chat id + stats) after core rotates the
   * session. `/resume` and `/branch` treat this call as their commit point, so
   * the shell reports a notice when no owner is wired rather than leaving the
   * new transcript keyed to the old session.
   */
  onStartNewSession?: (sessionId: string) => void;
  /** Vim-mode toggle owner (VimModeProvider in the entry layer). */
  onToggleVim?: () => Promise<boolean>;
  /**
   * Reserved slot for the update-notification banner (parity gap G-3). Holds
   * the same shape as ink's `updateInfo.message`; the update-check wiring
   * that populates it lands with a later batch, so the layout stays fixed.
   */
  updateNotice?: string | null;
  availableTerminalHeight?: number;

  // --- Batch 6: live-turn + confirmation wiring ---------------------------
  /** A live model turn is in flight (composer Esc interrupts, footer spins). */
  streaming?: boolean;
  /** Aborts the in-flight turn (Esc while streaming). */
  onInterrupt?: () => void;
  approvalMode?: ApprovalMode;
  /** Mid-turn queued prompts (composer badge + Esc pop-back). */
  queueLength?: number;
  onPopQueue?: () => string | null;
  /**
   * Scheduler calls parked in `awaiting_approval`. The shell renders the
   * first one as a modal dialog; settlement flows through the call's own
   * `onConfirm` and is reported back via {@link onToolCallSettled}.
   */
  waitingToolCalls?: readonly WaitingCallInfo[];
  /** Drops a waiting call after its dialog settled. */
  onToolCallSettled?: (callId: string) => void;
  /** U-10 parity: the entry logs/echoes render crashes (error boundary). */
  onRenderError?: (error: Error) => void;
  /** Entry-owned composer buffer handle (early-input injection). */
  composerHandle?: {
    current: { getText: () => string; setText: (text: string) => void } | null;
  };
}

interface ShellModal {
  kind: 'shell';
  id: number;
  commands: readonly string[];
  resolve: (resolution: ShellConfirmationResolution) => void;
}

interface ActionModal {
  kind: 'action';
  id: number;
  prompt: ReactNode;
  resolve: (confirmed: boolean) => void;
}

type ConfirmationModal = ShellModal | ActionModal;

export function OpenTuiApp(props: OpenTuiAppProps) {
  const {
    config,
    settings,
    logger,
    commands,
    getSessionStats,
    extensionRefreshState,
    renderMain,
    onSubmitPrompt,
    onQuit,
    onTranscriptReset,
    onStartNewSession,
    onToggleVim,
    updateNotice,
    streaming,
    onInterrupt,
    approvalMode,
    queueLength,
    onPopQueue,
    waitingToolCalls,
    onToolCallSettled,
    onRenderError,
  } = props;

  const [dialog, setDialog] = useState<OpenTuiDialogRequest | null>(null);
  const [noticeText, setNoticeText] = useState<string | null>(null);
  const [commandList, setCommandList] = useState<readonly SlashCommand[]>(
    commands ?? [],
  );

  const notify = useCallback((text: string) => setNoticeText(text), []);

  // Modal confirmation bridge (Batch 6): presentShell/presentAction enqueue
  // a dialog and hand back the promise that its resolution settles. Both
  // functions stay referentially stable (U-8) — they only touch setState and
  // a sequence ref, never per-render state.
  const [modals, setModals] = useState<readonly ConfirmationModal[]>([]);
  const modalSeq = useRef(0);
  const confirmations = useMemo(
    () => ({
      presentShell: (commandsToRun: readonly string[]) =>
        new Promise<ShellConfirmationResolution>((resolve) => {
          modalSeq.current += 1;
          setModals((prev) => [
            ...prev,
            {
              kind: 'shell',
              id: modalSeq.current,
              commands: commandsToRun,
              resolve,
            },
          ]);
        }),
      presentAction: (prompt: ReactNode) =>
        new Promise<boolean>((resolve) => {
          modalSeq.current += 1;
          setModals((prev) => [
            ...prev,
            { kind: 'action', id: modalSeq.current, prompt, resolve },
          ]);
        }),
    }),
    [],
  );

  const activeModal = modals[0] ?? null;
  const closeShellModal = useCallback(
    (modal: ShellModal, resolution: ShellConfirmationResolution) => {
      setModals((prev) => prev.filter((m) => m.id !== modal.id));
      modal.resolve(resolution);
    },
    [],
  );
  const closeActionModal = useCallback(
    (modal: ActionModal, confirmed: boolean) => {
      setModals((prev) => prev.filter((m) => m.id !== modal.id));
      modal.resolve(confirmed);
    },
    [],
  );

  const activeToolCall = waitingToolCalls?.[0] ?? null;

  const transcript = useMemo(
    () => ({
      reset: (events: OpenTuiStreamEvent[]) => onTranscriptReset?.(events),
    }),
    [onTranscriptReset],
  );

  const host = useMemo(
    () =>
      new OpenTuiAppHost({
        config,
        settings,
        logger,
        transcript,
        confirmations,
        onChange: () => {},
        toggleVimEnabled: () => onToggleVim?.() ?? Promise.resolve(false),
        reloadCommands: () => reloadRef.current?.() ?? undefined,
        startNewSession: (sessionId: string) => {
          if (onStartNewSession) onStartNewSession(sessionId);
          else notify('Session state was not re-keyed for the new session.');
        },
        getSessionStats,
      }),
    [
      config,
      settings,
      logger,
      transcript,
      confirmations,
      onStartNewSession,
      notify,
      onToggleVim,
      getSessionStats,
    ],
  );

  // Re-render whenever the host's command state changes.
  useSyncExternalStore(
    useCallback((cb) => host.subscribe(cb), [host]),
    useCallback(() => host.getVersion(), [host]),
  );

  // Mirror the live-turn state onto the host so command gating (isIdle)
  // reflects an in-flight model turn, not just dispatcher processing.
  useEffect(() => {
    host.setStreaming(!!streaming);
  }, [host, streaming]);

  const gateway = useMemo(() => new OpenTuiSlashGateway(), []);
  const reloadRef = useRef<(() => void | Promise<void>) | null>(null);

  useEffect(() => {
    const dispatcher = new OpenTuiSlashDispatcher(
      host,
      { config, settings, logger, extensionRefreshState },
      commands ?? [],
    );
    reloadRef.current = async () => {
      await dispatcher.loadCommands();
      setCommandList(dispatcher.commands);
    };
    let disposed = false;
    (async () => {
      try {
        if (!commands) await dispatcher.loadCommands();
        if (!disposed) {
          setCommandList(dispatcher.commands);
          gateway.attach(dispatcher);
        }
      } catch (error) {
        if (!disposed) gateway.failInit(error);
      }
    })();
    return () => {
      disposed = true;
      dispatcher.dispose();
    };
  }, [
    host,
    gateway,
    config,
    settings,
    logger,
    commands,
    extensionRefreshState,
  ]);

  const applyOutcome = useCallback(
    (outcome: OpenTuiDispatchOutcome) => {
      switch (outcome.kind) {
        case 'handled':
          return;
        case 'open_dialog':
          setDialog(outcome.request);
          return;
        case 'submit_prompt':
          if (onSubmitPrompt) onSubmitPrompt(outcome.content);
          else notify('The live prompt turn is not wired in this shell.');
          return;
        case 'schedule_tool':
          notify(`Tool scheduling (${outcome.toolName}) is not wired.`);
          return;
        case 'quit':
          onQuit?.(outcome.messages);
          return;
        default: {
          const exhaustive: never = outcome;
          return exhaustive;
        }
      }
    },
    [onSubmitPrompt, onQuit, notify],
  );

  const onSubmit = useCallback(
    async (text: string, imagePaths?: string[]) => {
      setNoticeText(null);
      const settlement = await gateway.dispatch(text);
      if (settlement.kind === 'rejected') {
        notify(settlement.reason);
        return;
      }
      if (settlement.outcome === false) {
        if (onSubmitPrompt) onSubmitPrompt(text, imagePaths);
        else notify('The live prompt turn is not wired in this shell.');
        return;
      }
      applyOutcome(settlement.outcome);
    },
    [gateway, onSubmitPrompt, applyOutcome, notify],
  );

  const userMessages = useMemo(
    () =>
      host
        .getHistory()
        .filter((item) => item.type === 'user')
        .map((item) => item.text ?? ''),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [host, host.getVersion()],
  );

  return (
    <OpenTuiErrorBoundary
      recordForExitEcho
      onError={(error) => onRenderError?.(error)}
    >
      <box flexDirection="column" flexGrow={1} flexShrink={0}>
        {renderMain ? renderMain() : null}
        {!dialog && !activeModal && !activeToolCall && updateNotice ? (
          <text>{updateNotice}</text>
        ) : null}
        {noticeText ? <text>{noticeText}</text> : null}
        {activeToolCall ? (
          <OpenTuiToolConfirmation
            key={activeToolCall.callId}
            call={activeToolCall}
            onSettled={() => onToolCallSettled?.(activeToolCall.callId)}
          />
        ) : activeModal ? (
          activeModal.kind === 'shell' ? (
            <OpenTuiShellConfirmation
              key={`shell-${activeModal.id}`}
              commands={activeModal.commands}
              onResolve={(resolution) =>
                closeShellModal(activeModal, resolution)
              }
            />
          ) : (
            <OpenTuiActionConfirmation
              key={`action-${activeModal.id}`}
              prompt={activeModal.prompt}
              onResolve={(confirmed) =>
                closeActionModal(activeModal, confirmed)
              }
            />
          )
        ) : dialog ? (
          <OpenTuiDialogMount
            key={dialog.dialog}
            request={dialog}
            host={host}
            config={config}
            settings={settings}
            commands={commandList}
            onClose={() => setDialog(null)}
            notify={notify}
            onApprovalModeChanged={undefined}
            availableTerminalHeight={props.availableTerminalHeight}
          />
        ) : (
          <OpenTuiInputPrompt
            onSubmit={(text, imagePaths) => {
              void onSubmit(text, imagePaths);
            }}
            userMessages={userMessages}
            config={config}
            focus
            streaming={streaming}
            onInterrupt={onInterrupt}
            approvalMode={approvalMode}
            queueLength={queueLength}
            onPopQueue={onPopQueue}
            composerHandle={props.composerHandle}
          />
        )}
      </box>
    </OpenTuiErrorBoundary>
  );
}
