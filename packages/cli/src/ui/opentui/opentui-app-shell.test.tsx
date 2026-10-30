/**
 * @license
 * Copyright 2026 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */
// @vitest-environment jsdom

/**
 * Wiring tests for the OpenTUI app shell (Batch 5 — backend composition root).
 *
 * The shell is kept real together with the pieces it composes — the concrete
 * {@link OpenTuiAppHost}, the {@link OpenTuiSlashGateway} routing gate, and the
 * {@link OpenTuiErrorBoundary}. Only the collaborators the shell delegates to
 * are stubbed: the slash dispatcher (so a submission resolves to a chosen
 * outcome without running a real command) and the child widgets it renders (the
 * dialog mount and the composer, reduced to string markers that also capture
 * their props). This asserts the seams the design names for this batch:
 *
 *  - composer input flows through the gateway and the outcome is applied:
 *    `open_dialog` swaps the composer for the dialog mount, `submit_prompt`
 *    reaches the live-turn seam, `quit` reaches the entry, a non-slash input
 *    (dispatcher returns false) is sent as a prompt, with pasted image paths
 *    forwarded as a structured argument rather than folded into the text;
 *  - a submission that arrives while a turn responds is held unless the command
 *    opted into running mid-turn, then replayed in order on the idle edge;
 *  - a prompt reaches the live-turn seam as typed, with the raw text also
 *    riding along as provenance — `@path` expansion belongs to the stream
 *    layer, so text queued mid-turn is expanded too;
 *  - a failed dispatcher initialization rejects later submissions with the
 *    recorded reason instead of misrouting to the model;
 *  - the confirmation bridge renders a real modal (shell / action) and the
 *    returned promise settles with the dialog's resolution, so a command can
 *    never hang waiting for a renderer;
 *  - the session re-key reaches the entry seam, or reports that no owner is
 *    wired to re-key the UI-side session state;
 *  - host history writes reach the live transcript as projected events and a
 *    host clear arrives as an empty reset;
 *  - user history rows drive the composer's history, and an error thrown in the
 *    subtree is caught by the boundary.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { isValidElement, type ReactNode } from 'react';
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { act, render, renderHook, screen } from '@testing-library/react';
import { OpenTuiApp } from './opentui-app-shell.js';
import {
  getDialogMaxHeight,
  STATIC_EXTRA_HEIGHT,
} from '../utils/layoutUtils.js';
import { STATUS_INDICATOR_WIDTH } from './messages.js';
import {
  CONTEXT_FILES_ANNOUNCEMENT_PREFIX,
  hasSlashCommandPathSeparator,
} from '../utils/commandUtils.js';
import {
  ApprovalMode,
  ToolConfirmationOutcome,
} from '@qwen-code/qwen-code-core';
import type { Config } from '@qwen-code/qwen-code-core';
import type { LoadedSettings } from '../../config/settings.js';
import type { SessionStatsState } from '../contexts/SessionContext.js';
import { CommandKind, type SlashCommand } from '../commands/types.js';
import type { OpenTuiDispatchOutcome } from './commands-dispatch.js';
import { createOpenTuiCommandContext } from './commands-context.js';
import type { OpenTuiAppHost } from './opentui-host.js';
import type { StatusLineState } from '../hooks/useStatusLine.js';
import { StreamingState } from '../types.js';
import type { HistoryItem } from '../types.js';
import type { LiveHistoryItem } from './live-session-model.js';
import {
  markApiHistoryPrompt,
  getApiHistoryPromptId,
} from '@qwen-code/qwen-code-core/services/session-api-history.js';
import type { Content } from '@google/genai';
import { historyCommand } from '../commands/historyCommand.js';
import { restoreCommand } from '../commands/restoreCommand.js';
import { makeFakeConfig } from '@qwen-code/qwen-code-core/test-utils/config.js';
import { LlmClient } from '@qwen-code/qwen-code-core/core/client.js';
import { livePromptEvents } from './live-session.js';
import type { OpenTuiStreamEvent } from './event-adapter.js';
import { useOpenTuiLiveTurn, type OpenTuiSubmitOptions } from './live-turn.js';
import {
  applyCollapsePolicyAndSummary,
  expandCollapsedHistory,
} from '../utils/resumeHistoryUtils.js';
import { projectHistoryToStreamEvents } from './item-projection.js';

const mocks = vi.hoisted(() => {
  const state = {
    handleResult: undefined as unknown,
    modBand: undefined as unknown,
    handleResults: [] as unknown[],
    loadCommandsOverride: null as null | (() => Promise<readonly unknown[]>),
    loadRejects: false,
    useRealDispatcher: false,
    deferDuringStreaming: false,
    deferGate: null as null | ((text: string) => boolean | Promise<boolean>),
    handledTexts: [] as string[],
    host: null as unknown,
    /** One entry per dispatcher construction: churn means the host was rebuilt. */
    hosts: [] as unknown[],
    dispatcherConstructions: 0,
    cancelCommand: vi.fn(),
    inputProps: null as Record<string, unknown> | null,
    dialogProps: null as Record<string, unknown> | null,
    toolConfirmProps: null as Record<string, unknown> | null,
    extensionSettingProps: null as Record<string, unknown> | null,
    shellConfirmProps: null as Record<string, unknown> | null,
    actionConfirmProps: null as Record<string, unknown> | null,
    mcpApprovalProps: null as Record<string, unknown> | null,
    /** The gated-server queue the shell's approval hook reports. */
    mcpQueue: [] as Array<Record<string, unknown>>,
    handleMcpApprovalSelect: vi.fn(),
    bannerProps: null as Record<string, unknown> | null,
    footerProps: null as Record<string, unknown> | null,
    statusLineState: null as StatusLineState | null,
    statusVimMode: undefined as string | undefined,
    worktree: null as null | {
      slug: string;
      worktreePath: string;
      worktreeBranch: string;
      originalCwd: string;
      originalBranch: string;
      originalHeadCommit: string;
    },
    loadingProps: null as Record<string, unknown> | null,
    keyboardHandlers: [] as Array<(key: unknown) => void>,
    exitInProgress: false,
    /** Runs while a dispatched command is still awaiting its outcome. */
    onHandle: null as null | ((text: string) => void),
    /** Resolved immediately, so the drain never blocks on a shell lane. */
    executeUserShell: vi.fn(() => Promise.resolve()),
    /** Holds the dispatcher's busy slot on this text until released. */
    holdHandleOn: null as string | null,
    releaseHandle: null as null | (() => void),
    /** ink's AUTO entry notices, spied so the shell's call is observable. */
    emitAutoModeEntryNotices: vi.fn(),
  };
  async function buildJsxRuntime() {
    const React = await import('react');
    const jsx = (
      type: unknown,
      props: { children?: unknown; key?: React.Key } | null,
      key?: React.Key,
    ) => {
      const config = key === undefined ? props : { ...props, key };
      const children = (config?.children ?? null) as React.ReactNode;
      // Layout props are what the structural tests read, and the DOM nodes this
      // mock maps to would drop them: keep the primitives as a JSON attribute.
      const captured = JSON.stringify(
        Object.fromEntries(
          Object.entries(props ?? {}).filter(
            ([, v]) =>
              typeof v === 'string' ||
              typeof v === 'number' ||
              typeof v === 'boolean',
          ),
        ),
      );
      if (type === 'box' || type === 'text') {
        return React.createElement(
          type === 'box' ? 'div' : 'span',
          {
            ...(key === undefined ? {} : { key }),
            'data-p': captured,
          },
          children,
        );
      }
      return React.createElement(
        type as React.ElementType,
        {
          ...(config as Record<string, unknown>),
          'data-p': captured,
        },
        children,
      );
    };
    return { jsx, jsxs: jsx, jsxDEV: jsx, Fragment: React.Fragment };
  }
  return { state, buildJsxRuntime };
});

vi.mock('@opentui/react', () => ({
  useKeyboard: (handler: (key: unknown) => void) => {
    mocks.state.keyboardHandlers.push(handler);
  },
  useTerminalDimensions: () => ({ width: 120, height: 40 }),
  useRenderer: () => ({
    addInputHandler: () => {},
    removeInputHandler: () => {},
  }),
}));
vi.mock('@opentui/react/jsx-runtime', () => mocks.buildJsxRuntime());
vi.mock('@opentui/react/jsx-dev-runtime', () => mocks.buildJsxRuntime());
vi.mock('@opentui/core', () => ({
  SyntaxStyle: { fromStyles: () => ({}) },
  MouseButton: { LEFT: 0 },
}));

// Slash dispatcher: a submission resolves to the next queued handleResults
// entry, or to handleResult when that queue is empty; the constructor captures
// the host so history can be driven from a test.
vi.mock('./commands-dispatch.js', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('./commands-dispatch.js')>();
  class StubDispatcher {
    constructor(
      host: unknown,
      _services: unknown,
      commands: readonly unknown[],
    ) {
      mocks.state.host = host;
      mocks.state.hosts.push(host);
      mocks.state.dispatcherConstructions += 1;
      this._commands = commands;
    }
    _commands: readonly unknown[];
    get commands() {
      return this._commands;
    }
    async loadCommands() {
      if (mocks.state.loadRejects) throw new Error('registry exploded');
      if (mocks.state.loadCommandsOverride)
        this._commands = await mocks.state.loadCommandsOverride();
    }
    async mustDeferDuringStreaming(text: string) {
      const gate = mocks.state.deferGate;
      return gate ? gate(text) : mocks.state.deferDuringStreaming;
    }
    // The shell's entry tag asks this predicate; mirror the real rule.
    takesAsSlashCommand(text: string) {
      const trimmed = text.trim();
      if (!trimmed.startsWith('/') && !trimmed.startsWith('?')) {
        return false;
      }
      return !(
        trimmed.startsWith('/') && hasSlashCommandPathSeparator(trimmed)
      );
    }
    cancel() {
      mocks.state.cancelCommand();
      mocks.state.releaseHandle?.();
    }
    dispose() {}
    async handle(text: string) {
      if (
        mocks.state.holdHandleOn === text &&
        mocks.state.releaseHandle === null
      ) {
        await new Promise<void>((resolve) => {
          mocks.state.releaseHandle = resolve;
        });
      }
      mocks.state.handledTexts.push(text);
      mocks.state.onHandle?.(text);
      const queued = mocks.state.handleResults;
      return queued.length > 0 ? queued.shift() : mocks.state.handleResult;
    }
  }
  return {
    OpenTuiSlashDispatcher: vi
      .fn()
      .mockImplementation(
        (
          ...args: ConstructorParameters<typeof actual.OpenTuiSlashDispatcher>
        ) => {
          if (!mocks.state.useRealDispatcher)
            return new StubDispatcher(...args);
          mocks.state.host = args[0];
          mocks.state.hosts.push(args[0]);
          mocks.state.dispatcherConstructions += 1;
          return new actual.OpenTuiSlashDispatcher(...args);
        },
      ),
  };
});

vi.mock('./live-session.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./live-session.js')>();
  return { ...actual, livePromptEvents: vi.fn(actual.livePromptEvents) };
});

// Child widgets: string markers that also record their props for assertions.
vi.mock('./shell-mode.js', () => ({
  executeUserShell: mocks.state.executeUserShell,
}));
vi.mock('./opentui-dialog-mount.js', () => ({
  OpenTuiDialogMount: (props: Record<string, unknown>) => {
    mocks.state.dialogProps = props;
    const request = props['request'] as { dialog: string };
    return `dialog:${request.dialog}`;
  },
}));
vi.mock('./mod-band.js', () => ({
  OpenTuiModBand: ({
    band,
    maxRows,
  }: {
    band?: { tree: { children?: string[] } };
    maxRows: number;
  }) =>
    band ? (
      <span>{`mod-band:${band.tree.children?.[0]}:${maxRows}`}</span>
    ) : null,
}));
vi.mock('../hooks/use-mod-band.js', () => ({
  useModBand: () => mocks.state.modBand,
}));
vi.mock('./input-prompt.js', () => ({
  OpenTuiInputPrompt: (props: Record<string, unknown>) => {
    mocks.state.inputProps = props;
    return 'input-prompt';
  },
}));
vi.mock('./opentui-header.js', () => ({
  OpenTuiBanner: (props: Record<string, unknown>) => {
    mocks.state.bannerProps = props;
    return <span>banner</span>;
  },
}));
vi.mock('./opentui-footer.js', () => ({
  OpenTuiFooter: (props: Record<string, unknown>) => {
    mocks.state.footerProps = props;
    return <span>footer</span>;
  },
  OpenTuiLoadingIndicator: (props: Record<string, unknown>) => {
    mocks.state.loadingProps = props;
    return <span>loading-indicator</span>;
  },
}));
vi.mock('./dialogs-confirm.js', () => ({
  OpenTuiToolConfirmation: (props: Record<string, unknown>) => {
    mocks.state.toolConfirmProps = props;
    return 'tool-confirm';
  },
  OpenTuiShellConfirmation: (props: Record<string, unknown>) => {
    mocks.state.shellConfirmProps = props;
    return 'shell-confirm';
  },
  OpenTuiActionConfirmation: (props: Record<string, unknown>) => {
    mocks.state.actionConfirmProps = props;
    return (
      <>
        <span>action-confirm</span>
        <span>{props['prompt'] as ReactNode}</span>
      </>
    );
  },
  OpenTuiMcpApprovalDialog: (props: Record<string, unknown>) => {
    mocks.state.mcpApprovalProps = props;
    return 'mcp-approval';
  },
}));
vi.mock('./ExtensionAcquisition.js', () => ({
  ExtensionSettingInput: (props: Record<string, unknown>) => {
    mocks.state.extensionSettingProps = props;
    const permission = props['permission'] as { setting: { name: string } };
    return <span>{`extension-setting:${permission.setting.name}`}</span>;
  },
}));
vi.mock('../hooks/useMcpApproval.js', () => ({
  useMcpApproval: () => ({
    isMcpApprovalDialogOpen: mocks.state.mcpQueue.length > 0,
    currentMcpApproval: mocks.state.mcpQueue[0],
    pendingMcpApprovals: mocks.state.mcpQueue,
    mcpApprovalRemaining: Math.max(0, mocks.state.mcpQueue.length - 1),
    handleMcpApprovalSelect: mocks.state.handleMcpApprovalSelect,
  }),
}));
vi.mock('./exit-lifecycle.js', () => ({
  isExitInProgress: () => mocks.state.exitInProgress,
}));
vi.mock('../hooks/useAutoAcceptIndicator.js', () => ({
  emitAutoModeEntryNotices: mocks.state.emitAutoModeEntryNotices,
}));
vi.mock('../hooks/useWorktreeSession.js', () => ({
  useWorktreeSession: () => mocks.state.worktree,
}));
vi.mock('../hooks/useGitBranchName.js', () => ({
  useGitBranchName: () => 'current-branch',
}));
vi.mock('../hooks/useStatusLine.js', () => ({
  useStatusLineState: ({
    state,
    vimMode,
  }: {
    state: StatusLineState;
    vimMode?: string;
  }) => {
    mocks.state.statusLineState = state;
    mocks.state.statusVimMode = vimMode;
    return {
      lines: [],
      useThemeColors: true,
      respectUserColors: false,
      hideContextIndicator: false,
    };
  },
}));

const extensionManager = {
  setRequestConsent: vi.fn(),
  setRequestSetting: vi.fn(),
};
const CONFIG = {
  getExtensionManager: () => extensionManager,
  getSessionId: () => 'test-session',
  getContextFilePaths: () => [],
  getAccessibility: () => ({}),
  getTargetDir: () => '/repo',
  getModel: () => 'session-model',
  onModelChange: () => () => {},
} as unknown as Config;
const SETTINGS = { merged: {} } as unknown as LoadedSettings;
const getSessionStats = () => ({}) as unknown as SessionStatsState;

type AppProps = Parameters<typeof OpenTuiApp>[0];
function renderApp(overrides: Partial<AppProps> = {}) {
  const props: AppProps = {
    config: CONFIG,
    settings: SETTINGS,
    logger: null,
    commands: [] as readonly SlashCommand[],
    getSessionStats,
    ...overrides,
  };
  return render(<OpenTuiApp {...props} />);
}

/** Flush the mount effect so the gateway attaches (or records init failure). */
async function settle() {
  await act(async () => {
    await Promise.resolve();
  });
}

/** Run one composer submission and flush the async dispatch. */
async function submit(
  text: string,
  imagePaths?: string[],
  metadata?: Pick<
    OpenTuiSubmitOptions,
    'displayText' | 'humanInput' | 'pasteExpansions' | 'restoredDraft'
  >,
): Promise<void> {
  const onSubmit = mocks.state.inputProps?.['onSubmit'] as (
    t: string,
    i?: string[],
    metadata?: OpenTuiSubmitOptions,
  ) => void;
  await act(async () => {
    onSubmit(
      text,
      imagePaths,
      metadata ?? { displayText: text, humanInput: { text } },
    );
    await Promise.resolve();
  });
}

describe('OpenTuiApp shell wiring', () => {
  beforeEach(() => {
    mocks.state.handleResult = { kind: 'handled' };
    mocks.state.handleResults.length = 0;
    mocks.state.loadCommandsOverride = null;
    mocks.state.loadRejects = false;
    mocks.state.useRealDispatcher = false;
    mocks.state.deferDuringStreaming = false;
    mocks.state.deferGate = null;
    mocks.state.handledTexts.length = 0;
    mocks.state.host = null;
    mocks.state.hosts.length = 0;
    mocks.state.dispatcherConstructions = 0;
    mocks.state.cancelCommand.mockClear();
    mocks.state.inputProps = null;
    mocks.state.dialogProps = null;
    mocks.state.toolConfirmProps = null;
    mocks.state.shellConfirmProps = null;
    mocks.state.actionConfirmProps = null;
    mocks.state.mcpApprovalProps = null;
    mocks.state.mcpQueue.length = 0;
    mocks.state.handleMcpApprovalSelect.mockClear();
    mocks.state.bannerProps = null;
    mocks.state.footerProps = null;
    mocks.state.loadingProps = null;
    mocks.state.keyboardHandlers.length = 0;
    mocks.state.exitInProgress = false;
    mocks.state.onHandle = null;
    mocks.state.holdHandleOn = null;
    mocks.state.releaseHandle = null;
    mocks.state.executeUserShell.mockClear();
  });

  afterEach(() => {
    mocks.state.executeUserShell.mockImplementation(() => Promise.resolve());
  });

  it.each(['control', 'retry', 'image'] as const)(
    'restores once without admitting a competing %s request',
    async (kind) => {
      const originalLive =
        await vi.importActual<typeof import('./live-session.js')>(
          './live-session.js',
        );
      const scratch = mkdtempSync(join(tmpdir(), 'restore-admission-'));
      try {
        let releaseRestore!: () => void;
        const heldRestore = new Promise<void>((resolve) => {
          releaseRestore = resolve;
        });
        let releaseFirst: (() => void) | undefined;
        let owner!: ReturnType<typeof useOpenTuiLiveTurn>;
        let coreHistory: Content[] = [];
        let turnCount = 0;
        const completed: number[] = [];
        const replay = vi.fn(() => true);
        const rewind = vi.fn(async () => {
          await heldRestore;
          return { filesChanged: [], filesFailed: [] };
        });
        const config = makeFakeConfig({});
        config.getFileCheckpointingEnabled = () => true;
        config.getShellExecutionSandbox = () => undefined;
        config.getContextFilePaths = () => [];
        config.storage.getProjectTempCheckpointsDir = () => scratch;
        config.getChatRecordingService = () =>
          ({ recordSlashCommand: vi.fn() }) as unknown as ReturnType<
            Config['getChatRecordingService']
          >;
        config.getFileHistoryService = () =>
          ({ rewind }) as unknown as ReturnType<
            Config['getFileHistoryService']
          >;
        config.getFileReadCache = () =>
          ({ clear: vi.fn() }) as unknown as ReturnType<
            Config['getFileReadCache']
          >;
        config.getMemoryManager = () =>
          ({
            invalidatePendingExtract: vi.fn(),
            restoreMemoryBodiesPresentInHistory: vi.fn(),
          }) as unknown as ReturnType<Config['getMemoryManager']>;
        config.clearActiveTodoReminders = vi.fn();
        const client = new LlmClient(config);
        const chat = {
          setHistory(history: Content[]) {
            coreHistory = history;
          },
          getHistory: () => coreHistory,
          getHistoryShallow: () => coreHistory,
        };
        const getChat = vi
          .spyOn(client, 'getChat')
          .mockReturnValue(chat as ReturnType<LlmClient['getChat']>);
        const setHistory = vi.spyOn(client, 'setHistory');
        config.getLlmClient = () => client;
        let view: ReturnType<typeof render> | undefined;
        let pendingRestore: Promise<boolean> | undefined;
        try {
          const checkpointApi: Content[] = [
            { role: 'user', parts: [{ text: 'checkpoint-model' }] },
          ];
          const checkpointUi: HistoryItem[] = [
            { id: 800, type: 'user', text: 'checkpoint-ui', sentToModel: true },
          ];
          const toolArgs = { absolute_path: join(scratch, 'owned.txt') };
          writeFileSync(
            join(scratch, 'owned.json'),
            JSON.stringify({
              promptId: 'checkpoint-prompt',
              history: checkpointUi,
              clientHistory: checkpointApi,
              promptIds: ['checkpoint-prompt'],
              toolCall: { name: 'read_file', args: toolArgs },
            }),
          );
          const imagePath = join(scratch, 'image.png');
          writeFileSync(
            imagePath,
            Buffer.from(
              'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aF0cAAAAASUVORK5CYII=',
              'base64',
            ),
          );
          vi.mocked(livePromptEvents).mockImplementation(
            async function* (
              _config,
              prompt,
              signal,
              options,
            ): AsyncGenerator<OpenTuiStreamEvent> {
              const turn = ++turnCount;
              options?.onPreparedRequest?.({
                content: prompt,
                inlineModelOverride: false,
              });
              if (kind === 'image' && turn === 1) {
                await new Promise<void>((resolve) => {
                  releaseFirst = resolve;
                  signal?.addEventListener('abort', () => resolve(), {
                    once: true,
                  });
                });
              }
              if (signal?.aborted) return;
              if (kind === 'retry' && turn === 1) {
                yield { type: 'error', text: 'failed seed request' };
              } else {
                coreHistory.push({
                  role: 'model',
                  parts: [{ text: `answer-${turn}` }],
                });
                yield { type: 'text', delta: `answer-${turn}` };
                yield { type: 'done' };
              }
              completed.push(turn);
            },
          );
          mocks.state.useRealDispatcher = true;
          const commands = [restoreCommand(config)!];
          function Harness() {
            owner = useOpenTuiLiveTurn({ config });
            return (
              <OpenTuiApp
                config={config}
                settings={SETTINGS}
                logger={null}
                commands={commands}
                getSessionStats={getSessionStats}
                historyItems={owner.items}
                streaming={owner.streaming}
                onTranscriptEvent={owner.applyEvent}
                onTranscriptReset={owner.resetTranscript}
                onInputProcessed={owner.notifyInputProcessed}
                onRetryPrompt={owner.retryLastPrompt}
                onSubmitPrompt={owner.submit}
                onScheduleTool={replay}
                isCurrentHistory={owner.isCurrentHistory}
                onInterrupt={owner.interrupt}
                messageQueue={owner.messageQueue}
                onPopQueue={owner.popQueue}
              />
            );
          }
          const input = () =>
            mocks.state.inputProps!['onSubmit'] as (
              text: string,
              images?: string[],
              options?: OpenTuiSubmitOptions,
            ) => Promise<boolean>;
          view = render(<Harness />);
          await settle();
          if (kind !== 'control') {
            await act(async () => {
              expect(await input()('seed-request')).toBe(true);
            });
            await vi.waitFor(() => expect(turnCount).toBe(1));
            if (kind === 'retry') {
              await vi.waitFor(() => expect(owner.streaming).toBe(false));
              expect(owner.items.at(-1)).toMatchObject({
                kind: 'error',
                text: 'failed seed request',
              });
            } else expect(owner.streaming).toBe(true);
          }
          if (kind === 'image') {
            await act(async () => {
              expect(await input()('/restore owned')).toBe(true);
            });
            expect(rewind).not.toHaveBeenCalled();
            await act(async () => {
              releaseFirst!();
            });
          } else {
            act(() => {
              pendingRestore = input()('/restore owned');
            });
          }
          await vi.waitFor(() =>
            expect(rewind).toHaveBeenCalledExactlyOnceWith(
              'checkpoint-prompt',
              true,
            ),
          );
          const host = mocks.state.host as OpenTuiAppHost;
          expect(host.isIdle()).toBe(false);
          expect(owner.streaming).toBe(false);
          const expectedTurns = kind === 'control' ? 0 : 1;
          await act(async () => {
            expect(await input()('ordinary-while-restoring')).toBe(false);
          });
          expect(turnCount).toBe(expectedTurns);
          if (kind === 'retry') {
            await act(async () => {
              expect(
                (mocks.state.inputProps!['onRetry'] as () => void)(),
              ).toBeUndefined();
            });
          } else if (kind === 'image') {
            await act(async () => {
              expect(await input()('image-while-restoring', [imagePath])).toBe(
                false,
              );
            });
          }
          expect(turnCount).toBe(expectedTurns);
          expect(owner.streaming).toBe(false);
          expect(owner.messageQueue).toEqual([]);
          expect(setHistory).not.toHaveBeenCalled();
          expect(replay).not.toHaveBeenCalled();
          await act(async () => {
            releaseRestore();
            await pendingRestore;
          });
          await vi.waitFor(() =>
            expect(replay).toHaveBeenCalledExactlyOnceWith(
              'read_file',
              toolArgs,
            ),
          );
          expect(host.isIdle()).toBe(true);
          expect(structuredClone(coreHistory)).toEqual(checkpointApi);
          expect(getApiHistoryPromptId(coreHistory[0])).toBe(
            'checkpoint-prompt',
          );
          expect(
            owner.items
              .filter((item) => item.kind === 'user')
              .map((item) => item.text),
          ).toEqual(['checkpoint-ui']);
          expect(setHistory).toHaveBeenCalledOnce();
          expect(setHistory.mock.calls[0][0]).toBe(coreHistory);
          expect(setHistory.mock.results[0].value).toBeUndefined();
          expect(turnCount).toBe(expectedTurns);
          expect(completed).toEqual(kind === 'control' ? [] : [1]);
          expect(owner.messageQueue).toEqual([]);
          if (kind === 'retry') {
            await act(async () => {
              (mocks.state.inputProps!['onRetry'] as () => void)();
            });
            expect(turnCount).toBe(1);
            expect(owner.items.at(-1)).toMatchObject({
              kind: 'info',
              text: 'No failed request to retry.',
            });
            expect(setHistory).toHaveBeenCalledOnce();
            expect(replay).toHaveBeenCalledOnce();
          }
        } finally {
          releaseRestore();
          releaseFirst?.();
          try {
            await act(async () => {
              await pendingRestore;
            });
          } finally {
            view?.unmount();
            getChat.mockRestore();
            setHistory.mockRestore();
            vi.mocked(livePromptEvents).mockImplementation(
              originalLive.livePromptEvents,
            );
            mocks.state.useRealDispatcher = false;
          }
        }
      } finally {
        rmSync(scratch, { recursive: true, force: true });
      }
    },
  );

  it('draws the Mods band above the composer and hides it behind a dialog', async () => {
    mocks.state.modBand = {
      tree: { type: 'Text', children: ['forecast'] },
      owner: 'token-weather',
      revision: 1,
    };
    try {
      renderApp();
      await settle();
      // The band sits between the queued messages and the prompt input.
      const text = document.body.textContent ?? '';
      expect(text.indexOf('mod-band:forecast:13')).toBeGreaterThan(-1);
      expect(text.indexOf('mod-band:forecast:13')).toBeLessThan(
        text.indexOf('input-prompt'),
      );
      mocks.state.handleResult = {
        kind: 'open_dialog',
        request: { dialog: 'help' },
      } satisfies OpenTuiDispatchOutcome;
      await submit('/help');
      expect(screen.getByText('dialog:help')).toBeTruthy();
      expect(screen.queryByText(/mod-band:/)).toBeNull();
    } finally {
      mocks.state.modBand = undefined;
    }
  });

  it('renders the composer inside the error boundary by default', async () => {
    renderApp();
    await settle();
    expect(screen.getByText('input-prompt')).toBeTruthy();
  });

  it('updates and clears the composer title from the same session host', async () => {
    renderApp();
    await settle();
    const host = mocks.state.host as OpenTuiAppHost;
    expect(host.sessionName).toBeNull();
    expect(mocks.state.inputProps?.['topRightLabel']).toBeUndefined();

    act(() => host.setSessionName('owned session'));
    expect(mocks.state.inputProps?.['topRightLabel']).toBe('owned session');

    act(() => host.setSessionName('renamed session'));
    expect(mocks.state.inputProps?.['topRightLabel']).toBe('renamed session');

    act(() => host.setSessionName(null));
    expect(mocks.state.inputProps?.['topRightLabel']).toBeUndefined();
    expect(mocks.state.host).toBe(host);
    expect(mocks.state.dispatcherConstructions).toBe(1);
  });

  it('switches foreground PTY input without losing the composer and consumes focus keys', async () => {
    const owner = { callId: 'shell', pid: 4300, turn: 1 };
    const control = {
      foregroundShell: owner,
      promoteShellToBackground: vi.fn(() => false),
      writeShellInput: vi.fn((_owner: typeof owner, _input: string) => true),
      resizeShell: vi.fn(() => true),
      scrollShell: vi.fn(() => true),
    };
    const config = {
      ...CONFIG,
      getShellExecutionConfig: () => ({}),
      setShellExecutionConfig: vi.fn(),
      getApprovalMode: () => ApprovalMode.DEFAULT,
      setApprovalMode: vi.fn(),
    } as unknown as Config;
    const renderMain = vi.fn<NonNullable<AppProps['renderMain']>>(() => null);
    let draft = '';
    const composerHandle = {
      current: {
        getText: () => draft,
        setText: (text: string) => {
          draft = text;
        },
      },
    };
    const view = renderApp({
      config,
      foregroundShellControl: control,
      composerHandle,
      renderMain,
    });
    await settle();
    const event = (
      name: string,
      sequence: string,
      ctrl = false,
      shift = false,
    ) => ({
      name,
      sequence,
      ctrl,
      shift,
      preventDefault: vi.fn(),
      stopPropagation: vi.fn(),
    });
    expect(mocks.state.inputProps?.['focus']).toBe(true);
    const focus = event('f', '\x06', true);
    act(() =>
      expect(
        (mocks.state.inputProps!['onShellKey'] as (key: unknown) => boolean)(
          focus,
        ),
      ).toBe(true),
    );
    expect(mocks.state.inputProps?.['focus']).toBe(false);
    expect(renderMain.mock.calls.at(-1)?.[0]).toEqual({ owner, focused: true });
    expect(control.writeShellInput).not.toHaveBeenCalled();
    for (const key of [
      event('a', 'a'),
      event('left', '\x1b[D'),
      event('return', '\r'),
    ]) {
      act(() => mocks.state.keyboardHandlers.at(-1)!(key));
      expect(key.preventDefault).toHaveBeenCalledOnce();
      expect(key.stopPropagation).toHaveBeenCalledOnce();
    }
    expect(
      control.writeShellInput.mock.calls.map(([, bytes]) => bytes),
    ).toEqual(['a', '\x1b[D', '\r']);
    const paste = mocks.state.inputProps!['onShellPaste'] as (
      text: string,
    ) => boolean;
    act(() => expect(paste('hello\n世界')).toBe(true));
    expect(control.writeShellInput).toHaveBeenLastCalledWith(
      owner,
      'hello\n世界',
    );
    act(() =>
      mocks.state.keyboardHandlers.at(-1)!(event('up', '\x1b[A', true, true)),
    );
    expect(control.scrollShell).toHaveBeenCalledExactlyOnceWith(owner, -1);
    act(() => mocks.state.keyboardHandlers.at(-1)!(focus));
    expect(mocks.state.inputProps?.['focus']).toBe(true);
    expect(control.writeShellInput).toHaveBeenCalledTimes(4);
    act(() =>
      (mocks.state.inputProps!['onShellKey'] as (key: unknown) => boolean)(
        focus,
      ),
    );
    for (const exitKey of [
      event('c', '\x03', true),
      event('d', '\x04', true),
    ]) {
      act(() => mocks.state.keyboardHandlers.at(-1)!(exitKey));
      expect(control.writeShellInput).toHaveBeenCalledTimes(4);
      expect(exitKey.preventDefault).not.toHaveBeenCalled();
      expect(exitKey.stopPropagation).not.toHaveBeenCalled();
    }
    const approval = event('tab', '\x1b[Z', false, true);
    act(() => mocks.state.keyboardHandlers.at(-1)!(approval));
    expect(config.setApprovalMode).toHaveBeenCalledExactlyOnceWith(
      ApprovalMode.AUTO_EDIT,
    );
    expect(control.writeShellInput).toHaveBeenLastCalledWith(owner, '\t');
    expect(approval.stopPropagation).not.toHaveBeenCalled();
    for (const thinking of [
      event('o', '\x0f', true),
      { ...event('t', 't'), meta: true },
    ]) {
      act(() => mocks.state.keyboardHandlers.at(-1)!(thinking));
      expect(thinking.stopPropagation).not.toHaveBeenCalled();
      expect(thinking.preventDefault).not.toHaveBeenCalled();
    }
    expect(control.writeShellInput).toHaveBeenLastCalledWith(owner, '\x0f');
    draft = 'DRAFT';
    const eof = event('d', '\x04', true);
    act(() => mocks.state.keyboardHandlers.at(-1)!(eof));
    expect(control.writeShellInput).toHaveBeenCalledTimes(7);
    expect(control.writeShellInput).toHaveBeenLastCalledWith(owner, '\x04');
    expect(eof.preventDefault).not.toHaveBeenCalled();
    expect(eof.stopPropagation).not.toHaveBeenCalled();
    expect(config.setShellExecutionConfig).toHaveBeenCalledWith(
      expect.objectContaining({ terminalWidth: 106 }),
    );
    view.unmount();
  });

  it('keeps a foreground shell behind a dialog and does not transfer focus to a replacement owner', async () => {
    const config = {
      ...CONFIG,
      getShellExecutionConfig: () => ({}),
      setShellExecutionConfig: vi.fn(),
    } as unknown as Config;
    const owner = { callId: 'shell', pid: 4300, turn: 1 };
    const control = {
      foregroundShell: owner,
      promoteShellToBackground: vi.fn(() => true),
      writeShellInput: vi.fn(() => true),
      resizeShell: vi.fn(() => true),
      scrollShell: vi.fn(() => true),
    };
    const props = {
      config,
      settings: SETTINGS,
      logger: null,
      commands: [],
      getSessionStats,
      foregroundShellControl: control,
    };
    const view = render(<OpenTuiApp {...props} />);
    await settle();
    const key = {
      name: 'f',
      sequence: '\x06',
      ctrl: true,
      preventDefault: vi.fn(),
      stopPropagation: vi.fn(),
    };
    act(() =>
      (mocks.state.inputProps!['onShellKey'] as (key: unknown) => boolean)(key),
    );
    expect(mocks.state.inputProps?.['focus']).toBe(false);
    view.rerender(
      <OpenTuiApp
        {...props}
        foregroundShellControl={{
          ...control,
          foregroundShell: { ...owner, turn: 2 },
        }}
      />,
    );
    expect(mocks.state.inputProps?.['focus']).toBe(true);
    mocks.state.handleResult = {
      kind: 'open_dialog',
      request: { dialog: 'help' },
    };
    await submit('/help');
    expect(mocks.state.dialogProps).not.toBeNull();
    const promote = { ...key, name: 'b', sequence: '\x02' };
    act(() => mocks.state.keyboardHandlers.at(-1)!(promote));
    expect(control.promoteShellToBackground).not.toHaveBeenCalled();
    expect(control.writeShellInput).not.toHaveBeenCalled();
    view.unmount();
  });

  it('routes composer cancellation to the running command without interrupting the model', async () => {
    const onInterrupt = vi.fn();
    renderApp({ onInterrupt });
    await settle();
    const cancel = () =>
      (mocks.state.inputProps?.['onCancelCommand'] as () => boolean)();
    expect(cancel()).toBe(false);
    mocks.state.holdHandleOn = '/slow';
    await submit('/slow');
    expect(mocks.state.releaseHandle).not.toBeNull();
    await act(async () => {
      expect(cancel()).toBe(true);
    });
    expect(mocks.state.cancelCommand).toHaveBeenCalledOnce();
    expect(onInterrupt).not.toHaveBeenCalled();
    expect(cancel()).toBe(false);
    await submit('/next');
    expect(mocks.state.handledTexts).toEqual(['/slow', '/next']);
  });

  it('mounts the restored banner and footer, and feeds them the streaming flag', async () => {
    renderApp({ streaming: true });
    await settle();
    expect(screen.getByText('banner')).toBeTruthy();
    expect(screen.getByText('footer')).toBeTruthy();
    expect(mocks.state.footerProps?.['streaming']).toBe(true);
    expect(mocks.state.loadingProps?.['streaming']).toBe(true);
  });

  it.each(['NORMAL', 'INSERT', undefined] as const)(
    'passes current Vim mode %s to the status command and footer',
    async (vimMode) => {
      renderApp({ vimMode });
      await settle();
      expect(mocks.state.statusVimMode).toBe(vimMode);
      expect(mocks.state.footerProps?.['vimMode']).toBe(vimMode);
    },
  );

  it('uses the current render statistics for status output and dialog preview', async () => {
    const stale = {
      sessionId: 'old',
      lastPromptTokenCount: 10,
    } as SessionStatsState;
    const current = {
      sessionId: 'new',
      lastPromptTokenCount: 500,
    } as SessionStatsState;
    renderApp({
      getSessionStats: () => stale,
      sessionStats: current,
      streaming: true,
    });
    await settle();
    expect(mocks.state.statusLineState?.sessionStats).toBe(current);
    expect(mocks.state.statusLineState?.streamingState).toBe(
      StreamingState.Responding,
    );
    expect(mocks.state.footerProps?.['sessionStats']).toBe(current);

    mocks.state.handleResult = {
      kind: 'open_dialog',
      request: { dialog: 'statusline' },
    };
    await submit('/statusline');
    expect(mocks.state.dialogProps?.['statusLineState']).toMatchObject({
      sessionStats: current,
      branchName: 'current-branch',
    });
  });

  it('keeps the session model across a scoped override and adopts model-change events', async () => {
    let model = 'session-model';
    let notify: (model: string) => void = () => {};
    const unsubscribe = vi.fn();
    const config = {
      ...CONFIG,
      getModel: () => model,
      onModelChange: (listener: typeof notify) => {
        notify = listener;
        return unsubscribe;
      },
    } as unknown as Config;
    const props = {
      config,
      settings: SETTINGS,
      logger: null,
      commands: [],
      getSessionStats,
    };
    const view = render(<OpenTuiApp {...props} />);
    await settle();
    model = 'fast-subagent';
    view.rerender(<OpenTuiApp {...props} streaming />);
    expect(mocks.state.statusLineState?.currentModel).toBe('session-model');
    act(() => notify('selected-model'));
    expect(mocks.state.statusLineState?.currentModel).toBe('selected-model');
    view.unmount();
    expect(unsubscribe).toHaveBeenCalledOnce();
  });

  it('projects active worktree details and confirmation state into the status command input', async () => {
    mocks.state.worktree = {
      slug: 'feature',
      worktreePath: '/repo/.worktrees/feature',
      worktreeBranch: 'feature/one',
      originalCwd: '/repo',
      originalBranch: 'main',
      originalHeadCommit: 'a'.repeat(40),
    };
    try {
      renderApp({ streaming: true, waitingToolCalls: [parkedCall] });
      await settle();
      expect(mocks.state.statusLineState).toMatchObject({
        streamingState: StreamingState.WaitingForConfirmation,
        activeWorktree: {
          slug: 'feature',
          path: '/repo/.worktrees/feature',
          branch: 'feature/one',
          originalCwd: '/repo',
        },
      });
    } finally {
      mocks.state.worktree = null;
    }
  });

  // ink's Composer drops the phrase, not the row, when this setting is off, so
  // the gate has to reach both mounts of the indicator: the composer's and the
  // waiting row under a parked confirmation.
  function phraseConfig(enableLoadingPhrases: boolean): Config {
    return {
      ...CONFIG,
      getContextFilePaths: () => [],
      getAccessibility: () => ({ enableLoadingPhrases }),
    } as unknown as Config;
  }

  const parkedCall = {
    callId: 'call-1',
    name: 'run_shell_command',
    confirmationDetails: { type: 'info', title: 'ok?' },
  } as never;

  it('drops the composer’s loading phrase when the setting is off', async () => {
    renderApp({ config: phraseConfig(false) });
    await settle();
    expect(screen.getByText('input-prompt')).toBeTruthy();
    expect(mocks.state.loadingProps?.['showPhrase']).toBe(false);
  });

  it('drops the parked call’s loading phrase when the setting is off', async () => {
    renderApp({
      config: phraseConfig(false),
      waitingToolCalls: [parkedCall],
    });
    await settle();
    expect(screen.getByText('tool-confirm')).toBeTruthy();
    expect(mocks.state.loadingProps?.['showPhrase']).toBe(false);
  });

  it('keeps both loading phrases when the setting says nothing', async () => {
    renderApp({ waitingToolCalls: [parkedCall] });
    await settle();
    expect(mocks.state.loadingProps?.['showPhrase']).toBe(true);

    mocks.state.loadingProps = null;
    renderApp();
    await settle();
    expect(screen.getByText('input-prompt')).toBeTruthy();
    expect(mocks.state.loadingProps?.['showPhrase']).toBe(true);
  });

  it('hides the footer while the composer’s completion list is open', async () => {
    renderApp();
    await settle();
    expect(screen.getByText('footer')).toBeTruthy();

    const onVisibilityChange = mocks.state.inputProps?.[
      'onSuggestionsVisibilityChange'
    ] as (visible: boolean) => void;
    act(() => {
      onVisibilityChange(true);
    });
    await settle();
    expect(screen.queryByText('footer')).toBeNull();

    act(() => {
      onVisibilityChange(false);
    });
    await settle();
    expect(screen.getByText('footer')).toBeTruthy();
  });

  it('hides the footer while the gated-server approval dialog is open', async () => {
    // ink's layout swaps the whole Composer — footer included — for the dialog
    // mount while any dialog is visible, and the approval is one of them. Here
    // the footer is a sibling with its own gate, so it needs the same term.
    mocks.state.mcpQueue.push({ name: 'acceptance-server' });
    renderApp();
    await settle();
    expect(screen.getByText('mcp-approval')).toBeTruthy();
    expect(screen.queryByText('footer')).toBeNull();
  });

  it('keeps an armed quit warning mounted while a dialog hides the footer', async () => {
    // A dialog unmounts the composer, so nothing intercepts Ctrl+C and the
    // app-level guard still arms. The warning has to survive the footer's
    // dialog gate, or a second press exits with nothing ever shown.
    renderApp({ exitHint: 'Press Ctrl+C again to exit.' });
    await settle();
    expect(screen.getByText('footer')).toBeTruthy();

    mocks.state.handleResult = {
      kind: 'open_dialog',
      request: { dialog: 'help' },
    } satisfies OpenTuiDispatchOutcome;
    await submit('/help');
    expect(screen.getByText('dialog:help')).toBeTruthy();
    expect(screen.queryByText('input-prompt')).toBeNull();
    expect(screen.getByText('footer')).toBeTruthy();
    expect(mocks.state.footerProps?.['exitHint']).toBe(
      'Press Ctrl+C again to exit.',
    );
  });

  it('builds one host, and one dispatcher, across re-renders', async () => {
    const props = {
      config: CONFIG,
      settings: SETTINGS,
      logger: null,
      commands: [] as readonly SlashCommand[],
      getSessionStats,
      onTranscriptEvent: vi.fn(),
      onTranscriptReset: vi.fn(),
    };
    const view = render(<OpenTuiApp {...props} />);
    await settle();

    // A turn re-renders this component repeatedly. Every transcript seam prop
    // above is a stable identity (the live turn memoizes them with empty-dep
    // useCallbacks), so rebuilding the host here would mean the shell's own
    // memo broke — and a churning host loses `host.history` per render.
    for (const streaming of [true, false, true, false]) {
      await act(async () => {
        view.rerender(<OpenTuiApp {...props} streaming={streaming} />);
        await Promise.resolve();
      });
    }

    const logger = {
      getPreviousUserMessages: vi.fn().mockResolvedValue([]),
    } as unknown as NonNullable<AppProps['logger']>;
    await act(async () => {
      view.rerender(<OpenTuiApp {...props} logger={logger} />);
    });

    expect(mocks.state.dispatcherConstructions).toBe(1);
    expect(new Set(mocks.state.hosts).size).toBe(1);
    expect((mocks.state.host as OpenTuiAppHost).logger).toBe(logger);
  });

  it.each(['promptId', 'rewindId'] as const)(
    'rewinds a hidden %s turn from collapsed real host history and cannot expand discarded command rows',
    async (identityField) => {
      const targetKey =
        identityField === 'promptId' ? 'p2' : 'legacy-record:target';
      const api: Content[] = [
        { role: 'user', parts: [{ text: 'first' }] },
        { role: 'model', parts: [{ text: 'answer' }] },
        { role: 'user', parts: [{ text: 'second' }] },
      ];
      markApiHistoryPrompt(api[0], 'p1');
      markApiHistoryPrompt(api[2], targetKey);
      const truncateHistory = vi.fn();
      const rewindRecording = vi.fn();
      const getRewindTurnIndex = vi.fn((id: string) =>
        id === targetKey ? 3 : -1,
      );
      const config = {
        ...CONFIG,
        getLlmClient: () => ({ getHistoryShallow: () => api, truncateHistory }),
        getChatRecordingService: () => ({
          rewindRecording,
          getRewindTurnIndex,
        }),
        getFileHistoryService: () => ({ getSnapshots: () => [] }),
        getContextFilePaths: () => ['/repo/AGENTS.md'],
      } as unknown as Config;
      const owner = renderHook(() => useOpenTuiLiveTurn({ config }));
      const setText = vi.fn();
      const invalidateImportedInput = vi.fn();
      const props: AppProps = {
        config,
        settings: SETTINGS,
        logger: null,
        commands: [],
        startupHistory: [
          {
            id: 0,
            type: 'info',
            text: 'hidden retained source',
            display: { suppressOnRestore: true },
          },
        ],
        getSessionStats,
        initialDialog: { dialog: 'rewind' },
        onTranscriptEvent: owner.result.current.applyEvent,
        onTranscriptReset: owner.result.current.resetTranscript,
        onRewindTranscript: owner.result.current.rewindTranscript,
        onSubmitPrompt: vi.fn(() => true),
        isCurrentHistory: owner.result.current.isCurrentHistory,
        composerHandle: {
          current: { getText: () => '', setText, invalidateImportedInput },
        },
      };
      const view = render(
        <OpenTuiApp {...props} historyItems={owner.result.current.items} />,
      );
      await settle();
      const host = mocks.state.host as OpenTuiAppHost;
      let kept: readonly HistoryItem[];
      await act(async () => {
        host.addItem(
          { type: 'user', text: 'first', promptId: 'p1', sentToModel: true },
          1,
        );
        host.addItem({ type: 'user', text: '/help', sentToModel: false }, 2);
        host.addItem({ type: 'info', text: 'kept line one\nkept line two' }, 3);
        kept = [...host.getHistory()];
        host.addItem(
          {
            type: 'user',
            text: 'second',
            [identityField]: targetKey,
            sentToModel: true,
          },
          4,
        );
        host.addItem(
          { type: 'info', text: 'discarded line one\ndiscarded line two' },
          5,
        );
        host.addItem(
          { type: 'info', text: 'Read context files: /repo/AGENTS.md' },
          6,
        );
        const collapsed = applyCollapsePolicyAndSummary(
          [...host.getHistory()],
          true,
        );
        host.loadHistory(collapsed);
        host.resetTranscript(projectHistoryToStreamEvents(collapsed, {}));
      });
      view.rerender(
        <OpenTuiApp {...props} historyItems={owner.result.current.items} />,
      );
      const turns = mocks.state.dialogProps![
        'rewindTurns'
      ] as LiveHistoryItem[];
      const target = turns.find(
        (item) =>
          item.kind === 'user' &&
          item.canonicalHistoryItem?.type === 'user' &&
          (item.canonicalHistoryItem.promptId ??
            item.canonicalHistoryItem.rewindId) === targetKey,
      )!;
      expect(target.display?.suppressOnRestore).toBe(true);
      expect(turns.filter((item) => item.kind === 'user')).toHaveLength(2);
      const rewind = mocks.state.dialogProps!['onRewind'] as (
        turn: { id: string },
        option: 'conversation',
      ) => Promise<void>;
      await act(async () => {
        await rewind(target, 'conversation');
      });
      expect(truncateHistory).toHaveBeenCalledExactlyOnceWith(2);
      expect(getRewindTurnIndex).toHaveBeenCalledExactlyOnceWith(targetKey);
      expect(rewindRecording).toHaveBeenCalledExactlyOnceWith(
        3,
        { truncatedCount: 3 },
        [],
      );
      expect(host.getHistory()).toEqual(expandCollapsedHistory([...kept!]));
      expect(owner.result.current.items.at(-1)).toMatchObject({
        kind: 'info',
        text: expect.stringContaining('Conversation rewound'),
      });
      await vi.waitFor(() =>
        expect(setText).toHaveBeenCalledExactlyOnceWith('second'),
      );
      expect(invalidateImportedInput).toHaveBeenCalledOnce();
      expect(
        owner.result.current.items.every(
          (item) =>
            !item.display?.suppressOnRestore &&
            item.display?.kind !== 'collapse-summary',
        ),
      ).toBe(true);
      expect(
        owner.result.current.items.some(
          (item) => 'text' in item && item.text.includes('discarded'),
        ),
      ).toBe(false);
      expect(
        owner.result.current.items.some(
          (item) => 'text' in item && item.text.includes('kept line two'),
        ),
      ).toBe(true);
      mocks.state.handleResult = false;
      await submit('continue after rewind');
      expect(
        owner.result.current.items.filter(
          (item) =>
            item.kind === 'info' &&
            item.text.startsWith(CONTEXT_FILES_ANNOUNCEMENT_PREFIX),
        ),
      ).toHaveLength(1);
      await act(async () => {
        owner.result.current.applyEvent({
          type: 'user',
          text: 'new prompt after rewind',
          promptId: 'p3',
          sentToModel: true,
        });
        owner.result.current.applyEvent({ type: 'text', delta: 'new answer' });
        owner.result.current.applyEvent({ type: 'done' });
      });
      const newLiveRows = owner.result.current.items.slice(-2);
      // The command-only host has no later model rows. Expanding its restored
      // prefix must preserve the actual newer live rows and their identities.
      const afterRewind = [...host.getHistory()];
      const retained = host
        .getHistory()
        .map((item) => ({ ...item, display: { suppressOnRestore: true } }));
      host.loadHistory(retained);
      const context = createOpenTuiCommandContext(
        host,
        { config, settings: SETTINGS, logger: null },
        { wasIdleBeforeDispatch: true },
      );
      await act(async () => {
        await historyCommand.subCommands!.find(
          (command) => command.name === 'expand-now',
        )!.action!(context, '');
      });
      expect(context.ui.history.map((item) => item.id)).toEqual(
        afterRewind.map((item) => item.id),
      );
      for (const item of newLiveRows)
        expect(owner.result.current.items).toContain(item);
      expect(owner.result.current.items.at(-2)).toMatchObject({
        kind: 'user',
        text: 'new prompt after rewind',
        promptId: 'p3',
      });
      expect(owner.result.current.items.at(-1)).toMatchObject({
        kind: 'assistant',
        text: 'new answer',
        streaming: false,
      });
      expect(
        owner.result.current.items.some(
          (item) => 'text' in item && item.text === 'hidden retained source',
        ),
      ).toBe(true);
      expect(
        owner.result.current.items.some(
          (item) => 'text' in item && item.text.includes('discarded'),
        ),
      ).toBe(false);
      expect(
        owner.result.current.items.some(
          (item) => 'text' in item && item.text.includes('kept line two'),
        ),
      ).toBe(true);
    },
  );

  it.each(['session', 'same-session-resume', 'new-turn'] as const)(
    'discards delayed file rewind after %s without touching the successor',
    async (change) => {
      let sessionId = 'original';
      let release!: () => void;
      const filesRestored = vi.fn();
      const fileRewind = vi.fn(async () => {
        await new Promise<void>((resolve) => {
          release = resolve;
        });
        filesRestored();
        return { filesChanged: ['owned.txt'], filesFailed: [] };
      });
      const api: Content[] = [{ role: 'user', parts: [{ text: 'first' }] }];
      markApiHistoryPrompt(api[0], 'p1');
      const truncateHistory = vi.fn();
      const rewindRecording = vi.fn();
      const onRewindTranscript = vi.fn();
      const onTranscriptEvent = vi.fn();
      const config = {
        ...CONFIG,
        getSessionId: () => sessionId,
        getLlmClient: () => ({ getHistoryShallow: () => api, truncateHistory }),
        getChatRecordingService: () => ({
          rewindRecording,
          getRewindTurnIndex: (id: string) => (id === 'p1' ? 0 : -1),
        }),
        getFileHistoryService: () => ({
          rewind: fileRewind,
          getSnapshots: () => [],
        }),
      } as unknown as Config;
      const initial: readonly LiveHistoryItem[] = [
        {
          kind: 'user',
          id: 'live-first',
          text: 'first',
          promptId: 'p1',
          sentToModel: true,
        },
      ];
      let currentItems = initial;
      const props: AppProps = {
        config,
        settings: SETTINGS,
        logger: null,
        commands: [],
        getSessionStats,
        initialDialog: { dialog: 'rewind' },
        onRewindTranscript,
        isCurrentHistory: (snapshot) => snapshot === currentItems,
        onTranscriptEvent,
      };
      const view = render(<OpenTuiApp {...props} historyItems={initial} />);
      await settle();
      const rewind = mocks.state.dialogProps!['onRewind'] as (
        turn: { id: string },
        option: 'both',
      ) => Promise<void>;
      let pending!: Promise<void>;
      act(() => {
        pending = rewind(initial[0], 'both');
      });
      expect(fileRewind).toHaveBeenCalledExactlyOnceWith('p1', true);
      const successor: readonly LiveHistoryItem[] = [
        {
          kind: 'user',
          id: 'successor',
          text: 'keep me',
          promptId: 'new',
          sentToModel: true,
        },
      ];
      currentItems = successor;
      if (change === 'session') sessionId = 'next';
      await act(async () => {
        view.rerender(
          <OpenTuiApp
            {...props}
            historyItems={successor}
            streaming={change === 'new-turn'}
          />,
        );
      });
      await act(async () => {
        release();
        await pending;
      });
      expect(filesRestored).toHaveBeenCalledOnce();
      expect(truncateHistory).not.toHaveBeenCalled();
      expect(rewindRecording).not.toHaveBeenCalled();
      expect(onRewindTranscript).not.toHaveBeenCalled();
      expect(onTranscriptEvent).not.toHaveBeenCalled();
      expect((mocks.state.host as OpenTuiAppHost).getHistory()).toEqual([]);
    },
  );

  it('reserves the update-notification slot, hidden while a dialog is open', async () => {
    renderApp({ updateNotice: 'Update available: v1.2.3' });
    await settle();
    expect(screen.getByText('Update available: v1.2.3')).toBeTruthy();

    // A dialog opening must hide the banner (ink parity: !dialogsVisible).
    mocks.state.handleResult = {
      kind: 'open_dialog',
      request: { dialog: 'help' },
    } satisfies OpenTuiDispatchOutcome;
    await submit('/help');
    expect(screen.getByText('dialog:help')).toBeTruthy();
    expect(screen.queryByText('Update available: v1.2.3')).toBeNull();

    const onClose = mocks.state.dialogProps?.['onClose'] as () => void;
    await act(async () => {
      onClose();
    });
    expect(screen.getByText('Update available: v1.2.3')).toBeTruthy();
  });

  it('routes an open_dialog outcome to the dialog mount and closes it', async () => {
    renderApp();
    await settle();
    mocks.state.handleResult = {
      kind: 'open_dialog',
      request: { dialog: 'help' },
    } satisfies OpenTuiDispatchOutcome;

    await submit('/help');
    expect(screen.getByText('dialog:help')).toBeTruthy();
    expect(screen.queryByText('input-prompt')).toBeNull();

    const onClose = mocks.state.dialogProps?.['onClose'] as () => void;
    await act(async () => {
      onClose();
    });
    expect(screen.getByText('input-prompt')).toBeTruthy();
  });

  it('routes settings sub-dialog rows to their own dialogs (U-9)', async () => {
    renderApp();
    await settle();
    mocks.state.handleResult = {
      kind: 'open_dialog',
      request: { dialog: 'settings' },
    } satisfies OpenTuiDispatchOutcome;
    await submit('/settings');
    expect(screen.getByText('dialog:settings')).toBeTruthy();

    const onSelectSetting = mocks.state.dialogProps?.['onSelectSetting'] as (
      name: string,
    ) => void;
    expect(typeof onSelectSetting).toBe('function');

    // Ink DialogManager parity: each row opens the dialog ink opens, the
    // model rows in their own mode. Each selection replaces the current
    // request, so no close/re-open dance is needed between rows.
    const cases: Array<[string, Record<string, unknown>]> = [
      ['ui.theme', { dialog: 'theme' }],
      ['general.preferredEditor', { dialog: 'editor' }],
      ['fastModel', { dialog: 'model', mode: 'fast' }],
      ['visionModel', { dialog: 'model', mode: 'vision' }],
    ];
    for (const [name, request] of cases) {
      await act(async () => {
        onSelectSetting(name);
      });
      expect(mocks.state.dialogProps?.['request']).toEqual(request);
    }

    await act(async () => {
      onSelectSetting('some.other.setting');
    });
    expect(screen.getByText('input-prompt')).toBeTruthy();
  });

  it('fills the composer through the entry-owned handle (U-9)', async () => {
    const setText = vi.fn();
    const composerHandle = { current: { getText: () => '', setText } };
    renderApp({ composerHandle });
    await settle();
    mocks.state.handleResult = {
      kind: 'open_dialog',
      request: { dialog: 'arena', mode: 'start' },
    } satisfies OpenTuiDispatchOutcome;
    await submit('/arena start');
    expect(screen.getByText('dialog:arena')).toBeTruthy();

    // The picker unmounts the prompt before remounting it, so the shell
    // fills through the polling injector rather than the current handle.
    const fillInput = mocks.state.dialogProps?.['fillInput'] as (
      text: string,
    ) => void;
    expect(typeof fillInput).toBe('function');
    await act(async () => {
      fillInput('/arena start --models a,b ');
      await new Promise((resolve) => setTimeout(resolve, 40));
    });
    expect(setText).toHaveBeenCalledWith('/arena start --models a,b ');
  });

  async function admit(
    text: string,
    images?: readonly string[],
    options?: { submittedPrompt?: string; deferUntilIdle?: boolean },
  ) {
    const callback = mocks.state.inputProps?.['onSubmit'] as (
      text: string,
      images?: readonly string[],
      options?: { submittedPrompt?: string; deferUntilIdle?: boolean },
    ) => Promise<boolean>;
    let accepted = false;
    await act(async () => {
      accepted = await callback(text, images, options);
    });
    return accepted;
  }

  it('acknowledges only an owner that accepts the complete prompt', async () => {
    mocks.state.handleResult = false as unknown as OpenTuiDispatchOutcome;
    const onSubmitPrompt = vi
      .fn()
      .mockReturnValueOnce(false)
      .mockReturnValue(true);
    renderApp({ onSubmitPrompt });
    await settle();
    expect(await admit('retry', ['/tmp/a.png'])).toBe(false);
    expect(await admit('retry', ['/tmp/a.png'])).toBe(true);
    expect(onSubmitPrompt).toHaveBeenCalledTimes(2);
  });

  it('rejects a missing live owner and failed gateway admission', async () => {
    mocks.state.handleResult = false as unknown as OpenTuiDispatchOutcome;
    const view = renderApp();
    await settle();
    expect(await admit('keep draft')).toBe(false);
    expect(
      screen.getByText('The live prompt turn is not wired in this shell.'),
    ).toBeTruthy();
    view.unmount();
    mocks.state.loadRejects = true;
    renderApp({ commands: undefined });
    await settle();
    expect(await admit('/help')).toBe(false);
  });

  it('routes an attached slash prompt to the model with defer and raw provenance', async () => {
    const onSubmitPrompt = vi.fn(() => true);
    renderApp({ onSubmitPrompt, streaming: true });
    await settle();
    expect(
      await admit('/help', ['/tmp/a.png'], {
        submittedPrompt: '/help',
        deferUntilIdle: true,
      }),
    ).toBe(true);
    expect(mocks.state.handledTexts).toEqual([]);
    expect(onSubmitPrompt).toHaveBeenCalledExactlyOnceWith(
      '/help',
      ['/tmp/a.png'],
      { submittedPrompt: '/help', deferUntilIdle: true },
    );
  });

  it('rejects image-bearing shell input without executing or admitting any part', async () => {
    const onSubmitPrompt = vi.fn(() => true);
    renderApp({ onSubmitPrompt });
    await settle();
    await act(async () => {
      (mocks.state.inputProps?.['onToggleShellMode'] as () => void)();
    });
    expect(await admit('echo unsafe', ['/tmp/a.png'])).toBe(false);
    expect(mocks.state.handledTexts).toEqual([]);
    expect(mocks.state.executeUserShell).not.toHaveBeenCalled();
    expect(onSubmitPrompt).not.toHaveBeenCalled();
    expect(screen.getByText(/Exit shell mode and try again/)).toBeTruthy();
  });

  it.each([
    { name: 'c', ctrl: true, sequence: '\x03' },
    { name: 'escape', ctrl: false, sequence: '\x1b' },
  ])(
    'aborts the local shell signal on $name without cancelling the model lane',
    async (key) => {
      let release!: () => void;
      const done = new Promise<void>((resolve) => {
        release = resolve;
      });
      const signals: AbortSignal[] = [];
      mocks.state.executeUserShell.mockImplementation(((
        _config: unknown,
        _command: string,
        _emit: unknown,
        signal: AbortSignal,
      ) => {
        signals.push(signal);
        return done;
      }) as unknown as () => Promise<void>);
      mocks.state.handleResult = false as unknown as OpenTuiDispatchOutcome;
      const onInterrupt = vi.fn();
      renderApp({ streaming: false, onInterrupt, onTranscriptEvent: vi.fn() });
      await settle();
      await act(async () => {
        (mocks.state.inputProps?.['onToggleShellMode'] as () => void)();
      });
      try {
        await submit('sleep 10');
        expect(signals).toHaveLength(1);
        expect(signals[0].aborted).toBe(false);
        await act(async () => {
          mocks.state.keyboardHandlers.at(-1)!({
            ...key,
            eventType: 'release',
            preventDefault: vi.fn(),
          });
        });
        expect(signals[0].aborted).toBe(false);
        expect(onInterrupt).not.toHaveBeenCalled();
        await act(async () => {
          mocks.state.keyboardHandlers.at(-1)!({
            ...key,
            eventType: 'press',
            preventDefault: vi.fn(),
          });
        });
        expect(signals[0].aborted).toBe(true);
        expect(onInterrupt).not.toHaveBeenCalled();
      } finally {
        await act(async () => {
          release();
          await done;
        });
        await settle();
      }
    },
  );

  it.each([
    { name: 'c', ctrl: true, sequence: '\x03' },
    { name: 'escape', ctrl: false, sequence: '\x1b' },
  ])(
    'keeps a held local shell alive while the model owns $name, then cancels it when the model settles',
    async (key) => {
      let release!: () => void;
      const done = new Promise<void>((resolve) => {
        release = resolve;
      });
      const signals: AbortSignal[] = [];
      mocks.state.executeUserShell.mockImplementation(((
        _config: unknown,
        _command: string,
        _emit: unknown,
        signal: AbortSignal,
      ) => {
        signals.push(signal);
        return done;
      }) as unknown as () => Promise<void>);
      mocks.state.handleResult = false as unknown as OpenTuiDispatchOutcome;
      const onInterrupt = vi.fn();
      const props: AppProps = {
        config: CONFIG,
        settings: SETTINGS,
        logger: null,
        commands: [],
        getSessionStats,
        streaming: true,
        onInterrupt,
        onTranscriptEvent: vi.fn(),
      };
      const view = render(<OpenTuiApp {...props} />);
      await settle();
      try {
        await act(async () => {
          mocks.state.keyboardHandlers.at(-1)!({
            ...key,
            eventType: 'press',
            preventDefault: vi.fn(),
          });
        });
        expect(mocks.state.executeUserShell).not.toHaveBeenCalled();
        expect(onInterrupt).not.toHaveBeenCalled();
        await act(async () => {
          view.rerender(<OpenTuiApp {...props} streaming={false} />);
        });
        await act(async () => {
          (mocks.state.inputProps?.['onToggleShellMode'] as () => void)();
        });
        await submit('sleep 10');
        expect(signals).toHaveLength(1);
        expect(signals[0].aborted).toBe(false);
        await act(async () => {
          view.rerender(<OpenTuiApp {...props} streaming />);
        });
        await act(async () => {
          mocks.state.keyboardHandlers.at(-1)!({
            ...key,
            eventType: 'press',
            preventDefault: vi.fn(),
          });
        });
        expect(signals[0].aborted).toBe(false);
        expect(onInterrupt).not.toHaveBeenCalled();
        await act(async () => {
          view.rerender(<OpenTuiApp {...props} streaming={false} />);
        });
        await act(async () => {
          mocks.state.keyboardHandlers.at(-1)!({
            ...key,
            eventType: 'press',
            preventDefault: vi.fn(),
          });
        });
        expect(signals[0].aborted).toBe(true);
        expect(onInterrupt).not.toHaveBeenCalled();
      } finally {
        await act(async () => {
          release();
          await done;
        });
        view.unmount();
      }
    },
  );

  it.each([
    { name: 'c', ctrl: true, sequence: '\x03' },
    { name: 'escape', ctrl: false, sequence: '\x1b' },
  ])(
    'leaves a held local shell to the dialog on $name until that dialog closes',
    async (key) => {
      let release!: () => void;
      const done = new Promise<void>((resolve) => {
        release = resolve;
      });
      const signals: AbortSignal[] = [];
      mocks.state.executeUserShell.mockImplementation(((
        _config: unknown,
        _command: string,
        _emit: unknown,
        signal: AbortSignal,
      ) => {
        signals.push(signal);
        return done;
      }) as unknown as () => Promise<void>);
      mocks.state.handleResult = false as unknown as OpenTuiDispatchOutcome;
      const onInterrupt = vi.fn();
      renderApp({ streaming: false, onInterrupt, onTranscriptEvent: vi.fn() });
      await settle();
      await act(async () => {
        (mocks.state.inputProps?.['onToggleShellMode'] as () => void)();
      });
      try {
        await submit('sleep 10');
        expect(signals).toHaveLength(1);
        mocks.state.handleResult = {
          kind: 'open_dialog',
          request: { dialog: 'help' },
        } satisfies OpenTuiDispatchOutcome;
        await submit('/help');
        expect(screen.getByText('dialog:help')).toBeTruthy();
        await act(async () => {
          mocks.state.keyboardHandlers.at(-1)!({
            ...key,
            eventType: 'press',
            preventDefault: vi.fn(),
          });
        });
        expect(signals[0].aborted).toBe(false);
        expect(onInterrupt).not.toHaveBeenCalled();
        await act(async () => {
          (mocks.state.dialogProps?.['onClose'] as () => void)();
        });
        await settle();
        expect(screen.queryByText('dialog:help')).toBeNull();
        await act(async () => {
          mocks.state.keyboardHandlers.at(-1)!({
            ...key,
            eventType: 'press',
            preventDefault: vi.fn(),
          });
        });
        expect(signals[0].aborted).toBe(true);
        expect(onInterrupt).not.toHaveBeenCalled();
      } finally {
        await act(async () => {
          release();
          await done;
        });
        await settle();
      }
    },
  );

  it('does not retry while a held shell owns the local lane', async () => {
    let release!: () => void;
    const shellDone = new Promise<void>((resolve) => {
      release = resolve;
    });
    mocks.state.executeUserShell.mockReturnValue(shellDone);
    mocks.state.handleResult = false as unknown as OpenTuiDispatchOutcome;
    const onRetryPrompt = vi.fn();
    renderApp({ onRetryPrompt, onTranscriptEvent: vi.fn() });
    await settle();
    await act(async () => {
      (mocks.state.inputProps?.['onToggleShellMode'] as () => void)();
    });
    try {
      await submit('sleep 1');
      expect(mocks.state.executeUserShell).toHaveBeenCalledOnce();
      act(() => {
        (mocks.state.inputProps!['onRetry'] as () => void)();
      });
      expect(onRetryPrompt).not.toHaveBeenCalled();
      await act(async () => {
        release();
        await shellDone;
      });
      await settle();
      act(() => {
        (mocks.state.inputProps!['onRetry'] as () => void)();
      });
      expect(onRetryPrompt).toHaveBeenCalledOnce();
    } finally {
      await act(async () => {
        release();
        await shellDone;
      });
      await settle();
    }
  });

  it('retains a previously accepted shell-blocked prompt when later live admission fails', async () => {
    let release!: () => void;
    const shellDone = new Promise<void>((resolve) => {
      release = resolve;
    });
    mocks.state.executeUserShell.mockReturnValue(shellDone);
    mocks.state.handleResult = false as unknown as OpenTuiDispatchOutcome;
    const onSubmitPrompt = vi.fn(() => false);
    renderApp({ onSubmitPrompt, onTranscriptEvent: vi.fn() });
    await settle();
    await act(async () => {
      (mocks.state.inputProps?.['onToggleShellMode'] as () => void)();
    });
    expect(await admit('sleep 1')).toBe(true);
    await act(async () => {
      (mocks.state.inputProps?.['onToggleShellMode'] as () => void)();
    });
    expect(
      await admit('queued', ['/tmp/a.png'], {
        submittedPrompt: 'raw queued',
        deferUntilIdle: true,
      }),
    ).toBe(true);
    await act(async () => {
      release();
      await shellDone;
    });
    expect(onSubmitPrompt).toHaveBeenCalledTimes(1);
    expect(mocks.state.inputProps?.['queueLength']).toBe(1);
    let popped: unknown;
    await act(async () => {
      popped = (mocks.state.inputProps?.['onPopQueue'] as () => unknown)();
    });
    expect(popped).toMatchObject({
      text: 'queued',
      imagePaths: ['/tmp/a.png'],
      submittedPrompt: 'raw queued',
    });
    expect(mocks.state.inputProps?.['queueLength']).toBe(0);
    expect(onSubmitPrompt).toHaveBeenCalledTimes(1);
  });

  it('sends a submit_prompt outcome to the live-turn seam', async () => {
    const onSubmitPrompt = vi.fn(() => true);
    renderApp({ onSubmitPrompt });
    await settle();
    mocks.state.handleResult = {
      kind: 'submit_prompt',
      content: 'rewind to checkpoint',
    } satisfies OpenTuiDispatchOutcome;

    await submit('/rewind apply');
    expect(onSubmitPrompt).toHaveBeenCalledWith(
      'rewind to checkpoint',
      undefined,
      {
        modelOverride: undefined,
        onComplete: undefined,
        refreshContextFilesOnWrite: undefined,
        // The recorded invocation is already on the transcript, so the live
        // turn must not echo the generated content as a second user row.
        invocationEchoed: true,
      },
    );
  });

  it("forwards a submit_prompt outcome's per-turn options to the seam", async () => {
    const onSubmitPrompt = vi.fn(() => true);
    const onComplete = async () => {};
    renderApp({ onSubmitPrompt });
    await settle();
    mocks.state.handleResult = {
      kind: 'submit_prompt',
      content: 'summarize',
      modelOverride: 'qwen3-max',
      refreshContextFilesOnWrite: true,
      onComplete,
    } satisfies OpenTuiDispatchOutcome;

    await submit('/model summarize');
    expect(onSubmitPrompt).toHaveBeenCalledWith('summarize', undefined, {
      modelOverride: 'qwen3-max',
      refreshContextFilesOnWrite: true,
      onComplete,
      invocationEchoed: true,
    });
  });

  it('reaches the entry seam on a quit outcome', async () => {
    const onQuit = vi.fn();
    renderApp({ onQuit });
    await settle();
    const messages = [{ type: 'user', text: 'bye', id: 1 }] as never;
    mocks.state.handleResult = {
      kind: 'quit',
      messages,
    } satisfies OpenTuiDispatchOutcome;

    await submit('/quit');
    expect(onQuit).toHaveBeenCalledWith(messages);
  });

  it('applies live workflow opt-out changes to the selected Config', async () => {
    const apply = vi.fn();
    const config = {
      ...CONFIG,
      setWorkflowKeywordTriggerEnabled: apply,
    } as unknown as Config;
    const settings = {
      merged: { ui: { disableWorkflowKeywordTrigger: true } },
    } as LoadedSettings;
    const view = renderApp({ config, settings });
    await settle();
    expect(apply).toHaveBeenLastCalledWith(false);
    view.rerender(
      <OpenTuiApp
        config={config}
        settings={
          {
            merged: { ui: { disableWorkflowKeywordTrigger: false } },
          } as LoadedSettings
        }
        logger={null}
        commands={[]}
        getSessionStats={getSessionStats}
      />,
    );
    await settle();
    expect(apply).toHaveBeenLastCalledWith(true);
  });

  it('routes a settings restart through the existing quit cleanup flow', async () => {
    const onQuit = vi.fn();
    const onInterrupt = vi.fn();
    const onPopQueue = vi.fn();
    renderApp({ onQuit, onInterrupt, onPopQueue });
    await settle();
    mocks.state.handleResult = {
      kind: 'open_dialog',
      request: { dialog: 'settings' },
    } satisfies OpenTuiDispatchOutcome;

    await submit('/settings');
    const restart = mocks.state.dialogProps?.['onRestartRequest'];
    expect(restart).toBeTypeOf('function');
    act(() => (restart as () => void)());

    expect(onPopQueue).toHaveBeenCalledOnce();
    expect(onInterrupt).toHaveBeenCalledOnce();
    expect(onQuit).toHaveBeenCalledWith([]);
    expect(onInterrupt.mock.invocationCallOrder[0]).toBeLessThan(
      onQuit.mock.invocationCallOrder[0],
    );
  });

  it('sends a non-slash input (dispatcher returns false) as a plain prompt', async () => {
    const onSubmitPrompt = vi.fn(() => true);
    renderApp({ onSubmitPrompt });
    await settle();
    mocks.state.handleResult = false;

    await submit('summarize the diff');
    expect(onSubmitPrompt).toHaveBeenCalledWith(
      'summarize the diff',
      undefined,
      {
        submittedPrompt: 'summarize the diff',
        displayText: 'summarize the diff',
        humanInput: { text: 'summarize the diff' },
      },
    );
  });

  it('forwards a composer paste snapshot with the display projection into the live queue seam', async () => {
    mocks.state.handleResult = false as unknown as OpenTuiDispatchOutcome;
    const onSubmitPrompt = vi.fn();
    renderApp({ onSubmitPrompt });
    await settle();
    const displayText = '[Pasted Content 1200 chars]';
    const body = 'workflow payload'.padEnd(1200, 'x');
    const pasteExpansions = new Map([[displayText, body]]);
    const restoredDraft = {
      modelText: body,
      displayText,
      submittedPrompt: displayText,
      humanInput: { text: displayText },
      hasUnknownInput: false,
      pasteExpansions,
    };
    await submit(body, undefined, {
      displayText,
      humanInput: { text: displayText },
      pasteExpansions,
      restoredDraft,
    });
    expect(onSubmitPrompt).toHaveBeenCalledWith(body, undefined, {
      submittedPrompt: body,
      displayText,
      humanInput: { text: displayText },
      pasteExpansions,
      restoredDraft,
    });
  });

  it('does not forward restored composer metadata into a generated slash prompt', async () => {
    const onSubmitPrompt = vi.fn();
    renderApp({ onSubmitPrompt });
    await settle();
    mocks.state.handleResult = {
      kind: 'submit_prompt',
      content: 'generated prompt',
    };
    await submit('/generate', undefined, {
      displayText: '/generate',
      humanInput: { text: '/generate' },
      restoredDraft: {
        modelText: '/generate',
        displayText: '/generate',
        submittedPrompt: '/generate',
        humanInput: { text: '/generate' },
        hasUnknownInput: false,
      },
    });
    expect(onSubmitPrompt).toHaveBeenCalledOnce();
    const options = onSubmitPrompt.mock.calls[0]?.[2];
    expect(options).not.toHaveProperty('restoredDraft');
    expect(options).not.toHaveProperty('humanInput');
    expect(options).not.toHaveProperty('hasUnknownInput');
  });

  it('passes pasted image paths through structured, not folded into the text', async () => {
    const onSubmitPrompt = vi.fn(() => true);
    renderApp({ onSubmitPrompt });
    await settle();
    mocks.state.handleResult = false;

    await submit('what is in these', ['a.png', 'b.png']);
    // The shell has no business choosing an image encoding: the entry layer
    // builds the real parts (ink: attachments), so the paths stay separate.
    expect(onSubmitPrompt).toHaveBeenCalledWith(
      'what is in these',
      ['a.png', 'b.png'],
      {
        submittedPrompt: 'what is in these',
        displayText: 'what is in these',
        humanInput: { text: 'what is in these' },
      },
    );
  });

  it('forwards an @-mention raw, leaving expansion to the stream layer', async () => {
    const onSubmitPrompt = vi.fn(() => true);
    renderApp({ onSubmitPrompt });
    await settle();
    mocks.state.handleResult = false;

    // Expanding here would miss the text a turn queues mid-way, so the shell
    // hands over what was typed and `livePromptEvents` resolves the mentions.
    await submit('summarize @src/a.ts');
    expect(onSubmitPrompt).toHaveBeenCalledWith(
      'summarize @src/a.ts',
      undefined,
      {
        submittedPrompt: 'summarize @src/a.ts',
        displayText: 'summarize @src/a.ts',
        humanInput: { text: 'summarize @src/a.ts' },
      },
    );
  });

  it('announces the context files once per visible transcript', async () => {
    const onTranscriptEvent = vi.fn();
    renderApp({
      config: {
        ...CONFIG,
        getContextFilePaths: () => ['/repo/AGENTS.md'],
      } as unknown as Config,
      onTranscriptEvent,
      onSubmitPrompt: vi.fn(),
    });
    await settle();
    mocks.state.handleResult = false;

    const announced = () =>
      onTranscriptEvent.mock.calls
        .map(([event]) => event as { type?: string; text?: string })
        .filter((event) => event.type === 'info')
        .map((event) => event.text)
        .filter((text) => text?.startsWith(CONTEXT_FILES_ANNOUNCEMENT_PREFIX));

    await submit('first prompt');
    expect(announced()).toEqual(['Read context files: /repo/AGENTS.md']);

    // The files stay attached for the whole session, so ink announces them
    // once rather than on every prompt.
    await submit('second prompt');
    expect(announced()).toEqual(['Read context files: /repo/AGENTS.md']);

    // A clear wipes the emitted row, so ink re-arms and announces again.
    const host = mocks.state.host as { clearItems: () => void };
    await act(async () => {
      host.clearItems();
    });
    await submit('third prompt');
    expect(announced()).toEqual([
      'Read context files: /repo/AGENTS.md',
      'Read context files: /repo/AGENTS.md',
    ]);
  });

  it.each(['startup', 'reset'] as const)(
    'retains the context announcement latch from %s history',
    async (source) => {
      const history: HistoryItem[] = [
        {
          id: 1,
          type: 'info',
          text: 'Read context files: /repo/AGENTS.md',
          display: { suppressOnRestore: true },
        },
      ];
      const onTranscriptEvent = vi.fn();
      renderApp({
        config: {
          ...CONFIG,
          getContextFilePaths: () => ['/repo/AGENTS.md'],
        } as unknown as Config,
        startupHistory: source === 'startup' ? history : [],
        onTranscriptEvent,
        onSubmitPrompt: vi.fn(() => true),
      });
      await settle();
      const host = mocks.state.host as OpenTuiAppHost;
      if (source === 'reset') {
        act(() => {
          host.loadHistory(history);
          host.resetTranscript(projectHistoryToStreamEvents(history, {}));
        });
      }
      mocks.state.handleResult = false;
      await submit('after restore');
      expect(onTranscriptEvent).not.toHaveBeenCalled();
      act(() => host.clearItems());
      await submit('after clear');
      expect(onTranscriptEvent).toHaveBeenCalledExactlyOnceWith(
        expect.objectContaining({
          type: 'info',
          text: 'Read context files: /repo/AGENTS.md',
        }),
      );
    },
  );

  it('reports a not-wired notice for a plain prompt when no seam is provided', async () => {
    renderApp();
    await settle();
    mocks.state.handleResult = false;

    await submit('hello there');
    expect(
      screen.getByText('The live prompt turn is not wired in this shell.'),
    ).toBeTruthy();
  });

  it('does not publish a disposed dispatcher reload into the successor app command list', async () => {
    const initialCommands: readonly SlashCommand[] = [
      {
        name: 'before-reload',
        description: 'Before',
        kind: CommandKind.BUILT_IN,
      },
    ];
    const successorCommands: readonly SlashCommand[] = [
      {
        name: 'healthy-successor',
        description: 'Healthy',
        kind: CommandKind.BUILT_IN,
      },
    ];
    const staleCommands: readonly SlashCommand[] = [
      {
        name: 'abandoned-config',
        description: 'Old',
        kind: CommandKind.BUILT_IN,
      },
    ];
    let release!: (commands: readonly SlashCommand[]) => void;
    const held = new Promise<readonly SlashCommand[]>((resolve) => {
      release = resolve;
    });
    const firstConfig = {
      ...CONFIG,
      getTargetDir: () => '/owned/first',
      getSessionId: () => 'session-first',
    } as unknown as Config;
    const nextConfig = {
      ...CONFIG,
      getTargetDir: () => '/owned/next',
      getSessionId: () => 'session-next',
    } as unknown as Config;
    const props = {
      config: firstConfig,
      settings: SETTINGS,
      logger: null,
      commands: initialCommands,
      getSessionStats,
    };
    const view = render(<OpenTuiApp {...props} />);
    await settle();
    const firstHost = mocks.state.host as OpenTuiAppHost;
    mocks.state.loadCommandsOverride = () => held;
    let pending!: Promise<void>;
    act(() => {
      pending = Promise.resolve(firstHost.reloadCommands()).catch(
        () => undefined,
      );
    });
    try {
      expect(mocks.state.dispatcherConstructions).toBe(1);
      await act(async () => {
        view.rerender(
          <OpenTuiApp
            {...props}
            config={nextConfig}
            commands={successorCommands}
          />,
        );
      });
      await settle();
      expect(mocks.state.dispatcherConstructions).toBe(2);
      expect(mocks.state.host).not.toBe(firstHost);
      expect(mocks.state.inputProps?.['config']).toBe(nextConfig);
      mocks.state.handleResult = {
        kind: 'open_dialog',
        request: { dialog: 'help' },
      } satisfies OpenTuiDispatchOutcome;
      await submit('/help');
      expect(screen.getByText('dialog:help')).toBeTruthy();
      expect(mocks.state.dialogProps?.['commands']).toEqual(successorCommands);
      await act(async () => {
        (mocks.state.dialogProps?.['onClose'] as () => void)();
      });
      await act(async () => {
        release(staleCommands);
        await pending;
      });
      await submit('/help');
      expect(screen.getByText('dialog:help')).toBeTruthy();
      expect(mocks.state.dialogProps?.['config']).toBe(nextConfig);
      expect(mocks.state.dialogProps?.['commands']).toEqual(successorCommands);
    } finally {
      release(staleCommands);
      await act(async () => {
        await pending;
      });
      view.unmount();
    }
  });

  it('rejects submissions after a failed dispatcher init', async () => {
    const onSubmitPrompt = vi.fn(() => true);
    mocks.state.loadRejects = true;
    renderApp({ commands: undefined, onSubmitPrompt });
    await settle();

    await submit('/help');
    expect(onSubmitPrompt).not.toHaveBeenCalled();
    expect(
      screen.getByText(/failed to initialize \(registry exploded\)/),
    ).toBeTruthy();
  });

  it('drives the composer history from the host transcript', async () => {
    renderApp();
    await settle();
    const host = mocks.state.host as {
      addItem: (item: unknown, ts: number) => void;
    };
    await act(async () => {
      host.addItem({ type: 'user', text: 'earlier question' }, 1000);
    });
    const userMessages = mocks.state.inputProps?.['userMessages'] as string[];
    expect(userMessages).toContain('earlier question');
  });

  it('merges newest real prompts and refreshes persisted history only when history changes', async () => {
    let past = ['X', 'A', 'Y'];
    const getPreviousUserMessages = vi.fn(async () => past);
    renderApp({
      userMessages: ['B', 'A', 'B'],
      logger: { getPreviousUserMessages } as unknown as AppProps['logger'],
    });
    await settle();
    expect(mocks.state.inputProps?.['userMessages']).toEqual([
      'Y',
      'X',
      'A',
      'B',
    ]);
    const host = mocks.state.host as OpenTuiAppHost;
    await act(async () => host.setStreaming(true));
    expect(getPreviousUserMessages).toHaveBeenCalledTimes(1);
    past = ['X'];
    await act(async () => {
      host.addItem({ type: 'info', text: 'History changed' }, 1);
    });
    expect(getPreviousUserMessages).toHaveBeenCalledTimes(2);
    expect(mocks.state.inputProps?.['userMessages']).toEqual(['X', 'A', 'B']);
  });

  it('ignores a late persisted-history result after session replacement', async () => {
    let finishOld!: (texts: string[]) => void;
    let sessionId = 'old';
    const getPreviousUserMessages = vi
      .fn()
      .mockReturnValueOnce(
        new Promise<string[]>((resolve) => {
          finishOld = resolve;
        }),
      )
      .mockResolvedValue(['fresh']);
    const props: AppProps = {
      config: { ...CONFIG, getSessionId: () => sessionId } as Config,
      settings: SETTINGS,
      logger: { getPreviousUserMessages } as unknown as AppProps['logger'],
      commands: [],
      getSessionStats,
      userMessages: [],
    };
    const view = render(<OpenTuiApp {...props} />);
    await settle();
    sessionId = 'new';
    await act(async () => view.rerender(<OpenTuiApp {...props} />));
    expect(mocks.state.inputProps?.['userMessages']).toEqual(['fresh']);
    await act(async () => finishOld(['stale']));
    expect(mocks.state.inputProps?.['userMessages']).toEqual(['fresh']);
  });

  it('uses the live display projection for recall and clears it on a new session', async () => {
    const raw = '<system-reminder>literal</system-reminder> workflow';
    const view = renderApp({ userMessages: [raw] });
    await settle();
    const host = mocks.state.host as {
      addItem: (item: unknown, ts: number) => void;
    };
    await act(async () => {
      host.addItem({ type: 'user', text: 'old host history' }, 1000);
    });
    expect(mocks.state.inputProps?.['userMessages']).toEqual([raw]);
    view.rerender(
      <OpenTuiApp
        config={CONFIG}
        settings={SETTINGS}
        logger={null}
        commands={[]}
        getSessionStats={getSessionStats}
        userMessages={[]}
      />,
    );
    await settle();
    expect(mocks.state.inputProps?.['userMessages']).toEqual([]);
  });

  it('routes a host history write to the live transcript (U-28)', async () => {
    const onTranscriptEvent = vi.fn();
    renderApp({ onTranscriptEvent });
    await settle();
    const host = mocks.state.host as OpenTuiAppHost;
    await act(async () => {
      host.addItem({ type: 'info', text: 'Report filed.' }, 1000);
    });
    const history = host.getHistory();
    expect(history).toEqual([
      { type: 'info', text: 'Report filed.', id: 1001 },
    ]);
    expect(onTranscriptEvent).toHaveBeenCalledExactlyOnceWith({
      type: 'info',
      text: 'Report filed.',
      historyId: history[0].id,
      canonicalHistoryItem: history[0],
    });
    expect(onTranscriptEvent.mock.calls[0][0].canonicalHistoryItem).toBe(
      history[0],
    );
  });

  it('routes a host clear to an empty transcript reset (U-29)', async () => {
    const onTranscriptReset = vi.fn();
    renderApp({ onTranscriptReset });
    await settle();
    const host = mocks.state.host as { clearItems: () => void };
    await act(async () => {
      host.clearItems();
    });
    expect(onTranscriptReset).toHaveBeenCalledWith([]);
  });

  it('routes the session re-key to the entry seam', async () => {
    const onStartNewSession = vi.fn();
    renderApp({ onStartNewSession });
    await settle();
    const host = mocks.state.host as {
      startNewSession: (id: string) => void;
    };
    await act(async () => {
      host.startNewSession('sess-2');
    });
    expect(onStartNewSession).toHaveBeenCalledWith('sess-2');
    expect(screen.queryByText(/not re-keyed/)).toBeNull();
  });

  it('reports when no owner is wired to re-key the session state', async () => {
    renderApp();
    await settle();
    const host = mocks.state.host as {
      startNewSession: (id: string) => void;
    };
    await act(async () => {
      host.startNewSession('sess-2');
    });
    expect(
      screen.getByText('Session state was not re-keyed for the new session.'),
    ).toBeTruthy();
  });

  describe('direct extension setting owner', () => {
    type Manager = ReturnType<Config['getExtensionManager']>;
    type SettingRequest = NonNullable<
      Parameters<Manager['setRequestSetting']>[0]
    >;
    type ConsentRequest = Parameters<Manager['setRequestConsent']>[0];
    const setting = {
      name: 'Owned label',
      description: 'Required label',
      envVar: 'OWNED_LABEL',
    };
    function owner() {
      const register = vi.fn<(request: SettingRequest) => void>();
      const consent = vi.fn<(request: ConsentRequest) => void>();
      const config = {
        ...CONFIG,
        getExtensionManager: () => ({
          setRequestSetting: register,
          setRequestConsent: consent,
        }),
      } as unknown as Config;
      return {
        config,
        register,
        request: () => register.mock.calls.at(-1)![0],
        consent: () => consent.mock.calls.at(-1)![0],
      };
    }
    function shell(config: Config, streaming = false) {
      return (
        <OpenTuiApp
          config={config}
          settings={SETTINGS}
          logger={null}
          commands={[]}
          getSessionStats={getSessionStats}
          streaming={streaming}
        />
      );
    }
    function permission() {
      return mocks.state.extensionSettingProps!['permission'] as {
        resolve: (value: string) => void;
        cancel: () => void;
      };
    }
    it('owns setting input instead of composer and keeps exact value across rerenders', async () => {
      const o = owner();
      const view = render(shell(o.config));
      await settle();
      let pending!: Promise<string>;
      await act(async () => {
        pending = o.request()(setting);
      });
      expect(screen.getByText('extension-setting:Owned label')).toBeTruthy();
      expect(screen.queryByText('input-prompt')).toBeNull();
      view.rerender(shell(o.config, true));
      await settle();
      expect(o.register).toHaveBeenCalledTimes(1);
      await act(async () => permission().resolve('owned-value'));
      await expect(pending).resolves.toBe('owned-value');
      expect(screen.getByText('input-prompt')).toBeTruthy();
    });
    it('keeps settings and consent in one FIFO without sharing resolution', async () => {
      const o = owner();
      render(shell(o.config));
      await settle();
      let value!: Promise<string>;
      let consent!: Promise<void>;
      await act(async () => {
        value = o.request()(setting);
        consent = o.consent()({
          extensionConfig: { name: 'queued', version: '1.0.0' },
          originSource: 'QwenCode',
        });
      });
      expect(screen.getByText('extension-setting:Owned label')).toBeTruthy();
      expect(screen.queryByText(/Installing extension "queued"/)).toBeNull();
      await act(async () => permission().resolve('exact'));
      await expect(value).resolves.toBe('exact');
      expect(screen.getByText(/Installing extension "queued"/)).toBeTruthy();
      await act(async () =>
        (
          mocks.state.actionConfirmProps!['onResolve'] as (yes: boolean) => void
        )(true),
      );
      await expect(consent).resolves.toBeUndefined();
    });
    it('keeps consecutive setting requests independent and ignores the old submit', async () => {
      const o = owner();
      render(shell(o.config));
      await settle();
      let first!: Promise<string>;
      let second!: Promise<string>;
      await act(async () => {
        first = o.request()(setting);
        second = o.request()({
          ...setting,
          name: 'Second label',
          envVar: 'SECOND_LABEL',
        });
      });
      const old = permission();
      expect(screen.queryByText('extension-setting:Second label')).toBeNull();
      await act(async () => old.resolve('first-value'));
      await expect(first).resolves.toBe('first-value');
      expect(screen.getByText('extension-setting:Second label')).toBeTruthy();
      const next = permission();
      expect(next).not.toBe(old);
      await act(async () => old.resolve('stale-value'));
      expect(screen.getByText('extension-setting:Second label')).toBeTruthy();
      await act(async () => next.resolve('second-value'));
      await expect(second).resolves.toBe('second-value');
    });
    it('rejects a cancelled setting without committing a value', async () => {
      const o = owner();
      render(shell(o.config));
      await settle();
      let pending!: Promise<string>;
      await act(async () => {
        pending = o.request()(setting);
      });
      const rejected = pending.catch((error: unknown) => error);
      await act(async () => permission().cancel());
      await expect(rejected).resolves.toMatchObject({
        message: 'Setting input cancelled',
      });
      expect(screen.getByText('input-prompt')).toBeTruthy();
    });
    it.each(['replacement', 'unmount'] as const)(
      'rejects stale setting ownership on %s',
      async (change) => {
        const old = owner();
        const next = owner();
        const view = render(shell(old.config));
        await settle();
        const captured = old.request();
        let pending!: Promise<string>;
        await act(async () => {
          pending = captured(setting);
        });
        const rejected = pending.catch((error: unknown) => error);
        const late = permission().resolve;
        await act(async () => {
          if (change === 'replacement') view.rerender(shell(next.config));
          else view.unmount();
        });
        await expect(rejected).resolves.toMatchObject({
          message: 'Setting input cancelled',
        });
        await expect(captured(setting)).rejects.toThrow(
          'Setting input cancelled',
        );
        await act(async () => late('stale'));
        if (change === 'replacement') {
          let fresh!: Promise<string>;
          await act(async () => {
            fresh = next.request()(setting);
          });
          await act(async () => permission().resolve('new'));
          await expect(fresh).resolves.toBe('new');
          expect(next.register).toHaveBeenCalledTimes(1);
        }
      },
    );
  });

  describe('direct extension consent owner', () => {
    type Consent = Parameters<
      ReturnType<Config['getExtensionManager']>['setRequestConsent']
    >[0];
    const options = (name: string) => ({
      extensionConfig: { name, version: '1.0.0' },
      originSource: 'QwenCode' as const,
    });
    function owner() {
      const register = vi.fn<(request: Consent) => void>();
      const config = {
        ...CONFIG,
        getExtensionManager: () => ({
          setRequestConsent: register,
          setRequestSetting: vi.fn(),
        }),
      } as unknown as Config;
      return {
        config,
        register,
        request: () => register.mock.calls.at(-1)![0],
      };
    }
    function shell(config: Config, streaming = false) {
      return (
        <OpenTuiApp
          config={config}
          settings={SETTINGS}
          logger={null}
          commands={[]}
          getSessionStats={getSessionStats}
          streaming={streaming}
        />
      );
    }
    const answer = (yes: boolean) =>
      (mocks.state.actionConfirmProps!['onResolve'] as (yes: boolean) => void)(
        yes,
      );

    it('formats direct consent and preserves its pending owner on ordinary rerenders', async () => {
      const o = owner();
      const view = render(shell(o.config));
      await settle();
      let pending!: Promise<void>;
      await act(async () => {
        pending = o.request()(options('owned'));
      });
      const prompt = mocks.state.actionConfirmProps!['prompt'];
      expect(isValidElement(prompt)).toBe(true);
      if (!isValidElement(prompt))
        throw new Error('native prompt node missing');
      // buildJsxRuntime maps native text to span; raw strings still fail above.
      expect(prompt.type).toBe('span');
      expect(screen.getByText(/Installing extension "owned"/)).toBeTruthy();
      view.rerender(shell(o.config, true));
      await settle();
      expect(o.register).toHaveBeenCalledTimes(1);
      expect(screen.getByText(/Installing extension "owned"/)).toBeTruthy();
      await act(async () => answer(true));
      await expect(pending).resolves.toBeUndefined();
    });

    it('keeps independent FIFO Yes and No resolutions', async () => {
      const o = owner();
      render(shell(o.config));
      await settle();
      let first!: Promise<void>;
      let second!: Promise<void>;
      await act(async () => {
        first = o.request()(options('first'));
        second = o.request()(options('second'));
      });
      const rejected = second.catch((error: unknown) => error);
      expect(screen.getByText(/Installing extension "first"/)).toBeTruthy();
      expect(screen.queryByText(/Installing extension "second"/)).toBeNull();
      await act(async () => answer(true));
      await expect(first).resolves.toBeUndefined();
      expect(screen.getByText(/Installing extension "second"/)).toBeTruthy();
      await act(async () => answer(false));
      await expect(rejected).resolves.toMatchObject({
        message: expect.stringContaining('Installation cancelled'),
      });
    });

    it.each(['replacement', 'unmount'] as const)(
      'rejects pending and captured stale callbacks on %s',
      async (change) => {
        const old = owner();
        const next = owner();
        const view = render(shell(old.config));
        await settle();
        const captured = old.request();
        let pending!: Promise<void>;
        await act(async () => {
          pending = captured(options('old'));
        });
        const rejected = pending.catch((error: unknown) => error);
        const late = mocks.state.actionConfirmProps!['onResolve'] as (
          yes: boolean,
        ) => void;
        await act(async () => {
          if (change === 'replacement') view.rerender(shell(next.config));
          else view.unmount();
        });
        await expect(rejected).resolves.toMatchObject({
          message: expect.stringContaining('Installation cancelled'),
        });
        await expect(captured(options('stale'))).rejects.toThrow(
          'Extension installation cancelled',
        );
        await act(async () => late(true));
        if (change === 'replacement') {
          expect(screen.queryByText(/Installing extension "old"/)).toBeNull();
          let fresh!: Promise<void>;
          await act(async () => {
            fresh = next.request()(options('new'));
          });
          await act(async () => answer(true));
          await expect(fresh).resolves.toBeUndefined();
          expect(next.register).toHaveBeenCalledTimes(1);
        }
      },
    );
  });

  it('renders the shell confirmation modal and settles with its resolution', async () => {
    renderApp();
    await settle();
    const host = mocks.state.host as {
      presentShellConfirmation: (
        commands: readonly string[],
      ) => Promise<{ outcome: ToolConfirmationOutcome }>;
      presentActionConfirmation: (prompt: unknown) => Promise<boolean>;
    };

    const pending = host.presentShellConfirmation([
      'rm -rf build',
      'npm publish',
    ]);
    await act(async () => {
      await Promise.resolve();
    });
    expect(screen.getByText('shell-confirm')).toBeTruthy();
    expect(screen.queryByText('input-prompt')).toBeNull();
    const resolution = {
      outcome: ToolConfirmationOutcome.ProceedOnce,
      approvedCommands: ['rm -rf build', 'npm publish'],
    };
    await act(async () => {
      (mocks.state.shellConfirmProps?.['onResolve'] as (r: unknown) => void)(
        resolution,
      );
    });
    await expect(pending).resolves.toEqual(resolution);
    expect(screen.getByText('input-prompt')).toBeTruthy();

    const actionPending = host.presentActionConfirmation('delete?');
    await act(async () => {
      await Promise.resolve();
    });
    expect(screen.getByText('action-confirm')).toBeTruthy();
    await act(async () => {
      (mocks.state.actionConfirmProps?.['onResolve'] as (c: boolean) => void)(
        true,
      );
    });
    await expect(actionPending).resolves.toBe(true);
  });

  it.each(['abort', 'current loss'] as const)(
    'removes only owned A on %s and rejects stale callbacks',
    async (mode) => {
      const view = renderApp();
      await settle();
      const host = mocks.state.host as OpenTuiAppHost;
      const controller = new AbortController();
      let current = true;
      const a = vi.fn();
      const b = vi.fn();
      await act(async () => {
        host.addConfirmUpdateExtensionRequest({
          prompt: 'owned A',
          signal: controller.signal,
          isCurrent: () => current,
          onConfirm: a,
        });
        host.addConfirmUpdateExtensionRequest({
          prompt: 'owned B',
          onConfirm: b,
        });
      });
      expect(screen.getByText('owned A')).toBeTruthy();
      const lateA = mocks.state.actionConfirmProps!['onResolve'] as (
        value: boolean,
      ) => void;
      if (mode === 'abort') {
        await act(async () => controller.abort());
      } else {
        current = false;
        view.rerender(
          <OpenTuiApp
            config={CONFIG}
            settings={SETTINGS}
            logger={null}
            commands={[]}
            getSessionStats={getSessionStats}
          />,
        );
        await settle();
      }
      expect(a.mock.calls).toEqual([[false]]);
      expect(screen.queryByText('owned A')).toBeNull();
      expect(screen.getByText('owned B')).toBeTruthy();
      await act(async () => {
        lateA(true);
        lateA(false);
      });
      expect(a.mock.calls).toEqual([[false]]);
      expect(b).not.toHaveBeenCalled();
      expect(screen.getByText('owned B')).toBeTruthy();
      await act(async () =>
        (
          mocks.state.actionConfirmProps!['onResolve'] as (
            value: boolean,
          ) => void
        )(true),
      );
      expect(b.mock.calls).toEqual([[true]]);
      expect(screen.getByText('input-prompt')).toBeTruthy();
    },
  );

  it('denies an owned late yes even before current loss has rendered', async () => {
    renderApp();
    await settle();
    let current = true;
    const onConfirm = vi.fn();
    await act(async () =>
      (mocks.state.host as OpenTuiAppHost).addConfirmUpdateExtensionRequest({
        prompt: 'owned',
        isCurrent: () => current,
        onConfirm,
      }),
    );
    const late = mocks.state.actionConfirmProps!['onResolve'] as (
      value: boolean,
    ) => void;
    current = false;
    await act(async () => late(true));
    expect(onConfirm.mock.calls).toEqual([[false]]);
    expect(screen.queryByText('owned')).toBeNull();
  });

  it('does not render pre-aborted consent and denies owned consent once on unmount', async () => {
    const view = renderApp();
    await settle();
    const host = mocks.state.host as OpenTuiAppHost;
    const dead = new AbortController();
    dead.abort();
    const live = new AbortController();
    const a = vi.fn();
    const b = vi.fn();
    await act(async () => {
      host.addConfirmUpdateExtensionRequest({
        prompt: 'dead',
        signal: dead.signal,
        onConfirm: a,
      });
      host.addConfirmUpdateExtensionRequest({
        prompt: 'live',
        signal: live.signal,
        onConfirm: b,
      });
    });
    expect(a.mock.calls).toEqual([[false]]);
    expect(screen.queryByText('dead')).toBeNull();
    expect(screen.getByText('live')).toBeTruthy();
    const late = mocks.state.actionConfirmProps!['onResolve'] as (
      value: boolean,
    ) => void;
    view.unmount();
    await act(async () => {
      live.abort();
      late(true);
    });
    expect(b.mock.calls).toEqual([[false]]);
  });

  it('gives a waiting tool call priority over the composer and settles it', async () => {
    const onToolCallSettled = vi.fn();
    const call = {
      callId: 'call-1',
      name: 'run_shell_command',
      confirmationDetails: { type: 'info', title: 'ok?' },
    } as never;
    renderApp({
      waitingToolCalls: [call],
      onToolCallSettled,
    });
    await settle();
    expect(screen.getByText('tool-confirm')).toBeTruthy();
    expect(screen.queryByText('input-prompt')).toBeNull();

    await act(async () => {
      (mocks.state.toolConfirmProps?.['onSettled'] as () => void)();
    });
    expect(onToolCallSettled).toHaveBeenCalledWith('call-1');
  });

  it('outranks a parked tool call and routes the choice to the approval hook', async () => {
    // ink's dialog order ranks the gated-server approval above both the shell
    // and the tool confirmation, so a startup queue takes the slot outright.
    mocks.state.mcpQueue.push({ name: 'acceptance-server' });
    renderApp({
      waitingToolCalls: [
        {
          callId: 'call-1',
          name: 'run_shell_command',
          confirmationDetails: { type: 'info', title: 'ok?' },
        } as never,
      ],
      onToolCallSettled: vi.fn(),
    });
    await settle();
    expect(screen.getByText('mcp-approval')).toBeTruthy();
    expect(screen.queryByText('tool-confirm')).toBeNull();
    expect(mocks.state.mcpApprovalProps?.['server']).toEqual({
      name: 'acceptance-server',
    });
    expect(mocks.state.mcpApprovalProps?.['remaining']).toBe(0);

    const onSelect = mocks.state.mcpApprovalProps?.['onSelect'] as
      | ((choice: string) => void)
      | undefined;
    if (typeof onSelect !== 'function') {
      throw new Error('approval dialog was not given onSelect');
    }
    onSelect('approve');
    expect(mocks.state.handleMcpApprovalSelect).toHaveBeenCalledWith('approve');
  });

  it('passes streaming state and interrupt through to the composer', async () => {
    const onInterrupt = vi.fn();
    renderApp({ streaming: true, onInterrupt });
    await settle();
    expect(mocks.state.inputProps?.['streaming']).toBe(true);
    (mocks.state.inputProps?.['onInterrupt'] as () => void)();
    expect(onInterrupt).toHaveBeenCalled();
  });

  // A command's isIdleRef reads host.isStreaming() live, and the shell's
  // mirror is its only writer: it must follow the prop, never the dispatch.
  it('mirrors only the streaming prop onto the host a command reads', async () => {
    const props = {
      config: CONFIG,
      settings: SETTINGS,
      logger: null,
      commands: [] as readonly SlashCommand[],
      getSessionStats,
    };
    const view = render(<OpenTuiApp {...props} streaming={false} />);
    await settle();
    const rerender = (streaming: boolean) =>
      act(async () => {
        view.rerender(<OpenTuiApp {...props} streaming={streaming} />);
        await Promise.resolve();
      });
    const host = mocks.state.host as OpenTuiAppHost;

    // The dispatcher samples idle, then marks itself processing.
    const context = createOpenTuiCommandContext(
      host,
      { config: CONFIG, settings: SETTINGS, logger: null },
      { wasIdleBeforeDispatch: host.isIdle() },
    );
    await act(async () => {
      host.setIsProcessing(true);
    });
    expect(host.isIdle()).toBe(false);
    expect(host.isStreaming()).toBe(false);
    expect(context.ui.isIdleRef.current).toBe(true);

    await rerender(true);
    expect(host.isStreaming()).toBe(true);
    expect(context.ui.isIdleRef.current).toBe(false);

    await rerender(false);
    expect(host.isStreaming()).toBe(false);
    expect(context.ui.isIdleRef.current).toBe(true);
  });

  it('passes the follow-up suggestion and its dismiss through (U-7)', async () => {
    const onPromptSuggestionDismiss = vi.fn();
    renderApp({ promptSuggestion: 'Run the tests', onPromptSuggestionDismiss });
    await settle();
    expect(mocks.state.inputProps?.['promptSuggestion']).toBe('Run the tests');
    (mocks.state.inputProps?.['onPromptSuggestionDismiss'] as () => void)();
    expect(onPromptSuggestionDismiss).toHaveBeenCalledTimes(1);
  });

  it('holds a mid-turn slash command until the turn ends', async () => {
    mocks.state.deferDuringStreaming = true;
    const props = {
      config: CONFIG,
      settings: SETTINGS,
      logger: null,
      commands: [] as readonly SlashCommand[],
      getSessionStats,
      streaming: true,
    };
    const view = render(<OpenTuiApp {...props} />);
    await settle();

    await submit('/compress');
    expect(mocks.state.handledTexts).toEqual([]);
    expect(screen.getByText(/Queued \/compress/)).toBeTruthy();

    await act(async () => {
      view.rerender(<OpenTuiApp {...props} streaming={false} />);
      await Promise.resolve();
    });
    expect(mocks.state.handledTexts).toEqual(['/compress']);
  });

  it('runs a mid-turn slash command that opted into streaming at once', async () => {
    renderApp({ streaming: true });
    await settle();
    await submit('/help');
    expect(mocks.state.handledTexts).toEqual(['/help']);
  });

  it('claims a mid-turn shell-mode ?btw for the dispatcher, not the shell', async () => {
    const props = {
      config: CONFIG,
      settings: SETTINGS,
      logger: null,
      commands: [] as readonly SlashCommand[],
      getSessionStats,
      streaming: true,
    };
    const view = render(<OpenTuiApp {...props} />);
    await settle();
    await act(async () => {
      (mocks.state.inputProps?.['onToggleShellMode'] as () => void)();
    });

    await submit('?btw why');
    expect(mocks.state.handledTexts).toEqual(['?btw why']);
    expect(screen.queryByText(/Queued/)).toBeNull();

    // The idle edge must not resurrect it on the shell lane either.
    await act(async () => {
      view.rerender(<OpenTuiApp {...props} streaming={false} />);
      await Promise.resolve();
    });
    expect(mocks.state.handledTexts).toEqual(['?btw why']);
    expect(mocks.state.executeUserShell).not.toHaveBeenCalled();
  });

  it('keeps a slash-prefixed path on the shell lane when queued mid-turn', async () => {
    const props = {
      config: CONFIG,
      settings: SETTINGS,
      logger: null,
      commands: [] as readonly SlashCommand[],
      getSessionStats,
      streaming: true,
      onTranscriptEvent: vi.fn(),
    };
    const view = render(<OpenTuiApp {...props} />);
    await settle();
    await act(async () => {
      (mocks.state.inputProps?.['onToggleShellMode'] as () => void)();
    });

    await submit('/usr/bin/ls --color');
    expect(screen.getByText(/Queued \/usr\/bin\/ls/)).toBeTruthy();

    await act(async () => {
      view.rerender(<OpenTuiApp {...props} streaming={false} />);
      await Promise.resolve();
    });
    expect(mocks.state.handledTexts).toEqual([]);
    expect(mocks.state.executeUserShell).toHaveBeenCalledWith(
      CONFIG,
      '/usr/bin/ls --color',
      props.onTranscriptEvent,
      expect.any(AbortSignal),
      // The `!` row renders behind the 2-col input indicator, so the child
      // runs over that inner width (R1-42).
      expect.objectContaining({
        width: 120 - STATUS_INDICATOR_WIDTH,
        height: 40,
      }),
    );
  });

  it('dispatches a slash command instead of running it as shell at idle (U-33)', async () => {
    render(
      <OpenTuiApp
        config={CONFIG}
        settings={SETTINGS}
        logger={null}
        commands={[] as readonly SlashCommand[]}
        getSessionStats={getSessionStats}
        streaming={false}
      />,
    );
    await settle();
    await act(async () => {
      (mocks.state.inputProps?.['onToggleShellMode'] as () => void)();
    });

    await submit('/help');
    expect(mocks.state.handledTexts).toEqual(['/help']);
    expect(mocks.state.executeUserShell).not.toHaveBeenCalled();
  });

  it('holds a second shell submission and quit aborts every command', async () => {
    const signals: AbortSignal[] = [];
    mocks.state.executeUserShell.mockImplementation(((
      _config: unknown,
      _command: string,
      _emit: unknown,
      signal: AbortSignal,
    ) => {
      signals.push(signal);
      return new Promise<void>(() => {});
    }) as unknown as () => Promise<void>);
    mocks.state.handleResults.push(false as unknown as OpenTuiDispatchOutcome, {
      kind: 'quit',
      messages: [],
    } satisfies OpenTuiDispatchOutcome);
    const onQuit = vi.fn();
    const onInterrupt = vi.fn();
    const onSubmitPrompt = vi.fn(() => true);
    renderApp({
      onQuit,
      onInterrupt,
      onSubmitPrompt,
      onTranscriptEvent: vi.fn(),
    });
    await settle();
    await act(async () => {
      (mocks.state.inputProps?.['onToggleShellMode'] as () => void)();
    });

    await submit('sleep 10');
    // While the command runs, a second submission must queue behind it
    // instead of starting a concurrent model turn or a racing shell.
    await submit('hello');
    expect(screen.getByText(/Queued hello/)).toBeTruthy();
    expect(onSubmitPrompt).not.toHaveBeenCalled();
    expect(signals).toHaveLength(1);

    await submit('/quit');
    expect(onQuit).toHaveBeenCalledWith([]);
    // Nothing survives the exit: the queued command is discarded and the
    // running one's controller is aborted (a single-slot ref keeps only the
    // newest and orphans the first).
    expect(mocks.state.handledTexts).toEqual(['sleep 10', '/quit']);
    expect(signals[0]?.aborted).toBe(true);
  });

  it('routes a prompt held behind a running shell command to the turn seam (R5-5)', async () => {
    let releaseShell: () => void = () => {};
    const shellDone = new Promise<void>((resolve) => {
      releaseShell = resolve;
    });
    mocks.state.executeUserShell.mockImplementation(() => shellDone);
    mocks.state.handleResult = false as unknown as OpenTuiDispatchOutcome;
    const onTranscriptEvent = vi.fn();
    const onSubmitPrompt = vi.fn(() => true);
    renderApp({ onSubmitPrompt, onTranscriptEvent });
    await settle();
    await act(async () => {
      (mocks.state.inputProps?.['onToggleShellMode'] as () => void)();
    });

    await submit('sleep 10');
    // Shell mode was toggled off while the command still runs (the Esc path):
    // the plain prompt must not start a turn behind the `!` command, whose
    // completion injects LLM history between sends — a concurrent turn turns
    // that write into a mid-turn addHistory (R5-5).
    await act(async () => {
      (mocks.state.inputProps?.['onToggleShellMode'] as () => void)();
    });
    await submit('hello');
    expect(screen.getByText(/Queued hello/)).toBeTruthy();
    expect(onSubmitPrompt).not.toHaveBeenCalled();

    await act(async () => {
      releaseShell();
      await shellDone;
    });
    expect(onSubmitPrompt).toHaveBeenCalledWith(
      'hello',
      undefined,
      expect.objectContaining({
        submittedPrompt: 'hello',
        displayText: 'hello',
        humanInput: { text: 'hello' },
      }),
    );
  });

  it('carries a held prompt image attachments through the drain (R5-5 fix-induced)', async () => {
    let releaseShell: () => void = () => {};
    const shellDone = new Promise<void>((resolve) => {
      releaseShell = resolve;
    });
    mocks.state.executeUserShell.mockImplementation(() => shellDone);
    mocks.state.handleResult = false as unknown as OpenTuiDispatchOutcome;
    const onTranscriptEvent = vi.fn();
    const onSubmitPrompt = vi.fn(() => true);
    renderApp({ onSubmitPrompt, onTranscriptEvent });
    await settle();
    await act(async () => {
      (mocks.state.inputProps?.['onToggleShellMode'] as () => void)();
    });

    await submit('sleep 10');
    await act(async () => {
      (mocks.state.inputProps?.['onToggleShellMode'] as () => void)();
    });
    const restoredDraft = {
      modelText: 'original expanded model copy',
      displayText: 'explain this',
      submittedPrompt: 'explain this',
      humanInput: { text: 'explain this' },
      hasUnknownInput: false,
    };
    await submit('explain this', ['/tmp/screenshot.png'], {
      displayText: 'explain this',
      humanInput: { text: 'explain this' },
      restoredDraft,
    });
    expect(screen.getByText(/Queued explain this/)).toBeTruthy();
    expect(onSubmitPrompt).not.toHaveBeenCalled();

    await act(async () => {
      releaseShell();
      await shellDone;
    });
    expect(onSubmitPrompt).toHaveBeenCalledWith(
      'explain this',
      ['/tmp/screenshot.png'],
      expect.objectContaining({
        submittedPrompt: 'explain this',
        displayText: 'explain this',
        humanInput: { text: 'explain this' },
        restoredDraft,
      }),
    );
  });

  it('re-checks the gate between drain entries so a mid-drain dialog holds the remainder (R6-4)', async () => {
    let releaseShell: () => void = () => {};
    const shellDone = new Promise<void>((resolve) => {
      releaseShell = resolve;
    });
    mocks.state.executeUserShell.mockImplementation(() => shellDone);
    // `/theme` models a canRunDuringStreaming command: admitted during the
    // shell entry's await window, everything else defers behind the turn.
    mocks.state.deferGate = (text: string) => text !== '/theme';
    mocks.state.handleResults.push({
      kind: 'open_dialog',
      request: { dialog: 'theme' },
    } satisfies OpenTuiDispatchOutcome);
    const props = {
      config: CONFIG,
      settings: SETTINGS,
      logger: null,
      commands: [] as readonly SlashCommand[],
      getSessionStats,
      streaming: true,
      onTranscriptEvent: vi.fn(),
    };
    const view = render(<OpenTuiApp {...props} />);
    await settle();
    await act(async () => {
      (mocks.state.inputProps?.['onToggleShellMode'] as () => void)();
    });

    await submit('make');
    await submit('/chat save ckpt');
    expect(mocks.state.handledTexts).toEqual([]);

    await act(async () => {
      view.rerender(<OpenTuiApp {...props} streaming={false} />);
      await Promise.resolve();
    });
    // The drain started and is parked on the shell entry's await window; the
    // mid-drain `/theme` is admitted straight through the gate and opens the
    // dialog.
    await submit('/theme');
    expect(mocks.state.handledTexts).toEqual(['/theme']);
    expect(screen.getByText('dialog:theme')).toBeTruthy();

    await act(async () => {
      releaseShell();
      await shellDone;
      await Promise.resolve();
    });
    // The second entry must not dispatch behind the dialog the drain's own
    // entry gate would refuse.
    expect(mocks.state.handledTexts).toEqual(['/theme']);

    await act(async () => {
      (mocks.state.dialogProps?.['onClose'] as () => void)();
      await Promise.resolve();
    });
    expect(mocks.state.handledTexts).toEqual(['/theme', '/chat save ckpt']);
  });

  it('runs a command queued during a drain after the drain, not beside it (R5-6)', async () => {
    // A third submission queued while the drain runs must wait for the busy
    // slot instead of a second drain instance racing the first (R5-6): the
    // loser would be dropped with the gateway's busy rejection.
    let releaseShell: () => void = () => {};
    const shellDone = new Promise<void>((resolve) => {
      releaseShell = resolve;
    });
    mocks.state.holdHandleOn = '/review';
    mocks.state.deferDuringStreaming = true;
    mocks.state.executeUserShell.mockImplementation(() => shellDone);
    const props = {
      config: CONFIG,
      settings: SETTINGS,
      logger: null,
      commands: [] as readonly SlashCommand[],
      getSessionStats,
      streaming: true,
      onTranscriptEvent: vi.fn(),
    };
    const view = render(<OpenTuiApp {...props} />);
    await settle();
    await act(async () => {
      (mocks.state.inputProps?.['onToggleShellMode'] as () => void)();
    });

    await submit('make');
    await submit('/review');
    expect(mocks.state.handledTexts).toEqual([]);

    await act(async () => {
      view.rerender(<OpenTuiApp {...props} streaming={false} />);
      await Promise.resolve();
    });
    // The drain started: `make` runs on the shell lane while /review waits
    // behind it in the same drain.
    expect(mocks.state.executeUserShell).toHaveBeenCalledTimes(1);

    await submit('/status');

    await act(async () => {
      releaseShell();
      await shellDone;
      // The revision bump from the release re-arms the drain while the busy
      // slot is still held for /review.
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    // /review's dispatch holds the busy slot (the mock took the hold), so
    // nothing has run to completion yet.
    expect(mocks.state.releaseHandle).not.toBeNull();
    expect(mocks.state.handledTexts).toEqual([]);

    await act(async () => {
      mocks.state.releaseHandle?.();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(mocks.state.handledTexts).toEqual(['/review', '/status']);
    expect(screen.queryByText(/already running/)).toBeNull();
  });

  it('reports an executeUserShell rejection and releases the shell gate (R5-7)', async () => {
    const onTranscriptEvent = vi.fn();
    mocks.state.handleResult = false as unknown as OpenTuiDispatchOutcome;
    renderApp({ onTranscriptEvent });
    await settle();
    mocks.state.executeUserShell.mockImplementation(() =>
      Promise.reject(new Error('spawn failed')),
    );
    await act(async () => {
      (mocks.state.inputProps?.['onToggleShellMode'] as () => void)();
    });

    await submit('boom');
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    const errorEvent = onTranscriptEvent.mock.calls
      .map((call) => call[0] as { type: string; text: string })
      .find((event) => event.type === 'error');
    expect(errorEvent?.text).toContain('spawn failed');

    // The controller left the gate set: a later command still runs instead of
    // queueing behind a lane wedged for the rest of the session.
    const second = vi.fn(() => Promise.resolve());
    mocks.state.executeUserShell.mockImplementation(second);
    await submit('echo ok');
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(second).toHaveBeenCalledTimes(1);
    expect(screen.queryByText(/Queued echo ok/)).toBeNull();
  });

  it('sends shell-mode slash input to the init error when the stack failed (R5-8)', async () => {
    mocks.state.loadRejects = true;
    const onQuit = vi.fn();
    const props = {
      config: CONFIG,
      settings: SETTINGS,
      logger: null,
      commands: undefined as unknown as readonly SlashCommand[],
      getSessionStats,
      streaming: true,
      onQuit,
      onTranscriptEvent: vi.fn(),
    };
    const view = render(<OpenTuiApp {...props} />);
    await settle();
    await act(async () => {
      (mocks.state.inputProps?.['onToggleShellMode'] as () => void)();
    });

    await submit('/quit');
    // No dispatcher exists to tag the submission, so the shell lane must not
    // claim it: the recorded init-error rejection is the truthful answer
    // (R5-8), not a bash execution of `/quit`.
    expect(screen.getByText(/failed to initialize/)).toBeTruthy();
    expect(screen.queryByText(/Queued/)).toBeNull();

    await act(async () => {
      view.rerender(<OpenTuiApp {...props} streaming={false} />);
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(mocks.state.executeUserShell).not.toHaveBeenCalled();
    expect(onQuit).not.toHaveBeenCalled();
  });

  it('stops the turn and exits on a mid-turn quit instead of queueing it', async () => {
    const onQuit = vi.fn();
    const onInterrupt = vi.fn();
    // The dispatcher exempts the quit family from the mid-turn gate, so the
    // shell has to reach the exit while the turn is still responding.
    renderApp({ streaming: true, onQuit, onInterrupt });
    await settle();
    mocks.state.handleResult = {
      kind: 'quit',
      messages: [],
    } satisfies OpenTuiDispatchOutcome;

    await submit('/quit');
    expect(mocks.state.handledTexts).toEqual(['/quit']);
    expect(screen.queryByText(/Queued/)).toBeNull();
    expect(onQuit).toHaveBeenCalledWith([]);
    // Cancel before exiting: the drain must not race a stream still writing.
    expect(onInterrupt.mock.invocationCallOrder[0]).toBeLessThan(
      onQuit.mock.invocationCallOrder[0],
    );
  });

  it('normalizes bare quit tokens ahead of the mid-turn gate and the dispatch', async () => {
    // ink normalizes the whole quit family where its handleFinalSubmit puts the
    // check — before the queue — so an `exit` typed mid-response stops the stream
    // instead of queueing behind it or reaching the model as text. The text the
    // gate is asked about is the ordering witness: `/quit`, never `exit`.
    const gateSeen: string[] = [];
    mocks.state.deferGate = (text) => {
      gateSeen.push(text);
      const command = text.trim();
      return command.startsWith('/') && command !== '/quit';
    };
    const onQuit = vi.fn();
    const onSubmitPrompt = vi.fn(() => true);
    renderApp({ streaming: true, onQuit, onSubmitPrompt });
    await settle();
    mocks.state.handleResult = {
      kind: 'quit',
      messages: [],
    } satisfies OpenTuiDispatchOutcome;

    const tokens = ['exit', 'quit', ':q', ':q!', ':wq', ':wq!'];
    for (const token of tokens) await submit(token);

    expect(gateSeen).toEqual(tokens.map(() => '/quit'));
    expect(mocks.state.handledTexts).toEqual(tokens.map(() => '/quit'));
    expect(onQuit).toHaveBeenCalledTimes(tokens.length);
    expect(onSubmitPrompt).not.toHaveBeenCalled();
    expect(screen.queryByText(/Queued/)).toBeNull();
  });

  it('drains a held command whose defer verdict lands after the idle edge', async () => {
    // The gate awaits the command registry, so its verdict can land after the
    // turn it was asked about has already ended (R1-1).
    const gate: { release: (defer: boolean) => void } = {
      release: () => {
        throw new Error('the mid-turn gate never asked for a verdict');
      },
    };
    mocks.state.deferGate = () =>
      new Promise<boolean>((resolve) => {
        gate.release = resolve;
      });
    const props = {
      config: CONFIG,
      settings: SETTINGS,
      logger: null,
      commands: [] as readonly SlashCommand[],
      getSessionStats,
      streaming: true,
    };
    const view = render(<OpenTuiApp {...props} />);
    await settle();

    const onSubmit = mocks.state.inputProps?.['onSubmit'] as (
      t: string,
    ) => void;
    await act(async () => {
      onSubmit('/compress');
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(mocks.state.handledTexts).toEqual([]);

    // The turn ends while the verdict is still outstanding.
    await act(async () => {
      view.rerender(<OpenTuiApp {...props} streaming={false} />);
      await Promise.resolve();
    });
    expect(mocks.state.handledTexts).toEqual([]);

    // The verdict queues the command onto an already-idle session; it must run
    // without waiting for another streaming transition. The macrotask flush
    // lets the resumed submission's queue push re-render and re-run the drain.
    await act(async () => {
      gate.release(true);
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(mocks.state.handledTexts).toEqual(['/compress']);
  });

  it('replays held commands in submission order, pausing behind a submit_prompt', async () => {
    const onSubmitPrompt = vi.fn(() => true);
    mocks.state.deferDuringStreaming = true;
    mocks.state.handleResults = [
      { kind: 'submit_prompt', content: 'generated' },
      { kind: 'handled' },
    ] satisfies OpenTuiDispatchOutcome[];
    const props = {
      config: CONFIG,
      settings: SETTINGS,
      logger: null,
      commands: [] as readonly SlashCommand[],
      getSessionStats,
      streaming: true,
      onSubmitPrompt,
    };
    const view = render(<OpenTuiApp {...props} />);
    await settle();

    await submit('/first');
    await submit('/second');
    expect(mocks.state.handledTexts).toEqual([]);

    await act(async () => {
      view.rerender(<OpenTuiApp {...props} streaming={false} />);
      await Promise.resolve();
    });
    expect(mocks.state.handledTexts).toEqual(['/first']);
    expect(onSubmitPrompt).toHaveBeenCalledTimes(1);

    // The first outcome started a turn, so the command behind it waits for
    // that turn rather than racing the stream it just opened (R1-5).
    await act(async () => {
      view.rerender(<OpenTuiApp {...props} streaming={true} />);
      await Promise.resolve();
    });
    expect(mocks.state.handledTexts).toEqual(['/first']);

    await act(async () => {
      view.rerender(<OpenTuiApp {...props} streaming={false} />);
      await Promise.resolve();
    });
    expect(mocks.state.handledTexts).toEqual(['/first', '/second']);
    expect(onSubmitPrompt).toHaveBeenCalledTimes(1);
  });

  it('holds the queue behind a dialog the drain opened, resuming on close', async () => {
    mocks.state.deferDuringStreaming = true;
    mocks.state.handleResults = [
      { kind: 'open_dialog', request: { dialog: 'theme' } },
      { kind: 'open_dialog', request: { dialog: 'resume' } },
    ] satisfies OpenTuiDispatchOutcome[];
    const props = {
      config: CONFIG,
      settings: SETTINGS,
      logger: null,
      commands: [] as readonly SlashCommand[],
      getSessionStats,
      streaming: true,
    };
    const view = render(<OpenTuiApp {...props} />);
    await settle();

    await submit('/theme');
    await submit('/resume');
    expect(mocks.state.handledTexts).toEqual([]);

    await act(async () => {
      view.rerender(<OpenTuiApp {...props} streaming={false} />);
      await Promise.resolve();
    });
    // The first dialog owns the UI; the second must not overwrite it (R1-7).
    expect(mocks.state.handledTexts).toEqual(['/theme']);
    expect(screen.getByText('dialog:theme')).toBeTruthy();
    expect(screen.queryByText('dialog:resume')).toBeNull();

    const onClose = mocks.state.dialogProps?.['onClose'] as () => void;
    await act(async () => {
      onClose();
      await Promise.resolve();
    });
    expect(mocks.state.handledTexts).toEqual(['/theme', '/resume']);
    expect(screen.getByText('dialog:resume')).toBeTruthy();
  });

  it('does not replay a held command over a dialog the user is in', async () => {
    // `/settings` opts into mid-turn streaming, so its dialog opens while the
    // turn still streams; the held `/model` must wait for it to close (R1-12).
    mocks.state.deferGate = (text) => text === '/model';
    mocks.state.handleResults = [
      { kind: 'open_dialog', request: { dialog: 'settings' } },
      { kind: 'handled' },
    ] satisfies OpenTuiDispatchOutcome[];
    const props = {
      config: CONFIG,
      settings: SETTINGS,
      logger: null,
      commands: [] as readonly SlashCommand[],
      getSessionStats,
      streaming: true,
    };
    const view = render(<OpenTuiApp {...props} />);
    await settle();

    await submit('/model');
    expect(mocks.state.handledTexts).toEqual([]);
    // The composer unmounts once a dialog opens, so this is the reachable
    // order: held first, dialog second.
    await submit('/settings');
    expect(mocks.state.handledTexts).toEqual(['/settings']);
    expect(screen.getByText('dialog:settings')).toBeTruthy();

    await act(async () => {
      view.rerender(<OpenTuiApp {...props} streaming={false} />);
      await Promise.resolve();
    });
    expect(mocks.state.handledTexts).toEqual(['/settings']);
    expect(screen.getByText('dialog:settings')).toBeTruthy();

    const onClose = mocks.state.dialogProps?.['onClose'] as () => void;
    await act(async () => {
      onClose();
      await Promise.resolve();
    });
    expect(mocks.state.handledTexts).toEqual(['/settings', '/model']);
  });

  it('drops both mid-turn queues when a quit exits during the turn', async () => {
    const onQuit = vi.fn();
    const onInterrupt = vi.fn();
    const onPopQueue = vi.fn(() => ({ text: 'queued prompt' }));
    mocks.state.deferDuringStreaming = true;
    const props = {
      config: CONFIG,
      settings: SETTINGS,
      logger: null,
      commands: [] as readonly SlashCommand[],
      getSessionStats,
      streaming: true,
      onQuit,
      onInterrupt,
      onPopQueue,
    };
    const view = render(<OpenTuiApp {...props} />);
    await settle();

    await submit('/compress');
    expect(screen.getByText(/Queued \/compress/)).toBeTruthy();

    // Quit is exempt from the gate, so it reaches the exit while streaming.
    mocks.state.deferDuringStreaming = false;
    mocks.state.handleResult = {
      kind: 'quit',
      messages: [],
    } satisfies OpenTuiDispatchOutcome;
    await submit('/quit');
    expect(onQuit).toHaveBeenCalledWith([]);

    // The interrupt ends the turn, which is the idle edge that wakes the drain:
    // the held command must not replay into the exit cleanup (R1-8), and the
    // steering queue must not be promoted into a fresh turn by the same abort
    // (R1-10) — so it is discarded before the interrupt fires.
    await act(async () => {
      view.rerender(<OpenTuiApp {...props} streaming={false} />);
      await Promise.resolve();
    });
    expect(mocks.state.handledTexts).toEqual(['/quit']);
    expect(onPopQueue.mock.invocationCallOrder[0]).toBeLessThan(
      onInterrupt.mock.invocationCallOrder[0],
    );
  });

  it('does not replay held commands once an exit drain is in flight', async () => {
    // The Ctrl+C/Ctrl+D double press and render-error exits never pass through
    // this shell's quit branch, so they cannot clear the ref at the source —
    // the drain itself must consult the shared exit latch (R2-1).
    mocks.state.deferDuringStreaming = true;
    const props = {
      config: CONFIG,
      settings: SETTINGS,
      logger: null,
      commands: [] as readonly SlashCommand[],
      getSessionStats,
      streaming: true,
    };
    const view = render(<OpenTuiApp {...props} />);
    await settle();

    await submit('/first');
    await submit('/second');
    expect(mocks.state.handledTexts).toEqual([]);

    // The exit drain starts (exitSession), then the idle edge the drain waits
    // on crosses — the snapshot must not dispatch behind the teardown.
    mocks.state.exitInProgress = true;
    await act(async () => {
      view.rerender(<OpenTuiApp {...props} streaming={false} />);
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(mocks.state.handledTexts).toEqual([]);
  });

  it('stops between dispatches when the exit starts while one is in flight', async () => {
    // The crossing the edge check cannot see: the drain is already past it,
    // and the exit begins while '/first' awaits its outcome. Only the in-loop
    // latch check keeps '/second' back (R4-1).
    mocks.state.deferDuringStreaming = true;
    const props = {
      config: CONFIG,
      settings: SETTINGS,
      logger: null,
      commands: [] as readonly SlashCommand[],
      getSessionStats,
      streaming: true,
    };
    const view = render(<OpenTuiApp {...props} />);
    await settle();

    await submit('/first');
    await submit('/second');
    expect(mocks.state.handledTexts).toEqual([]);

    mocks.state.onHandle = () => {
      mocks.state.exitInProgress = true;
    };
    await act(async () => {
      view.rerender(<OpenTuiApp {...props} streaming={false} />);
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
    expect(mocks.state.handledTexts).toEqual(['/first']);
  });

  it('catches a subtree render error inside the error boundary', async () => {
    const boom = vi.spyOn(console, 'error').mockImplementation(() => {});
    const ThrowingView = () => {
      throw new Error('transcript blew up');
    };
    renderApp({ renderMain: () => <ThrowingView /> });
    await settle();
    expect(
      screen.getByText('Something went wrong while rendering.'),
    ).toBeTruthy();
    boom.mockRestore();
  });
});

describe('OpenTuiApp approval-mode cycling (F-2)', () => {
  beforeEach(() => {
    mocks.state.handleResult = { kind: 'handled' };
    mocks.state.handleResults.length = 0;
    mocks.state.handledTexts.length = 0;
    mocks.state.host = null;
    mocks.state.hosts.length = 0;
    mocks.state.dispatcherConstructions = 0;
    mocks.state.inputProps = null;
    mocks.state.dialogProps = null;
    mocks.state.footerProps = null;
    mocks.state.exitInProgress = false;
    mocks.state.emitAutoModeEntryNotices.mockClear();
    mocks.state.mcpApprovalProps = null;
    mocks.state.mcpQueue.length = 0;
    mocks.state.handleMcpApprovalSelect.mockClear();
  });

  function fakeConfig(
    initial: ApprovalMode,
    options: { refuse?: boolean } = {},
  ) {
    let mode = initial;
    const writes: ApprovalMode[] = [];
    const config = {
      ...CONFIG,
      getApprovalMode: () => mode,
      setApprovalMode(next: ApprovalMode) {
        if (options.refuse) throw new Error('approval mode is pinned');
        writes.push(next);
        mode = next;
      },
    } as unknown as Config;
    return { config, writes };
  }

  /** The Windows bare-Tab fallback is the one cycle route the composer keeps. */
  async function cycleOnce() {
    const cycle = mocks.state.inputProps?.['onCycleApprovalMode'] as
      | (() => void)
      | undefined;
    if (typeof cycle !== 'function') {
      throw new Error('composer was not given a cycle handler');
    }
    await act(async () => {
      cycle();
    });
  }

  /** Drives the shell's own useKeyboard registration; the mock pushes a fresh
   * handler per render, so only the last one is the live subscription. */
  async function pressKey(key: Record<string, unknown>) {
    const handler = mocks.state.keyboardHandlers.at(-1);
    if (!handler) {
      throw new Error('shell registered no keyboard handler');
    }
    const event = { preventDefault: vi.fn(), ...key };
    await act(async () => {
      handler(event);
    });
    return event;
  }

  const pressShiftTab = () =>
    pressKey({ name: 'tab', shift: true, sequence: '\x1b[Z' });

  it('cycles the mode on Shift+Tab', async () => {
    const { config, writes } = fakeConfig(ApprovalMode.DEFAULT);
    renderApp({ config, approvalMode: ApprovalMode.DEFAULT });
    await settle();
    await pressShiftTab();
    expect(writes).toEqual([ApprovalMode.AUTO_EDIT]);
  });

  it('leaves a bare Tab to the composer', async () => {
    const { config, writes } = fakeConfig(ApprovalMode.DEFAULT);
    renderApp({ config, approvalMode: ApprovalMode.DEFAULT });
    await settle();
    await pressKey({ name: 'tab', sequence: '\t' });
    expect(writes).toEqual([]);
  });

  it('still cycles while a dialog has the composer unmounted', async () => {
    // ink keeps useAutoAcceptIndicator mounted at App level, so Shift+Tab cycles
    // through /help too. The composer owning the keystroke dropped it: the
    // ternary unmounts the composer whenever a dialog is open.
    const { config, writes } = fakeConfig(ApprovalMode.YOLO);
    renderApp({ config, approvalMode: ApprovalMode.YOLO });
    await settle();
    mocks.state.handleResult = {
      kind: 'open_dialog',
      request: { dialog: 'help' },
    } satisfies OpenTuiDispatchOutcome;
    await submit('/help');
    expect(screen.getByText('dialog:help')).toBeTruthy();
    expect(screen.queryByText('input-prompt')).toBeNull();

    await pressShiftTab();
    // YOLO is the last entry of core's APPROVAL_MODES, so it wraps to PLAN.
    expect(writes).toEqual([ApprovalMode.PLAN]);
  });

  it('releases a parked call when the cycle reaches YOLO', async () => {
    // ink pairs the mode switch with confirming whatever is already parked.
    // Which calls qualify is selectAutoApprovals' rule, covered in
    // live-session.test.ts; this pins the wiring, which had no caller.
    const onToolCallSettled = vi.fn();
    const onConfirm = vi.fn().mockResolvedValue(undefined);
    const { config } = fakeConfig(ApprovalMode.AUTO_EDIT);
    renderApp({
      config,
      approvalMode: ApprovalMode.AUTO_EDIT,
      waitingToolCalls: [
        {
          callId: 'call-1',
          name: 'run_shell_command',
          confirmationDetails: { type: 'info', title: 'ok?', onConfirm },
        } as never,
      ],
      onToolCallSettled,
    });
    await settle();
    // AUTO_EDIT → AUTO releases nothing: ink's rule names only AUTO_EDIT and
    // YOLO, and a shell call is not an edit either way.
    await pressShiftTab();
    expect(onConfirm).not.toHaveBeenCalled();
    expect(onToolCallSettled).not.toHaveBeenCalled();
    // AUTO → YOLO does.
    await pressShiftTab();
    expect(onConfirm).toHaveBeenCalledWith(ToolConfirmationOutcome.ProceedOnce);
    expect(onToolCallSettled).toHaveBeenCalledWith('call-1');
  });

  it('writes the next mode and repaints both chrome rows', async () => {
    const { config, writes } = fakeConfig(ApprovalMode.DEFAULT);
    renderApp({ config, approvalMode: ApprovalMode.DEFAULT });
    await settle();
    await cycleOnce();
    expect(writes).toEqual([ApprovalMode.AUTO_EDIT]);
    // The shell holds the mode locally, so the cycle repaints without waiting
    // for the entry to re-render with a fresh `approvalMode` prop.
    expect(mocks.state.inputProps?.['approvalMode']).toBe(
      ApprovalMode.AUTO_EDIT,
    );
    expect(mocks.state.footerProps?.['approvalMode']).toBe(
      ApprovalMode.AUTO_EDIT,
    );
  });

  it('explains entering AUTO the way ink does', async () => {
    const { config } = fakeConfig(ApprovalMode.AUTO_EDIT);
    renderApp({ config, approvalMode: ApprovalMode.AUTO_EDIT });
    await settle();
    await cycleOnce();
    expect(mocks.state.emitAutoModeEntryNotices).toHaveBeenCalledTimes(1);
  });

  it('stays quiet when the cycle does not enter AUTO', async () => {
    const { config } = fakeConfig(ApprovalMode.DEFAULT);
    renderApp({ config, approvalMode: ApprovalMode.DEFAULT });
    await settle();
    await cycleOnce();
    expect(mocks.state.emitAutoModeEntryNotices).not.toHaveBeenCalled();
  });

  it('announces a session that starts already in AUTO', async () => {
    const { config } = fakeConfig(ApprovalMode.AUTO);
    renderApp({ config, approvalMode: ApprovalMode.AUTO });
    await settle();
    // No keystroke: --approval-mode auto and tools.approvalMode both land here
    // before any handler could run.
    expect(mocks.state.emitAutoModeEntryNotices).toHaveBeenCalledTimes(1);
  });

  it('does not announce on mount when the session starts outside AUTO', async () => {
    const { config } = fakeConfig(ApprovalMode.DEFAULT);
    renderApp({ config, approvalMode: ApprovalMode.DEFAULT });
    await settle();
    expect(mocks.state.emitAutoModeEntryNotices).not.toHaveBeenCalled();
  });

  it('reports a refused change instead of repainting a mode it does not hold', async () => {
    const { config, writes } = fakeConfig(ApprovalMode.DEFAULT, {
      refuse: true,
    });
    const events: unknown[] = [];
    renderApp({
      config,
      approvalMode: ApprovalMode.DEFAULT,
      onTranscriptEvent: (event) => {
        events.push(event);
      },
    });
    await settle();
    await cycleOnce();
    expect(writes).toEqual([]);
    expect(mocks.state.footerProps?.['approvalMode']).toBe(
      ApprovalMode.DEFAULT,
    );
    expect(events).toContainEqual({
      type: 'info',
      text: 'approval mode is pinned',
    });
  });

  it('takes the dialog’s choice into the same state the composer cycles', async () => {
    const { config } = fakeConfig(ApprovalMode.DEFAULT);
    renderApp({ config, approvalMode: ApprovalMode.DEFAULT });
    await settle();
    mocks.state.handleResult = {
      kind: 'open_dialog',
      request: { dialog: 'approval-mode' },
    } satisfies OpenTuiDispatchOutcome;
    await submit('/approval-mode');

    const onChanged = mocks.state.dialogProps?.['onApprovalModeChanged'] as
      | ((mode: ApprovalMode) => void)
      | undefined;
    if (typeof onChanged !== 'function') {
      throw new Error('dialog mount was not given onApprovalModeChanged');
    }
    await act(async () => {
      onChanged(ApprovalMode.YOLO);
    });
    // The footer is unmounted while a dialog is open, so close it first: the
    // staleness this guards against is the chrome the user sees afterwards.
    await act(async () => {
      (mocks.state.dialogProps?.['onClose'] as () => void)();
    });
    expect(mocks.state.footerProps?.['approvalMode']).toBe(ApprovalMode.YOLO);
    expect(mocks.state.inputProps?.['approvalMode']).toBe(ApprovalMode.YOLO);
  });

  it('does not re-announce when the dialog re-picks the AUTO it already holds', async () => {
    const { config } = fakeConfig(ApprovalMode.AUTO);
    renderApp({ config, approvalMode: ApprovalMode.AUTO });
    await settle();
    expect(mocks.state.emitAutoModeEntryNotices).toHaveBeenCalledTimes(1);

    mocks.state.handleResult = {
      kind: 'open_dialog',
      request: { dialog: 'approval-mode' },
    } satisfies OpenTuiDispatchOutcome;
    await submit('/approval-mode');

    const onChanged = mocks.state.dialogProps?.['onApprovalModeChanged'] as
      | ((mode: ApprovalMode) => void)
      | undefined;
    if (typeof onChanged !== 'function') {
      throw new Error('dialog mount was not given onApprovalModeChanged');
    }
    // The dialog opens with the mode it already holds selected, so a bare Enter
    // re-picks AUTO. The stripped-rules notice is not idempotent, and ink
    // guards both of its routes against reprinting it.
    await act(async () => {
      onChanged(ApprovalMode.AUTO);
    });
    expect(mocks.state.emitAutoModeEntryNotices).toHaveBeenCalledTimes(1);
  });
});

describe('OpenTuiApp transcript scroll region', () => {
  beforeEach(() => {
    mocks.state.handleResult = { kind: 'handled' };
    mocks.state.handleResults.length = 0;
    mocks.state.handledTexts.length = 0;
    mocks.state.host = null;
    mocks.state.hosts.length = 0;
    mocks.state.dispatcherConstructions = 0;
    mocks.state.inputProps = null;
    mocks.state.dialogProps = null;
    mocks.state.footerProps = null;
    mocks.state.exitInProgress = false;
    mocks.state.emitAutoModeEntryNotices.mockClear();
    mocks.state.mcpApprovalProps = null;
    mocks.state.mcpQueue.length = 0;
    mocks.state.handleMcpApprovalSelect.mockClear();
  });

  const layoutOf = (
    node: Element | null | undefined,
  ): Record<string, unknown> =>
    JSON.parse(node?.getAttribute('data-p') ?? '{}') as Record<string, unknown>;

  const readLayout = () => {
    const region = document.querySelector('scrollbox');
    const column = region?.parentElement;
    return { region, column, chrome: column?.lastElementChild };
  };

  const renderWithTranscript = async () => {
    renderApp({
      renderMain: () => <div data-testid="transcript">TRANSCRIPT-ROWS</div>,
    });
    await settle();
  };

  it('bounds the app column by the terminal and anchors the transcript region to its tail', async () => {
    // ink needs no viewport maths: Static writes to the terminal's own
    // scrollback, so the dynamic area always sits at the bottom row. Alt-screen
    // OpenTUI has to say the same thing in layout. Without the bounded column a
    // conversation longer than the terminal pushed the composer, the waiting row
    // and the footer past the last row, where nothing repaints them.
    await renderWithTranscript();
    const { region, column, chrome } = readLayout();
    expect(region).not.toBeNull();
    expect(layoutOf(column)).toMatchObject({ height: 40 });
    expect(layoutOf(region)).toMatchObject({
      flexGrow: 1,
      flexShrink: 1,
      minHeight: 0,
      stickyScroll: true,
      stickyStart: 'bottom',
    });
    // The split is the fix: the conversation scrolls, the chrome does not.
    expect(region?.textContent).toContain('TRANSCRIPT-ROWS');
    expect(chrome?.textContent).toContain('input-prompt');
    // And the chrome has to hold its own rows. Measured with the shrink unlocked,
    // the scroll region took the composer's border rows and painted all three of
    // them over one terminal row.
    expect(layoutOf(chrome)).toMatchObject({ flexShrink: 0 });
  });

  it('keeps the transcript region out of the focus chain', async () => {
    // A ScrollBox is focusable by default and the renderer auto-focuses the
    // first focusable ancestor under a left mouse-down, so one click on the
    // conversation moved the focus off the composer's editor for the rest of
    // the session: the caret stopped moving and pastes stopped landing there.
    await renderWithTranscript();
    const { region } = readLayout();
    expect(layoutOf(region)).toMatchObject({ focusable: false });
  });

  it('keeps the dialog out of the scroll region', async () => {
    await renderWithTranscript();
    mocks.state.handleResult = {
      kind: 'open_dialog',
      request: { dialog: 'theme' },
    } satisfies OpenTuiDispatchOutcome;
    await submit('/theme');
    const { region, chrome } = readLayout();
    expect(screen.getByText('dialog:theme')).toBeTruthy();
    expect(region?.textContent).not.toContain('dialog:theme');
    expect(chrome?.textContent).toContain('dialog:theme');
  });

  it("gives the dialog region ink's fixed, clipped row budget", async () => {
    // ink renders every popup inside a region of exactly
    // `rows - STATIC_EXTRA_HEIGHT(3) - MAIN_CONTENT_HEIGHT_RESERVATION(2)`
    // rows, clipped and top-aligned, with the composer swapped out. A
    // content-height region bottom-anchors the popup instead: a dialog ink
    // stretches to fill the viewport stayed short, and a picker taller than
    // the region pushed the composer off screen. The expectation is derived
    // from the shared constant rather than written as a literal, so the two
    // renderers' budgets cannot drift apart with the suite green.
    const regionHeight = getDialogMaxHeight(40, STATIC_EXTRA_HEIGHT);
    await renderWithTranscript();
    mocks.state.handleResult = {
      kind: 'open_dialog',
      request: { dialog: 'theme' },
    } satisfies OpenTuiDispatchOutcome;
    await submit('/theme');
    // The mount stub returns a bare string, so its parent is the region box.
    expect(layoutOf(screen.getByText('dialog:theme'))).toMatchObject({
      flexDirection: 'column',
      height: regionHeight,
      overflow: 'hidden',
    });
    // The same budget has to reach the dialogs: a list that sized itself to the
    // full terminal would push its footer hint out of the clipped region.
    expect(mocks.state.dialogProps?.['availableTerminalHeight']).toBe(
      regionHeight,
    );
  });

  it('shows queued prompts in the chrome, above the composer itself', async () => {
    // ink prints them inside the Composer column, so they must share the
    // non-scrolling rows rather than scroll away with the conversation.
    renderApp({
      renderMain: () => <div data-testid="transcript">TRANSCRIPT-ROWS</div>,
      messageQueue: ['QUEUE_ROW_MARKER'],
    });
    await settle();
    const { region, chrome } = readLayout();
    const chromeText = chrome?.textContent ?? '';
    expect(chromeText).toContain('QUEUE_ROW_MARKER');
    expect(chromeText).toContain('input-prompt');
    // The title says "above", so order it and not just contain it: text runs in
    // document order, so the queue row's offset is its placement.
    expect(chromeText.indexOf('QUEUE_ROW_MARKER')).toBeLessThan(
      chromeText.indexOf('input-prompt'),
    );
    expect(region?.textContent).not.toContain('QUEUE_ROW_MARKER');
  });
});
