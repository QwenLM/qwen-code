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

import type { RestoreToolResponseBinding } from '../utils/restore-tool-response.js';
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type ReactNode,
  type RefObject,
} from 'react';
import {
  ApprovalMode,
  ToolConfirmationOutcome,
  type Config,
  type Logger,
} from '@qwen-code/qwen-code-core';
import { AuthType } from '@qwen-code/qwen-code-core/utils/auth-type.js';
import { C } from './theme.js';
import type { PartListUnion } from '@google/genai';
import { MessageSenderType } from '@qwen-code/qwen-code-core/core/logger.js';
import type { LoadedSettings } from '../../config/settings.js';
import type { MicrophonePermission } from '../hooks/use-voice-input.js';
import type { VimMode } from '../contexts/VimModeContext.js';
import type { ExtensionRefreshState } from '../../config/extension-refresh-state.js';
import type { SlashCommand } from '../commands/types.js';
import type { SessionStatsState } from '../contexts/SessionContext.js';
import { useWorktreeSession } from '../hooks/useWorktreeSession.js';
import { useGitBranchName } from '../hooks/useGitBranchName.js';
import { useStatusLineState } from '../hooks/useStatusLine.js';
import { useSubscriptionCommandVisibility } from '../hooks/use-subscription-command-visibility.js';
import { isNarrowWidth } from '../utils/isNarrowWidth.js';
import {
  MessageType,
  StreamingState,
  type HistoryItem,
  type ConfirmationRequest,
  type HistoryItemWithoutId,
} from '../types.js';
import {
  CONTEXT_FILES_ANNOUNCEMENT_PREFIX,
  consumesContextAnnouncementLatch,
  isContextFilesAnnouncement,
} from '../utils/commandUtils.js';
import type { OpenTuiRuntime } from './opentui-runtime.js';
import type { OpenTuiDialogRequest } from './commands-registry.js';
import type { OpenTuiStreamEvent } from './event-adapter.js';
import type { ShellConfirmationResolution } from './commands-context.js';
import {
  nextApprovalMode,
  selectAutoApprovals,
  type WaitingCallInfo,
} from './live-session.js';
import type {
  ForegroundShellOwner,
  OpenTuiLiveTurn,
  OpenTuiSubmitOptions,
} from './live-turn.js';
import {
  restoreInputSubmissions,
  type OpenTuiInputSubmission,
  type OpenTuiCancelSettled,
  type OpenTuiComposerHandle,
} from './input-submission.js';
import { rewindSession } from '../utils/session-rewind.js';
import { isRewindableUserTurn } from '../utils/historyMapping.js';
import { expandCollapsedHistory } from '../utils/resumeHistoryUtils.js';
import { projectItemToStreamEvent } from './item-projection.js';
import {
  rewindBoundaryHistory,
  type LiveHistoryItem,
} from './live-session-model.js';
import type { RestoreOption } from './session-rewind.js';
import { realUserPromptTexts } from '../utils/historyUtils.js';
import { createDebugLogger } from '@qwen-code/qwen-code-core/utils/debugLogger.js';
import { t } from '../../i18n/index.js';
import { emitAutoModeEntryNotices } from '../hooks/useAutoAcceptIndicator.js';
import { OpenTuiAppHost } from './opentui-host.js';
import { executeUserShell } from './shell-mode.js';
import { STATUS_INDICATOR_WIDTH } from './messages.js';
import { useKeyboard, useTerminalDimensions } from '@opentui/react';
import type { KeyEvent, BoxRenderable } from '@opentui/core';
import { Command, matchesCommand, toOriginalKey } from './key-map.js';
import { keyToAnsi } from '../hooks/keyToAnsi.js';
import {
  normalizeQuitSubmission,
  OpenTuiSlashGateway,
} from './slash-gateway.js';
import {
  OpenTuiSlashDispatcher,
  type OpenTuiDispatchOutcome,
} from './commands-dispatch.js';
import { isExitInProgress } from './exit-lifecycle.js';
import { injectCapturedInput } from './early-input.js';
import { OpenTuiErrorBoundary } from './opentui-error-boundary.js';
import { OpenTuiDialogMount } from './opentui-dialog-mount.js';
import { OpenTuiInputPrompt, type InputPromptProps } from './input-prompt.js';
import { OpenTuiBanner } from './opentui-header.js';
import { OpenTuiFooter, OpenTuiLoadingIndicator } from './opentui-footer.js';
import { OpenTuiQueuedMessageDisplay } from './queued-message.js';
import { OpenTuiModBand } from './mod-band.js';
import { useModBand } from '../hooks/use-mod-band.js';
import { modBandMaxRows } from '../utils/mod-band-tree.js';
import {
  OpenTuiActionConfirmation,
  OpenTuiMcpApprovalDialog,
  OpenTuiShellConfirmation,
  OpenTuiToolConfirmation,
} from './dialogs-confirm.js';
import { useMcpApproval } from '../hooks/useMcpApproval.js';
import { dialogAreaWidth } from './dialogs-shared.js';
import {
  getDialogMaxHeight,
  STATIC_EXTRA_HEIGHT,
} from '../utils/layoutUtils.js';

const debugLogger = createDebugLogger('OPEN_TUI_APP');

export interface OpenTuiAppProps {
  config: Config;
  settings: LoadedSettings;
  logger: Logger | null;
  startupHistory?: HistoryItem[];
  /** Preloaded slash registry; when omitted the shell loads it on mount. */
  commands?: readonly SlashCommand[];
  /** Owned by a Batch-6 stats provider; commands read it through the host. */
  getSessionStats: () => SessionStatsState;
  /** Reactive provider snapshot; the getter remains for imperative commands. */
  sessionStats?: SessionStatsState;
  /** Runtime sidecar, created by the entry and passed straight through. */
  runtime?: OpenTuiRuntime;
  extensionRefreshState?: ExtensionRefreshState;
  /**
   * Dialog auto-opened at boot (U-6). Ink auto-opens the auth dialog from the
   * unauthenticated initial state (useAuth) and the one-shot startup
   * authError (useInitializationAuthError); here the entry computes that once
   * and every later setDialog stays slash-dispatch owned.
   */
  initialDialog?: OpenTuiDialogRequest | null;

  // --- seams owned by the renderer / entry layer ---------------------------
  /** Renders the transcript + status line (needs the real OpenTUI renderer). */
  renderMain?: (shell?: {
    owner: ForegroundShellOwner | null;
    focused: boolean;
  }) => ReactNode;
  /** Current live prompts; the shell combines persisted input history. */
  userMessages?: readonly string[];
  historyItems?: readonly LiveHistoryItem[];
  isCurrentHistory?: (snapshot: readonly LiveHistoryItem[]) => boolean;
  onRewindTranscript?: (
    userId: string,
  ) => readonly LiveHistoryItem[] | undefined;
  /**
   * Runs a model turn for a plain prompt or a `submit_prompt` outcome. A
   * composer prompt passes its pasted image paths as a second, structured
   * argument: turning them into image parts (ink: attachments) belongs to the
   * entry layer, so the shell must not flatten them into the prompt text. A
   * `submit_prompt` outcome's per-turn options travel in the third argument.
   */
  onSubmitPrompt?: (
    content: PartListUnion,
    imagePaths?: readonly string[],
    options?: OpenTuiSubmitOptions,
  ) => boolean;
  onScheduleTool?: (
    name: string,
    args: Record<string, unknown>,
    restoreResponseBinding?: RestoreToolResponseBinding,
  ) => boolean;
  onRetryPrompt?: () => void;
  onInputProcessed?: () => void;
  /** Reaches the entry after `/quit`; receives the closing history rows. */
  onQuit?: (messages: readonly HistoryItem[]) => void;
  /** Replays a transcript batch (session switch / resume). */
  onTranscriptReset?: (events: OpenTuiStreamEvent[]) => void;
  /**
   * Folds one projected host-history event into the live transcript
   * (U-28 project-on-write); wired to the live turn's `applyEvent`.
   */
  onTranscriptEvent?: (
    event: OpenTuiStreamEvent,
  ) => readonly LiveHistoryItem[] | void;
  /**
   * Re-keys UI-side session state (chat id + stats) after core rotates the
   * session. `/resume` and `/branch` treat this call as their commit point, so
   * the shell reports a notice when no owner is wired rather than leaving the
   * new transcript keyed to the old session.
   */
  onStartNewSession?: (sessionId: string) => void;
  /** Vim-mode toggle owner (VimModeProvider in the entry layer). */
  onToggleVim?: () => Promise<boolean>;
  vimMode?: VimMode;
  /**
   * Reserved slot for the update-notification banner (parity gap G-3). Holds
   * the same shape as ink's `updateInfo.message`; the update-check wiring
   * that populates it lands with a later batch, so the layout stays fixed.
   */
  updateNotice?: string | null;
  /**
   * Armed two-press quit warning from the entry layer's exit guard. ink paints
   * it in the footer's own hint slot, so it travels there rather than into the
   * transcript region.
   */
  exitHint?: string | null;

  // --- Batch 6: live-turn + confirmation wiring ---------------------------
  /** A live model turn is in flight (composer Esc interrupts, footer spins). */
  streaming?: boolean;
  /** Live output-character count behind the indicator's token estimate. */
  streamingCharsRef?: RefObject<number>;
  /** False while waiting on the API (↑), true once content arrives (↓). */
  isReceivingContent?: boolean;
  /** Aborts the in-flight turn (Esc while streaming). */
  onInterrupt?: (onSettled?: OpenTuiCancelSettled) => void;
  approvalMode?: ApprovalMode;
  /** Mid-turn queued prompts (queue rows + badge + Esc pop-back). */
  messageQueue?: readonly string[];
  onPopQueue?: () => OpenTuiInputSubmission | null;
  /**
   * Scheduler calls parked in `awaiting_approval`. The shell renders the
   * first one as a modal dialog; settlement flows through the call's own
   * `onConfirm` and is reported back via {@link onToolCallSettled}.
   */
  waitingToolCalls?: readonly WaitingCallInfo[];
  foregroundShellControl?: Pick<
    OpenTuiLiveTurn,
    | 'foregroundShell'
    | 'promoteShellToBackground'
    | 'writeShellInput'
    | 'resizeShell'
    | 'scrollShell'
  >;
  /** Drops a waiting call after its dialog settled. */
  onToolCallSettled?: (callId: string) => void;
  /** U-10 parity: the entry logs/echoes render crashes (error boundary). */
  onRenderError?: (error: Error) => void;
  vim?: InputPromptProps['vim'];
  /** Entry-owned composer buffer handle (early-input injection). */
  composerHandle?: {
    current: OpenTuiComposerHandle | null;
  };
  /** U-7: finished follow-up suggestion, shown as the ghost placeholder. */
  promptSuggestion?: string | null;
  /** U-7: clears the published suggestion (accept/typing/submit). */
  onPromptSuggestionDismiss?: () => void;
  /** U-7/R2-2: aborts the suggestion without clearing it (typing path). */
  onPromptSuggestionAbort?: () => void;
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
    onTranscriptEvent,
    onInputProcessed,
    onRewindTranscript,
    isCurrentHistory,
    onScheduleTool,
    onStartNewSession,
    onToggleVim,
    updateNotice,
    exitHint,
    streaming,
    streamingCharsRef,
    isReceivingContent,
    onInterrupt,
    approvalMode,
    messageQueue,
    onPopQueue,
    waitingToolCalls,
    onToolCallSettled,
    onRenderError,
    promptSuggestion,
    onPromptSuggestionDismiss,
    onPromptSuggestionAbort,
  } = props;

  const [dialog, setDialog] = useState<OpenTuiDialogRequest | null>(
    props.initialDialog ?? null,
  );
  const [noticeText, setNoticeText] = useState<string | null>(null);
  const [commandList, setCommandList] = useState<readonly SlashCommand[]>(
    commands ?? [],
  );
  const presentedCommands = useSubscriptionCommandVisibility(
    commandList,
    config,
  );

  const notify = useCallback((text: string) => setNoticeText(text), []);

  // U-33: `!` shell mode (ink shellModeActive parity). The state lives here
  // with the submit routing; the composer only renders the chrome and the
  // toggle. Every running command's controller is kept so quit (and unmount)
  // can kill all of them — a single slot would orphan an older command.
  const [shellModeActive, setShellModeActive] = useState(false);
  const shellControllersRef = useRef<Set<AbortController>>(new Set());
  const { width: terminalWidth, height: terminalHeight } =
    useTerminalDimensions();
  const modBand = useModBand(config);
  // ink renders every dialog inside a region of exactly this height, clipped,
  // with the composer swapped out (`DefaultAppLayout`'s dialog wrapper) — in
  // ink's default state: its show-more-lines key lifts `constrainHeight`, which
  // drops both the height and the clip, while this port keeps the region fixed
  // in every state (recorded as a divergence in the parity design doc). The
  // clip reaches content that shrinks with the region; a child that holds its
  // own size paints past the bottom edge instead of being cut. A
  // content-height region bottom-anchors the popup instead: the transcript
  // keeps the free rows above it, so the box sits lower than ink's and a
  // dialog ink stretches to fill the viewport stays short.
  const dialogRegionHeight = getDialogMaxHeight(
    terminalHeight,
    STATIC_EXTRA_HEIGHT,
  );
  const toggleShellMode = useCallback(
    () => setShellModeActive((active) => !active),
    [],
  );
  // ink's Composer hides the footer while the completion list is open; the
  // list lives inside the composer, so its visibility is lifted here.
  const [showSuggestions, setShowSuggestions] = useState(false);
  const subscriptionActive =
    config.getAuthType() === AuthType.QWEN_SUBSCRIPTION;
  const [subscriptionHintsDismissed, setSubscriptionHintsDismissed] = useState(
    () => Boolean(config.getResumedSessionData()),
  );
  const dismissSubscriptionHints = useCallback(() => {
    if (subscriptionActive) setSubscriptionHintsDismissed(true);
  }, [subscriptionActive]);
  const onSuggestionsVisibilityChange = useCallback(
    (visible: boolean) => setShowSuggestions(visible),
    [],
  );
  // ink's useAutoAcceptIndicator holds the mode locally so a cycle repaints at
  // once — the `approvalMode` prop is only re-read when the entry re-renders —
  // and keeps re-syncing from it so a change made elsewhere (`/plan`, the
  // approval-mode dialog) still lands. Both routes funnel through
  // adoptApprovalMode so entering AUTO explains itself either way.
  const [currentApprovalMode, setCurrentApprovalMode] = useState(approvalMode);
  useEffect(() => {
    setCurrentApprovalMode(approvalMode);
  }, [approvalMode]);
  // emitAutoModeEntryNotices only ever adds INFO rows.
  const addInfoItem = useCallback(
    (item: HistoryItemWithoutId) => {
      if (item.type === MessageType.INFO) {
        onTranscriptEvent?.({ type: 'info', text: item.text });
      }
    },
    [onTranscriptEvent],
  );
  const adoptApprovalMode = useCallback(
    (next: ApprovalMode) => {
      setCurrentApprovalMode(next);
      // Both of ink's routes guard the notices on "was not already AUTO". A
      // rotation can never re-enter AUTO, but the dialog can — it opens with
      // the current mode already selected, so Enter re-picks it and would
      // reprint the stripped-rules notice, the one part of the entry notices
      // that is not idempotent.
      if (
        next === ApprovalMode.AUTO &&
        currentApprovalMode !== ApprovalMode.AUTO
      ) {
        emitAutoModeEntryNotices({ config, settings, addItem: addInfoItem });
      }
      // ink's handleApprovalModeChange pairs the switch with releasing what is
      // already parked: entering an auto-approving mode confirms those calls
      // instead of leaving a dialog up over a mode that would not have asked.
      for (const call of selectAutoApprovals(next, waitingToolCalls ?? [])) {
        void call.confirmationDetails
          .onConfirm(ToolConfirmationOutcome.ProceedOnce)
          .catch(() => {});
        onToolCallSettled?.(call.callId);
      }
    },
    [
      config,
      settings,
      addInfoItem,
      currentApprovalMode,
      waitingToolCalls,
      onToolCallSettled,
    ],
  );
  const cycleApprovalMode = useCallback(() => {
    const next = nextApprovalMode(config.getApprovalMode());
    try {
      config.setApprovalMode(next);
    } catch (e) {
      addInfoItem({ type: MessageType.INFO, text: (e as Error).message });
      return;
    }
    adoptApprovalMode(next);
  }, [config, addInfoItem, adoptApprovalMode]);
  // ink announces AUTO on mount too, so `--approval-mode auto` and
  // `tools.approvalMode: "auto"` do not open a session silently in AUTO. The
  // keypress and dialog routes above never fire for a mode set before start.
  useEffect(() => {
    if (approvalMode === ApprovalMode.AUTO) {
      emitAutoModeEntryNotices({ config, settings, addItem: addInfoItem });
    }
    // Intentionally mount-only, as in ink; later entries go through
    // adoptApprovalMode.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const runShellCommand = useCallback(
    (command: string) => {
      const emit = onTranscriptEvent;
      if (!emit) return;
      const controller = new AbortController();
      shellControllersRef.current.add(controller);
      const sessionId = config.getSessionId();
      onInputProcessed?.();
      return (async () => {
        await logger?.logMessage(MessageSenderType.USER, command);
        if (controller.signal.aborted || sessionId !== config.getSessionId())
          return;
        return executeUserShell(
          config,
          command,
          emit,
          controller.signal,
          // The `!` row renders behind the 2-col input indicator, and the child
          // runs over that inner width (ink parity: it also passes the raw
          // terminal width to its `!` child — no SHELL_WIDTH_FRACTION here,
          // which only reaches the model-driven tool).
          {
            width: Math.max(terminalWidth - STATUS_INDICATOR_WIDTH, 10),
            height: terminalHeight,
          },
        );
      })()
        .catch((error: unknown) => {
          // executeUserShell reports its own failures; this guards the seam
          // itself so a rejection can neither strand the controller in the
          // gate set nor escape the fire-and-forget call sites (R5-7).
          emit({
            type: 'error',
            text: `An unexpected error occurred: ${
              error instanceof Error ? error.message : String(error)
            }`,
          });
        })
        .finally(() => {
          shellControllersRef.current.delete(controller);
          // The drain also waits for the shell lane, so a command finishing has
          // to re-arm it for anything queued while the command held the gate.
          setDeferredRevision((revision) => revision + 1);
        });
    },
    [
      config,
      logger,
      onInputProcessed,
      onTranscriptEvent,
      terminalWidth,
      terminalHeight,
    ],
  );

  // A render teardown (error bailout, unmount) must not leave `!` children
  // running with no transcript to report into.
  useEffect(
    () => () => {
      for (const controller of shellControllersRef.current) {
        controller.abort();
      }
    },
    [],
  );

  // U-9: the shell owns the settings sub-dialog routing (ink DialogManager
  // parity: ui.theme/editor/model rows open their dialogs; anything else
  // closes) and the composer fill the arena picker relies on.
  const handleSelectSetting = useCallback((name: string) => {
    if (name === 'ui.theme') setDialog({ dialog: 'theme' });
    else if (name === 'general.preferredEditor')
      setDialog({ dialog: 'editor' });
    else if (name === 'fastModel') setDialog({ dialog: 'model', mode: 'fast' });
    else if (name === 'visionModel')
      setDialog({ dialog: 'model', mode: 'vision' });
    else setDialog(null);
  }, []);

  const fillComposer = useCallback(
    (text: string) => {
      // The picker unmounts the prompt before remounting it, so the handle
      // is briefly absent; the injector polls until it reattaches.
      injectCapturedInput(() => props.composerHandle?.current ?? null, text);
    },
    [props.composerHandle],
  );

  // Modal confirmation bridge (Batch 6): presentShell/presentAction enqueue
  // a dialog and hand back the promise that its resolution settles. Both
  // functions stay referentially stable (U-8) — they only touch setState and
  // a sequence ref, never per-render state.
  const [modals, setModals] = useState<readonly ConfirmationModal[]>([]);
  const modalSeq = useRef(0);
  const ownedActionModals = useRef(
    new Set<{
      cancel: () => void;
      dispose: () => void;
      isCurrent?: () => boolean;
    }>(),
  );
  useEffect(() => {
    for (const owned of [...ownedActionModals.current]) {
      if (owned.isCurrent?.() === false) owned.cancel();
    }
  });
  useEffect(
    () => () => {
      for (const owned of [...ownedActionModals.current]) owned.dispose();
    },
    [],
  );
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
      presentAction: (
        prompt: ReactNode,
        options?: Pick<ConfirmationRequest, 'signal' | 'isCurrent'>,
      ) =>
        new Promise<boolean>((resolve) => {
          const signal = options?.signal;
          const isCurrent = options?.isCurrent;
          if (signal?.aborted || isCurrent?.() === false) {
            resolve(false);
            return;
          }
          const id = ++modalSeq.current;
          let settled = false;
          const finish = (confirmed: boolean, remove = true) => {
            if (settled) return;
            settled = true;
            signal?.removeEventListener('abort', abort);
            ownedActionModals.current.delete(lifetime);
            if (remove) setModals((prev) => prev.filter((m) => m.id !== id));
            resolve(confirmed && !signal?.aborted && isCurrent?.() !== false);
          };
          const abort = () => finish(false);
          const lifetime = {
            cancel: abort,
            dispose: () => finish(false, false),
            isCurrent,
          };
          if (signal || isCurrent) {
            signal?.addEventListener('abort', abort, { once: true });
            ownedActionModals.current.add(lifetime);
          }
          setModals((prev) => [
            ...prev,
            {
              kind: 'action',
              id,
              prompt,
              resolve: (confirmed) => finish(confirmed),
            },
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
      modal.resolve(confirmed);
    },
    [],
  );

  const activeToolCall = waitingToolCalls?.[0] ?? null;

  // ink drives the gated-server approval queue from a renderer-agnostic hook at
  // app level; without it a `.mcp.json` checked into the project is never
  // offered here and its servers stay silently disconnected.
  const mcpApproval = useMcpApproval(config);

  const shellControl = props.foregroundShellControl;
  const foregroundShell = shellControl?.foregroundShell;
  const [shellFocus, setShellFocus] = useState<ForegroundShellOwner | null>(
    null,
  );
  const shellBlocked = Boolean(
    dialog ||
      activeModal ||
      activeToolCall ||
      mcpApproval.isMcpApprovalDialogOpen ||
      shellModeActive,
  );
  const shellFocused =
    !shellBlocked &&
    !!foregroundShell &&
    shellFocus?.callId === foregroundShell.callId &&
    shellFocus.pid === foregroundShell.pid &&
    shellFocus.turn === foregroundShell.turn;
  useEffect(() => {
    if (!shellFocused) setShellFocus(null);
  }, [shellFocused]);

  const controlsRef = useRef<BoxRenderable | null>(null);
  const [controlsHeight, setControlsHeight] = useState(0);
  const shellColumns = Math.max(1, Math.floor(terminalWidth * 0.89));
  const shellRows = Math.max(1, terminalHeight - controlsHeight - 10);
  const resizeShell = shellControl?.resizeShell;
  const hasShellControl = Boolean(shellControl);
  const shellCallId = foregroundShell?.callId;
  const shellPid = foregroundShell?.pid;
  const shellTurn = foregroundShell?.turn;
  useEffect(() => {
    if (!hasShellControl) return;
    config.setShellExecutionConfig({
      ...config.getShellExecutionConfig(),
      terminalWidth: shellColumns,
      terminalHeight: shellRows,
    });
  }, [config, hasShellControl, shellColumns, shellRows]);
  useEffect(() => {
    if (
      shellCallId !== undefined &&
      shellPid !== undefined &&
      shellTurn !== undefined
    )
      resizeShell?.(
        { callId: shellCallId, pid: shellPid, turn: shellTurn },
        shellColumns,
        shellRows,
      );
  }, [shellCallId, shellPid, shellTurn, resizeShell, shellColumns, shellRows]);

  const handleShellKey = (key: KeyEvent): boolean => {
    if (key.eventType === 'release' || shellBlocked || !shellControl)
      return false;
    if (
      matchesCommand(Command.PROMOTE_SHELL_TO_BACKGROUND, key) &&
      shellControl.promoteShellToBackground()
    ) {
      setShellFocus(null);
      return true;
    }
    if (
      matchesCommand(Command.TOGGLE_SHELL_INPUT_FOCUS, key) &&
      foregroundShell
    ) {
      setShellFocus(shellFocused ? null : foregroundShell);
      return true;
    }
    if (!shellFocused || !foregroundShell) return false;
    // Ink's global exit/cancel guard runs before terminal input.
    if (
      matchesCommand(Command.QUIT, key) ||
      (matchesCommand(Command.EXIT, key) &&
        !props.composerHandle?.current?.getText())
    )
      return false;
    if (key.ctrl && key.shift && (key.name === 'up' || key.name === 'down')) {
      shellControl.scrollShell(foregroundShell, key.name === 'up' ? -1 : 1);
    } else {
      const sequence = keyToAnsi(toOriginalKey(key));
      if (sequence && !shellControl.writeShellInput(foregroundShell, sequence))
        setShellFocus(null);
    }
    return !(
      matchesCommand(Command.EXIT, key) ||
      matchesCommand(Command.TOGGLE_THINKING_EXPANDED, key) ||
      (key.name === 'tab' && key.shift && !key.ctrl)
    );
  };
  const handleShellPaste = (text: string): boolean => {
    if (!shellFocused || !foregroundShell || !shellControl) return false;
    if (!shellControl.writeShellInput(foregroundShell, text))
      setShellFocus(null);
    return true;
  };

  // Shift+Tab lives here, not in the composer: ink mounts useAutoAcceptIndicator
  // at App level (disabled only for the agent-tab view), so it still cycles
  // while a dialog or a confirmation has the composer unmounted. The composer
  // keeps only the Windows bare-Tab fallback — the one route that has to know
  // whether Tab was already spent on a completion.
  useKeyboard((key: KeyEvent) => {
    if (shellFocused && handleShellKey(key)) {
      key.preventDefault();
      key.stopPropagation();
      return;
    }
    const { name, shift, ctrl } = toOriginalKey(key);
    if (
      key.eventType !== 'release' &&
      !streaming &&
      !dialog &&
      !activeModal &&
      !activeToolCall &&
      !mcpApproval.isMcpApprovalDialogOpen &&
      (name === 'escape' || (name === 'c' && ctrl))
    ) {
      for (const controller of shellControllersRef.current) {
        controller.abort();
      }
    }
    if (name !== 'tab' || !shift || ctrl) return;
    key.preventDefault();
    cycleApprovalMode();
  });

  // ink AppContainer's contextFilesAnnouncedRef: the context-file set is
  // announced once per session, on the first submission that reaches a model.
  const contextFilesAnnouncedRef = useRef(
    props.startupHistory?.some(isContextFilesAnnouncement) ?? false,
  );

  const transcript = useMemo(() => {
    const reset = (events: OpenTuiStreamEvent[]) => {
      contextFilesAnnouncedRef.current = events.some(
        isContextFilesAnnouncement,
      );
      onTranscriptReset?.(events);
    };
    return {
      reset,
      // /clear semantics: a fresh transcript — the live turn's reset with an
      // empty batch (it also drops a stray steering queue).
      clear: () => reset([]),
      append: (event: OpenTuiStreamEvent) => onTranscriptEvent?.(event),
    };
  }, [onTranscriptReset, onTranscriptEvent]);

  const loggerRef = useRef(logger);
  loggerRef.current = logger;
  const historyItemsRef = useRef(props.historyItems);
  historyItemsRef.current = props.historyItems;
  const rewindIdleRef = useRef(!streaming);
  rewindIdleRef.current = !streaming;
  const rewindInjectionRef = useRef<(() => void) | null>(null);
  useEffect(() => () => rewindInjectionRef.current?.(), []);
  const voiceMicWarnedStatusRef = useRef<MicrophonePermission | null>(null);
  const host = useMemo(
    () =>
      new OpenTuiAppHost({
        config,
        settings,
        startupHistory: props.startupHistory,
        get logger() {
          return loggerRef.current;
        },
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
      props.startupHistory,
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

  const rewind = useCallback(
    async (userId: string, option: RestoreOption) => {
      const snapshot = historyItemsRef.current;
      const index = snapshot?.findIndex((item) => item.id === userId) ?? -1;
      if (
        !snapshot ||
        index < 0 ||
        !rewindIdleRef.current ||
        !onRewindTranscript ||
        !onTranscriptEvent ||
        !isCurrentHistory?.(snapshot)
      )
        return;
      const sessionId = config.getSessionId();
      const request = dialogRef.current;
      let committedHost: readonly HistoryItem[] | undefined;
      let committedItems: readonly LiveHistoryItem[] | undefined;
      let rewoundDraft: string | undefined;
      const boundary = rewindBoundaryHistory(snapshot);
      const target = boundary.find((item) => item.id === index);
      if (!target) return;
      const current = () =>
        config.getSessionId() === sessionId &&
        isCurrentHistory!(committedItems ?? snapshot) &&
        (!committedHost || host.getHistory() === committedHost);
      try {
        const outcome = await rewindSession(
          config,
          boundary,
          target,
          option,
          (_truncated, draft) => {
            committedItems = onRewindTranscript!(userId);
            contextFilesAnnouncedRef.current =
              committedItems?.some(
                (item) =>
                  item.kind === 'info' &&
                  isContextFilesAnnouncement({ type: 'info', text: item.text }),
              ) ?? false;
            const hostHistory = host.getHistory();
            const firstRemovedHost = hostHistory.findIndex((item) =>
              snapshot.slice(index).some((live) => live.historyId === item.id),
            );
            const retainedHost = expandCollapsedHistory(
              hostHistory.slice(
                0,
                firstRemovedHost < 0 ? hostHistory.length : firstRemovedHost,
              ),
            );
            host.loadHistory(retainedHost);
            committedHost = retainedHost;
            rewoundDraft = draft;
            return (
              snapshot.filter(
                (item) => item.display?.kind !== 'collapse-summary',
              ).length - (committedItems?.length ?? 0)
            );
          },
          current,
        );
        if (!outcome.stale && current()) {
          if (committedItems)
            committedItems =
              onTranscriptEvent({
                type: 'info',
                text: t(
                  'Conversation rewound. Edit your prompt and press Enter to continue.',
                ),
              }) ?? committedItems;
          for (const message of outcome.messages) {
            const event = projectItemToStreamEvent(message, {});
            if (event) {
              const next = onTranscriptEvent(event);
              if (committedItems && next) committedItems = next;
            }
          }
          if (rewoundDraft !== undefined && current()) {
            rewindInjectionRef.current?.();
            rewindInjectionRef.current = injectCapturedInput(() => {
              const handle = props.composerHandle?.current;
              if (!handle) return null;
              return {
                setText: (text: string) => {
                  if (!current() || handle.getText()) return;
                  handle.invalidateImportedInput?.();
                  handle.setText(text);
                },
              };
            }, rewoundDraft);
          }
        }
      } catch (error) {
        if (current())
          host.addItem(
            {
              type: 'error',
              text: t('Rewind failed: {{error}}', {
                error: error instanceof Error ? error.message : String(error),
              }),
            },
            Date.now(),
          );
      } finally {
        setDialog((active) => (active === request ? null : active));
      }
    },
    [
      config,
      host,
      onRewindTranscript,
      isCurrentHistory,
      props.composerHandle,
      onTranscriptEvent,
    ],
  );

  const worktree = useWorktreeSession(config);
  const activeWorktree = worktree
    ? {
        slug: worktree.slug,
        path: worktree.worktreePath,
        branch: worktree.worktreeBranch,
        originalCwd: worktree.originalCwd,
        originalBranch: worktree.originalBranch,
        originalHeadCommit: worktree.originalHeadCommit,
      }
    : null;
  const branchName = useGitBranchName(config.getTargetDir());
  const [currentModel, setCurrentModel] = useState(() => config.getModel());
  useEffect(() => config.onModelChange(setCurrentModel), [config]);
  const statusLineState = {
    sessionStats: props.sessionStats ?? getSessionStats(),
    currentModel,
    branchName,
    activeWorktree,
    streamingState: props.waitingToolCalls?.length
      ? StreamingState.WaitingForConfirmation
      : streaming
        ? StreamingState.Responding
        : StreamingState.Idle,
  };
  const statusLine = useStatusLineState(
    {
      settings,
      config,
      state: statusLineState,
      terminalWidth,
      vimMode: props.vimMode,
    },
    isNarrowWidth(terminalWidth),
  );

  // Mirror the live-turn state onto the host so command gating (isIdle)
  // reflects an in-flight model turn, not just dispatcher processing.
  useEffect(() => {
    host.setStreaming(!!streaming);
  }, [host, streaming]);

  useEffect(() => {
    config.setWorkflowKeywordTriggerEnabled?.(
      settings.merged.ui?.disableWorkflowKeywordTrigger !== true,
    );
  }, [config, settings.merged.ui?.disableWorkflowKeywordTrigger]);

  const gateway = useMemo(() => new OpenTuiSlashGateway(), []);
  const reloadRef = useRef<(() => void | Promise<void>) | null>(null);
  // Slash and shell submissions held back while a model turn streams (ink's
  // message queue; a queued shell entry carries its routing so the drain
  // cannot be fooled by a mid-turn toggle).
  const deferredCommandsRef = useRef<
    Array<{
      text: string;
      shell?: boolean;
      prompt?: boolean;
      imagePaths?: readonly string[];
      options?: OpenTuiSubmitOptions;
    }>
  >([]);
  // Push nonce for the drain (ink's queueDrainNonce). The queue itself stays a
  // ref so re-queueing behind a turn or a dialog does not re-trigger the
  // effect, but a push has to: the mid-turn gate awaits the registry, and a
  // verdict that lands after the idle edge would otherwise strand the command
  // until some future streaming transition.
  const [deferredRevision, setDeferredRevision] = useState(0);
  const deferredPrompts = deferredCommandsRef.current.filter(
    (entry) => entry.prompt,
  );
  const displayedQueue = [
    ...(messageQueue ?? []),
    ...deferredPrompts.map((entry) => entry.text),
  ];
  const queueLength = displayedQueue.length;
  const popQueue = useCallback((): OpenTuiInputSubmission | null => {
    const live = onPopQueue?.();
    const prompts = deferredCommandsRef.current.filter((entry) => entry.prompt);
    deferredCommandsRef.current = deferredCommandsRef.current.filter(
      (entry) => !entry.prompt,
    );
    setDeferredRevision((revision) => revision + 1);
    if (!live && prompts.length === 0) return null;
    return restoreInputSubmissions([
      ...(live ? [live] : []),
      ...prompts.map((entry) => ({
        ...entry.options,
        text: entry.text,
        imagePaths: entry.imagePaths,
      })),
    ]);
  }, [onPopQueue]);
  const queueSessionId = config.getSessionId();
  const queueSessionRef = useRef(queueSessionId);
  useEffect(() => {
    if (queueSessionRef.current === queueSessionId) return;
    queueSessionRef.current = queueSessionId;
    deferredCommandsRef.current = [];
    setDeferredRevision((revision) => revision + 1);
  }, [queueSessionId]);
  // Guards one drain instance at a time (R5-6).
  const drainingRef = useRef(false);
  // Render-mirrored gate state for the drain's mid-loop re-check (R6-4): the
  // effect samples streaming/dialog once, but a canRunDuringStreaming dispatch
  // admitted during a shell entry's await window can open a dialog or start a
  // turn, and the entries behind it must wait like newly submitted ones.
  const streamingRef = useRef(streaming);
  useEffect(() => {
    streamingRef.current = streaming;
  }, [streaming]);
  const dialogRef = useRef(dialog);
  useEffect(() => {
    dialogRef.current = dialog;
  }, [dialog]);

  useEffect(() => {
    const dispatcher = new OpenTuiSlashDispatcher(
      host,
      {
        config,
        settings,
        get logger() {
          return loggerRef.current;
        },
        extensionRefreshState,
        onInputProcessed,
      },
      commands ?? [],
    );
    reloadRef.current = async () => {
      await dispatcher.loadCommands();
      if (!disposed) setCommandList(dispatcher.commands);
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
    commands,
    extensionRefreshState,
    onInputProcessed,
  ]);

  const applyOutcome = useCallback(
    (outcome: OpenTuiDispatchOutcome) => {
      switch (outcome.kind) {
        case 'handled':
          return true;
        case 'open_dialog':
          if (outcome.request.dialog === 'rewind') {
            if (
              streaming ||
              !props.historyItems?.some((item) => item.kind === 'user')
            )
              return true;
            if (config.getIdeMode()) {
              host.addItem(
                { type: 'info', text: 'Rewind is disabled in IDE mode.' },
                Date.now(),
              );
              return true;
            }
          }
          setDialog(outcome.request);
          return true;
        case 'submit_prompt':
          if (onSubmitPrompt)
            return onSubmitPrompt(outcome.content, undefined, {
              promptId: outcome.promptId,
              modelOverride: outcome.modelOverride,
              refreshContextFilesOnWrite: outcome.refreshContextFilesOnWrite,
              onComplete: outcome.onComplete,
              invocationEchoed: true,
            });
          notify('The live prompt turn is not wired in this shell.');
          return false;
        case 'schedule_tool':
          return outcome.restoreResponseBinding
            ? (onScheduleTool?.(
                outcome.toolName,
                outcome.toolArgs,
                outcome.restoreResponseBinding,
              ) ?? false)
            : (onScheduleTool?.(outcome.toolName, outcome.toolArgs) ?? false);
        case 'quit':
          // Clear both queues before interrupt creates the shell's idle edge.
          // The live turn also suppresses late restored steering after abort.
          deferredCommandsRef.current = [];
          onPopQueue?.();
          // A running `!` shell command dies with the session too — every
          // one of them, not just the most recent.
          for (const controller of shellControllersRef.current) {
            controller.abort();
          }
          // ink's quit action cancels the ongoing request before the exit
          // drains, so a mid-turn /quit stops the stream instead of racing the
          // cleanup chain (recording flush, config.shutdown) against a turn
          // that is still writing. A no-op when nothing is in flight.
          onInterrupt?.();
          onQuit?.(outcome.messages);
          return true;
        default: {
          const exhaustive: never = outcome;
          return exhaustive;
        }
      }
    },
    [
      onSubmitPrompt,
      onQuit,
      onInterrupt,
      onPopQueue,
      notify,
      onScheduleTool,
      props.historyItems,
      streaming,
      config,
      host,
    ],
  );

  const onSubmit = useCallback(
    async (
      text: string,
      imagePaths?: readonly string[],
      options?: OpenTuiSubmitOptions,
    ): Promise<boolean> => {
      const sessionId = config.getSessionId();
      const hasImages = !!imagePaths?.length;
      if (hasImages && shellModeActive) {
        notify(
          'Image attachments cannot be submitted in shell mode. Exit shell mode and try again.',
        );
        return false;
      }
      if (hasImages && gateway.isBusy()) {
        notify('A slash command is already running.');
        return false;
      }
      setNoticeText(null);
      // Ahead of the gate and the dispatch, exactly where ink's
      // handleFinalSubmit puts it: a quit has to be able to stop the stream, so
      // it must not be deferred behind the turn or reach the model as text.
      const submission = normalizeQuitSubmission(text);
      // ink parity (AppContainer.handleFinalSubmit): while a turn responds,
      // only a command that opted into canRunDuringStreaming runs now — the
      // rest wait for idle instead of racing the stream. A shell-mode
      // submission (non-slash) defers the same way, tagged so the drain
      // routes it back to the executor; the tag asks the dispatcher's own
      // admission rule, not a re-derived classifier, or a `?`-form the
      // dispatcher takes would run as a shell command. A running `!` command
      // holds the same gate (ink keeps isResponding for the whole execution):
      // a concurrent submission would race the command's LLM-history write
      // into a live turn's chat.
      if (streaming || shellControllersRef.current.size > 0) {
        const takesAsSlash =
          !hasImages && (await gateway.takesAsSlashCommand(submission));
        const shellEntry = shellModeActive && !takesAsSlash;
        // A plain prompt submitted while a `!` command runs must not start a
        // turn even when shell mode was toggled off meanwhile (Esc): the
        // command's completion injects LLM history between sends, and a
        // concurrent turn turns that write into a mid-turn addHistory
        // (R5-5). Ink holds the same gate via isResponding covering the
        // whole execution. Slash-form input is exempt — the dispatcher's own
        // admission rule (quit, canRunDuringStreaming, ?btw fork) decides.
        const blockedByRunningShell =
          !takesAsSlash && shellControllersRef.current.size > 0;
        if (
          shellEntry ||
          blockedByRunningShell ||
          (!hasImages && (await gateway.mustDeferDuringStreaming(submission)))
        ) {
          if (isExitInProgress() || sessionId !== config.getSessionId())
            return false;
          if (shellEntry && !props.onTranscriptEvent) {
            notify('The shell command owner is not wired in this shell.');
            return false;
          }
          const command = submission.trim();
          deferredCommandsRef.current.push({
            text: command,
            shell: shellEntry,
            // The attachments ride the entry: the seam's contract keeps image
            // paths in the second, structured argument, so a prompt the
            // running-`!` gate held back must not lose them in the queue
            // (R5-5 fix-induced).
            ...(blockedByRunningShell && !shellEntry
              ? { prompt: true, imagePaths, options }
              : {}),
          });
          setDeferredRevision((revision) => revision + 1);
          notify(
            `Queued ${command} — it will run when the current response ends.`,
          );
          return true;
        }
      }
      if (isExitInProgress() || sessionId !== config.getSessionId())
        return false;
      const settlement = hasImages
        ? { kind: 'settled' as const, outcome: false as const }
        : await gateway.dispatch(submission);
      if (settlement.kind === 'rejected') {
        notify(settlement.reason);
        return false;
      }
      if (settlement.outcome === false) {
        // ink order (use-llm-stream): slash commands dispatch first; a
        // shell-mode submission runs only when dispatch did not claim it.
        const query = text.trim();
        // ink AppContainer's one-shot context-files announcement. The latch is
        // consulted before the shell-mode intercept because the shared helper
        // is what decides whether the submission reaches the model, and it
        // needs shellModeActive to decide.
        if (
          !contextFilesAnnouncedRef.current &&
          consumesContextAnnouncementLatch(query, {
            shellModeActive,
            slashCommands: commandList,
          })
        ) {
          const contextFilePaths = config.getContextFilePaths();
          if (contextFilePaths.length > 0) {
            contextFilesAnnouncedRef.current = true;
            addInfoItem({
              type: MessageType.INFO,
              text: `${CONTEXT_FILES_ANNOUNCEMENT_PREFIX} ${contextFilePaths.join(', ')}`,
            });
          }
        }
        if (shellModeActive && query) {
          const started = runShellCommand(query);
          if (!started)
            notify('The shell command owner is not wired in this shell.');
          return started !== undefined;
        }
        if (!onSubmitPrompt) {
          notify('The live prompt turn is not wired in this shell.');
          return false;
        }
        // The raw typed text is both the prompt and the `UserPromptSubmit`
        // provenance; `@path` expansion happens where the prompt enters the
        // stream (live-session), so text queued mid-turn expands too.
        if (isExitInProgress() || sessionId !== config.getSessionId())
          return false;
        return onSubmitPrompt(query, imagePaths, {
          ...options,
          submittedPrompt: options?.submittedPrompt ?? (query || undefined),
        });
      }
      return applyOutcome(settlement.outcome);
    },
    [
      gateway,
      onSubmitPrompt,
      applyOutcome,
      notify,
      streaming,
      shellModeActive,
      runShellCommand,
      config,
      commandList,
      addInfoItem,
      props.onTranscriptEvent,
    ],
  );

  // Runs the commands the mid-turn gate held back, in submission order, once
  // the turn ends and no dialog owns the UI (ink's shouldDrainMessageQueue
  // gates the drain on both).
  useEffect(() => {
    // Nothing queued may run behind an exit either way: the exits that bypass
    // this shell's quit branch (Ctrl+C/Ctrl+D double press, render-error
    // bailout) never clear this ref, so the drain itself must consult the
    // shared exit latch — at the edge and between dispatches, since the exit
    // can start while an earlier command is still awaiting its outcome.
    if (isExitInProgress()) return;
    // A running `!` command holds the same gate as a live turn: entries queued
    // behind it must wait for it to end (its own finally re-arms this drain).
    if (
      streaming ||
      dialog ||
      shellControllersRef.current.size > 0 ||
      deferredCommandsRef.current.length === 0
    ) {
      return;
    }
    // One drain at a time: a re-arm that lands mid-drain (a shell entry's own
    // finally bumps the revision) must be a no-op, not a second instance
    // racing the first on the gateway's single busy slot — the loser's
    // command would be dropped with a busy rejection (R5-6). The queue is a
    // ref, so the release below bumps the revision or entries queued behind
    // a live drain strand.
    if (drainingRef.current) return;
    drainingRef.current = true;
    const drainSessionId = config.getSessionId();
    const pending = deferredCommandsRef.current;
    deferredCommandsRef.current = [];
    void (async () => {
      // A holdsUi pause re-queues the remainder for the turn/dialog it waits
      // for; re-arming here would drain it before that owner even starts.
      let paused = false;
      try {
        for (const [i, entry] of pending.entries()) {
          if (isExitInProgress() || drainSessionId !== config.getSessionId())
            return;
          // Re-read the gate after the previous iteration's await (R6-4): the
          // re-queue mirrors the holdsUi branch — paused, no re-arm — so the
          // dep change that closed the gate is what resumes the batch.
          if (
            streamingRef.current ||
            dialogRef.current ||
            shellControllersRef.current.size > 0
          ) {
            deferredCommandsRef.current.unshift(...pending.slice(i));
            paused = true;
            return;
          }
          if (entry.shell) {
            await runShellCommand(entry.text);
            continue;
          }
          if (entry.prompt) {
            // A plain prompt the running-`!` gate held back (R5-5). Routed
            // straight to the seam: dispatch would answer outcome=false and
            // the drain drops that silently.
            if (!onSubmitPrompt) {
              notify('The live prompt turn is not wired in this shell.');
              deferredCommandsRef.current.unshift(...pending.slice(i));
              paused = true;
              return;
            }
            const accepted = onSubmitPrompt(entry.text, entry.imagePaths, {
              ...entry.options,
              submittedPrompt:
                entry.options?.submittedPrompt ?? (entry.text || undefined),
            });
            if (!accepted) {
              deferredCommandsRef.current.unshift(...pending.slice(i));
              paused = true;
              notify(
                'Queued prompt was not accepted. Press Up to restore it and retry.',
              );
              return;
            }
            // The turn it starts owns the drain until it ends, exactly like a
            // dispatched submit_prompt outcome below.
            if (i + 1 < pending.length) {
              deferredCommandsRef.current.unshift(...pending.slice(i + 1));
              paused = true;
            }
            return;
          }
          const settlement = await gateway.dispatch(entry.text);
          if (settlement.kind === 'rejected') {
            notify(settlement.reason);
            continue;
          }
          if (settlement.outcome === false) continue;
          const outcome = settlement.outcome;
          applyOutcome(outcome);
          // A submit_prompt outcome starts a turn and an open_dialog outcome
          // takes the UI over, so the commands behind either wait for that turn
          // to end or that dialog to close rather than racing the stream or
          // overwriting the dialog with a second setDialog().
          const holdsUi =
            outcome.kind === 'open_dialog' ||
            (outcome.kind === 'submit_prompt' && !!onSubmitPrompt);
          if (holdsUi && i + 1 < pending.length) {
            deferredCommandsRef.current.unshift(...pending.slice(i + 1));
            paused = true;
            return;
          }
        }
      } finally {
        drainingRef.current = false;
        // Entries that arrived mid-drain strand unless the completion re-arms
        // the drain (the queue is a ref; a push alone triggers nothing) — but
        // a holdsUi pause must not re-arm, or the remainder runs before the
        // turn/dialog it waits for even starts (R5-6).
        if (!paused) setDeferredRevision((revision) => revision + 1);
      }
    })();
  }, [
    streaming,
    dialog,
    deferredRevision,
    gateway,
    notify,
    applyOutcome,
    onSubmitPrompt,
    runShellCommand,
    config,
  ]);

  const hostHistory = host.getHistory();
  const sessionId = config.getSessionId();
  const [pastMessages, setPastMessages] = useState<readonly string[]>([]);
  useEffect(() => {
    let current = true;
    void (logger?.getPreviousUserMessages() ?? Promise.resolve([])).then(
      (past) => {
        if (current) setPastMessages(past);
      },
      (error: unknown) =>
        debugLogger.debug('Could not load input history', error),
    );
    return () => {
      current = false;
    };
  }, [logger, sessionId, hostHistory]);
  const userMessages = useMemo(() => {
    const typed = props.userMessages ?? realUserPromptTexts(hostHistory);
    return [...new Set([...typed].reverse().concat(pastMessages))].reverse();
  }, [props.userMessages, hostHistory, pastMessages]);

  const lastSubscriptionLogin = hostHistory.findLastIndex(
    (item) =>
      item.type === 'info' && item.presentation === 'subscription-success',
  );
  const hasPriorInput =
    lastSubscriptionLogin < 0
      ? userMessages.some((text) => text.trim() !== '/auth')
      : hostHistory
          .slice(lastSubscriptionLogin + 1)
          .some((item) => item.type === 'user' && item.text.trim() !== '/auth');
  useEffect(() => {
    if (hasPriorInput || streaming) dismissSubscriptionHints();
  }, [hasPriorInput, streaming, dismissSubscriptionHints]);

  // ink's Composer drops the phrase (not the row) when this setting is off.
  const showLoadingPhrases =
    config.getAccessibility()?.enableLoadingPhrases !== false;

  return (
    <OpenTuiErrorBoundary
      recordForExitEcho
      onError={(error) => onRenderError?.(error)}
    >
      <box flexDirection="column" height={terminalHeight} flexShrink={0}>
        {/* Everything that flows lives here, and it is the alt-screen stand-in
            for ink's <Static>: the column is bounded by the terminal, so the
            region keeps only the tail of the conversation, pinned to its last
            row until the user scrolls away from the bottom.

            `focusable={false}` because a scroll region is not an input target
            here. @opentui auto-focuses the first focusable ancestor under a
            left mouse-down, and its ScrollBox is focusable by default, so
            clicking the conversation — the most natural gesture on a page of
            transcript — moved the focus off the composer's editor and nothing
            moved it back: `focused` is unchanged so the reconciler skips it.
            The editor then kept the printable keys (the composer's own global
            handler feeds them) but lost every key only the focused editor
            handles: the caret stopped moving, and a paste no longer reached
            the buffer. ink parses mouse reports too, but only into handlers a
            surface subscribes to and hit-tests against its own rows, and none
            of them can write the composer's focus — that is a React prop — so
            a click there changes nothing. */}
        <scrollbox
          flexGrow={1}
          flexShrink={1}
          minHeight={0}
          stickyScroll
          stickyStart="bottom"
          focusable={false}
        >
          <OpenTuiBanner config={config} settings={settings} />
          {renderMain
            ? renderMain({
                owner: foregroundShell ?? null,
                focused: shellFocused,
              })
            : null}
          {!dialog &&
          !activeModal &&
          !activeToolCall &&
          !mcpApproval.isMcpApprovalDialogOpen &&
          updateNotice ? (
            <text>{updateNotice}</text>
          ) : null}
          {noticeText ? <text>{noticeText}</text> : null}
        </scrollbox>
        {/* The chrome below the scroll region must be locked against shrinking:
            Yoga otherwise spreads the scroll region's content height over the
            column and squeezes the composer's three border rows into one row
            painted three times. */}
        <box
          flexDirection="column"
          flexShrink={0}
          ref={(el) => {
            controlsRef.current = el as BoxRenderable | null;
          }}
          onSizeChange={() =>
            setControlsHeight(controlsRef.current?.height ?? 0)
          }
        >
          {mcpApproval.isMcpApprovalDialogOpen &&
          mcpApproval.currentMcpApproval ? (
            // ink ranks the gated-server approval above both the shell and the
            // tool confirmation, so it takes the slot outright.
            <OpenTuiMcpApprovalDialog
              key={`mcp-${mcpApproval.currentMcpApproval.name}`}
              server={mcpApproval.currentMcpApproval}
              pendingServers={mcpApproval.pendingMcpApprovals}
              remaining={mcpApproval.mcpApprovalRemaining}
              onSelect={mcpApproval.handleMcpApprovalSelect}
            />
          ) : activeToolCall ? (
            <box key="tool-confirm-area" flexDirection="column">
              <OpenTuiToolConfirmation
                key={activeToolCall.callId}
                call={activeToolCall}
                config={config}
                onSettled={() => onToolCallSettled?.(activeToolCall.callId)}
              />
              {/* ink's Composer marginTop: one blank between the confirmation's
                own bottom padding and the waiting row. */}
              <box marginTop={1}>
                <OpenTuiLoadingIndicator
                  streaming={Boolean(streaming)}
                  waiting
                  showPhrase={showLoadingPhrases}
                />
              </box>
            </box>
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
            // ink's layout wraps every popup in a two-column margin and caps its
            // width, so a dialog's border runs from column 2 to column 97 instead
            // of spanning the terminal. The confirmations stay outside: their
            // body reads the terminal width to estimate line wrapping.
            //
            // The keys on this branch and the composer's are load-bearing: both
            // are a `<box>` in the same slot, so without them React reuses one
            // instance and diffs props — and @opentui's margin/width setters
            // ignore the `null` its reconciler passes for a removed prop, leaving
            // the previous branch's layout stuck on the node.
            <box
              key="dialog-area"
              flexDirection="column"
              marginLeft={2}
              width={dialogAreaWidth(terminalWidth)}
              height={dialogRegionHeight}
              overflow="hidden"
            >
              <OpenTuiDialogMount
                extensionRefreshState={extensionRefreshState}
                key={dialog.dialog}
                request={dialog}
                host={host}
                config={config}
                settings={settings}
                commands={presentedCommands}
                onClose={() => setDialog(null)}
                onSubscriptionActivated={() =>
                  setSubscriptionHintsDismissed(false)
                }
                notify={notify}
                fillInput={fillComposer}
                onSelectSetting={handleSelectSetting}
                onRestartRequest={() =>
                  applyOutcome({ kind: 'quit', messages: [] })
                }
                onApprovalModeChanged={adoptApprovalMode}
                availableTerminalHeight={dialogRegionHeight}
                statusLineState={statusLineState}
                rewindTurns={rewindBoundaryHistory(
                  props.historyItems ?? [],
                ).flatMap((boundary) => {
                  const item = props.historyItems?.[boundary.id];
                  return item?.kind === 'user' && isRewindableUserTurn(boundary)
                    ? [item]
                    : [];
                })}
                onRewind={(turn, option) => rewind(turn.id, option)}
              />
            </box>
          ) : (
            <box key="composer" flexDirection="column" marginTop={1}>
              <OpenTuiLoadingIndicator
                streaming={Boolean(streaming) && !shellFocused}
                streamingCharsRef={streamingCharsRef}
                isReceivingContent={isReceivingContent}
                showPhrase={showLoadingPhrases}
              />
              <OpenTuiQueuedMessageDisplay messageQueue={displayedQueue} />
              <OpenTuiModBand
                band={modBand}
                maxRows={modBandMaxRows(terminalHeight)}
              />
              <OpenTuiInputPrompt
                placeholder={
                  subscriptionActive
                    ? '  ' + t('Type your request, or /usage')
                    : undefined
                }
                onSubmit={(text, imagePaths, options) => {
                  dismissSubscriptionHints();
                  return onSubmit(text, imagePaths, options);
                }}
                onInputActivity={dismissSubscriptionHints}
                onNotice={notify}
                voice={{
                  settings,
                  voiceMicWarnedStatusRef,
                  addItem: (item, at) => host.addItem(item, at),
                }}
                preferredEditor={settings.merged.general?.preferredEditor}
                topRightLabel={host.sessionName ?? undefined}
                userMessages={userMessages}
                config={config}
                focus={!shellFocused}
                onShellKey={handleShellKey}
                onShellPaste={handleShellPaste}
                streaming={streaming}
                onInterrupt={onInterrupt}
                onRetry={
                  props.onRetryPrompt
                    ? () => {
                        if (shellControllersRef.current.size > 0) return;
                        if (gateway.isBusy()) {
                          notify('A slash command is already running.');
                          return;
                        }
                        props.onRetryPrompt?.();
                      }
                    : undefined
                }
                onRewind={() => {
                  if (
                    !config.getIdeMode() &&
                    props.historyItems?.some((item) => item.kind === 'user')
                  )
                    setDialog({ dialog: 'rewind' });
                }}
                onCancelCommand={() => {
                  if (!gateway.isBusy()) return false;
                  gateway.cancel();
                  return true;
                }}
                approvalMode={currentApprovalMode}
                queueLength={queueLength}
                onPopQueue={popQueue}
                composerHandle={props.composerHandle}
                vim={props.vim}
                promptSuggestion={promptSuggestion}
                onPromptSuggestionDismiss={onPromptSuggestionDismiss}
                onPromptSuggestionAbort={onPromptSuggestionAbort}
                shellModeActive={shellModeActive}
                onToggleShellMode={toggleShellMode}
                onSuggestionsVisibilityChange={onSuggestionsVisibilityChange}
                onCycleApprovalMode={cycleApprovalMode}
              />
              {subscriptionActive &&
                !subscriptionHintsDismissed &&
                !hasPriorInput &&
                !streaming &&
                !showSuggestions && (
                  <text marginTop={1} fg={C.dim}>
                    {t('Try:')}
                    {'  '}
                    <span attributes={8} fg={C.purple}>
                      /usage
                    </span>
                    {'  '}
                    <span attributes={8} fg={C.purple}>
                      /status
                    </span>
                    {'  '}
                    <span attributes={8} fg={C.purple}>
                      /upgrade
                    </span>
                    {'  '}
                    <span attributes={8} fg={C.purple}>
                      /logout
                    </span>
                  </text>
                )}
            </box>
          )}
          {/* An armed quit warning forces the footer to mount: a dialog unmounts
            the composer, so nothing intercepts Ctrl+C and the app-level guard
            still arms — hiding the footer here would drop the only row telling
            the user that a second press exits. With the warning set the footer
            returns just that row, so nothing else appears. */}
          {exitHint ||
          (!dialog &&
            !activeModal &&
            !activeToolCall &&
            !mcpApproval.isMcpApprovalDialogOpen &&
            !showSuggestions) ? (
            <OpenTuiFooter
              config={config}
              settings={settings}
              statusLine={statusLine}
              sessionStats={statusLineState.sessionStats}
              activeWorktree={activeWorktree}
              streaming={Boolean(streaming)}
              approvalMode={currentApprovalMode}
              queueLength={queueLength}
              shellModeActive={shellModeActive}
              exitHint={exitHint}
              vimMode={props.vimMode}
            />
          ) : null}
        </box>
      </box>
    </OpenTuiErrorBoundary>
  );
}
