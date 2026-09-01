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
import type { Config, Logger } from '@qwen-code/qwen-code-core';
import { ToolConfirmationOutcome } from '@qwen-code/qwen-code-core';
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
import { OpenTuiAppHost } from './opentui-host.js';
import { OpenTuiSlashGateway } from './slash-gateway.js';
import {
  OpenTuiSlashDispatcher,
  type OpenTuiDispatchOutcome,
} from './commands-dispatch.js';
import { OpenTuiErrorBoundary } from './opentui-error-boundary.js';
import { OpenTuiDialogMount } from './opentui-dialog-mount.js';
import { OpenTuiInputPrompt } from './input-prompt.js';

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
  /** Runs a model turn for a plain prompt or a `submit_prompt` outcome. */
  onSubmitPrompt?: (content: PartListUnion) => void;
  /** Reaches the entry after `/quit`; receives the closing history rows. */
  onQuit?: (messages: readonly HistoryItem[]) => void;
  /** Replays a transcript batch (session switch / resume). */
  onTranscriptReset?: (events: OpenTuiStreamEvent[]) => void;
  /** Vim-mode toggle owner (VimModeProvider in the entry layer). */
  onToggleVim?: () => Promise<boolean>;
  availableTerminalHeight?: number;
}

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
    onToggleVim,
  } = props;

  const [dialog, setDialog] = useState<OpenTuiDialogRequest | null>(null);
  const [noticeText, setNoticeText] = useState<string | null>(null);
  const [commandList, setCommandList] = useState<readonly SlashCommand[]>(
    commands ?? [],
  );

  const notify = useCallback((text: string) => setNoticeText(text), []);

  // The confirmation seam resolves against a single pending slot; without a
  // renderer the shell must not hang a command, so it auto-denies.
  const confirmationRef = useRef<{
    resolve: (r: ShellConfirmationResolution) => void;
  } | null>(null);
  const confirmations = useMemo(
    () => ({
      presentShell(commandsToConfirm: readonly string[]) {
        return new Promise<ShellConfirmationResolution>((resolve) => {
          confirmationRef.current = { resolve };
          if (commandsToConfirm.length === 0) {
            confirmationRef.current = null;
            resolve({ outcome: ToolConfirmationOutcome.Cancel });
          }
        });
      },
      presentAction: () => new Promise<boolean>((resolve) => resolve(false)),
    }),
    [],
  );

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
        startNewSession: () => {},
        getSessionStats,
      }),
    [
      config,
      settings,
      logger,
      transcript,
      confirmations,
      onToggleVim,
      getSessionStats,
    ],
  );

  // Re-render whenever the host's command state changes.
  useSyncExternalStore(
    useCallback((cb) => host.subscribe(cb), [host]),
    useCallback(() => host.getVersion(), [host]),
  );

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
      const content: PartListUnion = imagePaths?.length
        ? [{ text }, ...imagePaths.map((path) => ({ text: `[image] ${path}` }))]
        : text;
      const settlement = await gateway.dispatch(text);
      if (settlement.kind === 'rejected') {
        notify(settlement.reason);
        return;
      }
      if (settlement.outcome === false) {
        if (onSubmitPrompt) onSubmitPrompt(content);
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
    <OpenTuiErrorBoundary>
      <box flexDirection="column" flexGrow={1} flexShrink={0}>
        {renderMain ? renderMain() : null}
        {noticeText ? <text>{noticeText}</text> : null}
        {dialog ? (
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
          />
        )}
      </box>
    </OpenTuiErrorBoundary>
  );
}
