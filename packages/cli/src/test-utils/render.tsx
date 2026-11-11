/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  render as inkRenderDirect,
  type Instance as InkInstance,
  type RenderOptions,
} from 'ink';

import { EventEmitter } from 'node:events';
import {
  flushResizeObserversSync,
  triggerResizeObservers,
} from '../ink/compat/ResizeObserver.js';
import { Box } from 'ink';
import { Terminal } from '@xterm/headless';
import { vi } from 'vitest';
import stripAnsi from 'strip-ansi';
import type React from 'react';
import { act, useState } from 'react';
import type { LoadedSettings } from '../config/settings.js';
import { KeypressProvider } from '../ui/contexts/KeypressContext.js';
import {
  KeyboardContextProvider,
  useRegisterKeyboardContext,
} from '../ui/contexts/KeyboardContextRegistry.js';
import type { ActionHandlerRegistryImpl } from '../ui/contexts/ActionHandlerRegistry.js';
import {
  ActionHandlerRegistryProvider,
  useActionHandlerRegistry,
} from '../ui/contexts/ActionHandlerRegistry.js';
import { useContextRouting } from '../ui/hooks/useContextRouting.js';
import { SettingsContext } from '../ui/contexts/SettingsContext.js';
import { I18nTestProvider } from './I18nTestProvider.js';
import type { I18nService } from '@qwen-code/core';
import { UIStateContext, type UIState } from '../ui/contexts/UIStateContext.js';
import {
  PendingHistoryContext,
  type PendingHistoryValue,
} from '../ui/contexts/PendingHistoryContext.js';
import { ConfigContext } from '../ui/contexts/ConfigContext.js';
import { VimModeProvider } from '../ui/contexts/VimModeContext.js';
import { MouseProvider } from '../ui/contexts/MouseContext.js';
import { ScrollProvider } from '../ui/contexts/ScrollProvider.js';
import { StreamingContext } from '../ui/contexts/StreamingContext.js';
import {
  type UIActions,
  UIActionsContext,
} from '../ui/contexts/UIActionsContext.js';
import { type HistoryItemToolGroup, StreamingState } from '../ui/types.js';
import { ToolActionsProvider } from '../ui/contexts/ToolActionsContext.js';
import { TerminalProvider } from '../ui/contexts/TerminalContext.js';
import {
  OverflowProvider,
  useOverflowActions,
  useOverflowState,
  type OverflowActions,
  type OverflowState,
} from '../ui/contexts/OverflowContext.js';

import { makeFakeConfig } from '@qwen-code/core';
import { type Config } from '@qwen-code/core';
import { FakePersistentState } from './persistentStateFake.js';
import { FoldStateProvider } from '../ui/contexts/FoldStateContext.js';
import { FoldLevel } from '../ui/constants/messageLayout.js';
import { AppContext, type AppState } from '../ui/contexts/AppContext.js';
import { createMockSettings } from './settings.js';
import { SessionStatsProvider } from '../ui/contexts/SessionContext.js';
import { themeManager, DEFAULT_THEME } from '../ui/themes/theme-manager.js';
import { DefaultLight } from '../ui/themes/builtin/light/default-light.js';
import { pickDefaultThemeName } from '../ui/themes/theme.js';
import { generateSvgForTerminal } from './svg.js';

export const persistentStateMock = new FakePersistentState();

// NOTE: Previously this file overrode NODE_ENV from 'test' to 'development'
// so that animation code (which skips when NODE_ENV === 'test') would run
// in tests. That override is removed because Ink's reconciler uses
// NODE_ENV === 'test' to select the synchronous render path required for
// lastFrame() / waitUntilReady() to work correctly.

vi.mock('../utils/persistentState.js', () => ({
  get persistentState() {
    return persistentStateMock;
  },
}));

vi.mock('../ui/utils/terminalUtils.js', () => ({
  isLowColorDepth: vi.fn(() => false),
  getColorDepth: vi.fn(() => 24),
  isAppleTerminal: vi.fn(() => false),
  isSSH: vi.fn(() => false),
  isUnicodeSupported: vi.fn(() => true),
}));

// Upper bound for waiting on a render that Ink defers with a timer. Must stay
// above Ink's 50ms incomplete-escape flush (see App NORMAL_TIMEOUT).
const DEFERRED_RENDER_WAIT_MS = 100;

type TerminalState = {
  terminal: Terminal;
  cols: number;
  rows: number;
};

type RenderSnapshot = Parameters<NonNullable<RenderOptions['onRender']>>[0];

interface InkRenderSnapshot extends RenderSnapshot {
  output: string;
  staticOutput?: string;
}

function isInkRenderSnapshot(
  stats: RenderSnapshot,
): stats is InkRenderSnapshot {
  const m = stats as Record<string, unknown>;
  return (
    typeof m === 'object' &&
    m !== null &&
    'output' in m &&
    // eslint-disable-next-line eslint-js/no-restricted-syntax
    typeof m['output'] === 'string'
  );
}

class XtermStdout extends EventEmitter {
  private state: TerminalState;
  private pendingWrites = 0;
  private renderCount = 0;
  private queue: { promise: Promise<void> };
  isTTY = true;

  getColorDepth(): number {
    return 24;
  }

  private lastRenderOutput: string | undefined = undefined;
  private lastRenderStaticContent: string | undefined = undefined;

  constructor(state: TerminalState, queue: { promise: Promise<void> }) {
    super();
    this.state = state;
    this.queue = queue;
  }

  get columns() {
    return this.state.terminal.cols;
  }

  get rows() {
    return this.state.terminal.rows;
  }

  get frames(): string[] {
    return [];
  }

  write = (data: string) => {
    this.pendingWrites++;
    this.queue.promise = this.queue.promise.then(async () => {
      await new Promise<void>((resolve) =>
        this.state.terminal.write(data, resolve),
      );
      this.pendingWrites--;
    });
  };

  clear = () => {
    this.state.terminal.reset();
    this.lastRenderOutput = undefined;
    this.lastRenderStaticContent = undefined;
  };

  dispose = () => {
    this.state.terminal.dispose();
  };

  onRender = (staticContent: string, output: string) => {
    this.renderCount++;
    this.lastRenderStaticContent = staticContent;
    this.lastRenderOutput = output;
    this.emit('render');
  };

  private normalizeFrame = (text: string): string =>
    text.replace(/\r\n/g, '\n');

  generateSvg = (): string => generateSvgForTerminal(this.state.terminal);

  lastFrameRaw = (options: { allowEmpty?: boolean } = {}) => {
    // If we have real render output from ink (original ink provides output/staticOutput
    // strings via onRender stats), use it for raw ANSI output.
    // The engine doesn't provide output strings in onFrame, so lastRenderOutput
    // will be '...' (the fallback). In that case, fall back to the xterm buffer.
    if (
      this.lastRenderOutput !== undefined &&
      this.lastRenderOutput !== '...'
    ) {
      const result =
        (this.lastRenderStaticContent ?? '') + this.lastRenderOutput;
      const normalized = this.normalizeFrame(result);
      if (normalized === '' && !options.allowEmpty) {
        throw new Error(
          'lastFrameRaw() returned an empty string. If this is intentional, use lastFrameRaw({ allowEmpty: true }). ' +
            'Otherwise, ensure you are calling await waitUntilReady() and that the component is rendering correctly.',
        );
      }
      return normalized;
    }

    // Engine fallback: read from xterm terminal buffer
    return this.lastFrame(options);
  };

  lastFrame = (options: { allowEmpty?: boolean } = {}) => {
    const buffer = this.state.terminal.buffer.active;
    const allLines: string[] = [];
    // Ignore scrollback rows above the active viewport. Ink may clear and
    // redraw by scrolling a full terminal height.
    for (let i = buffer.baseY; i < buffer.length; i++) {
      allLines.push(buffer.getLine(i)?.translateToString(true) ?? '');
    }

    const trimmed = [...allLines];
    while (trimmed.length > 0 && trimmed[trimmed.length - 1] === '') {
      trimmed.pop();
    }
    const result = trimmed.join('\n');

    const normalized = this.normalizeFrame(result);

    if (normalized === '' && !options.allowEmpty) {
      throw new Error(
        'lastFrame() returned an empty string. If this is intentional, use lastFrame({ allowEmpty: true }). ' +
          'Otherwise, ensure you are calling await waitUntilReady() and that the component is rendering correctly.',
      );
    }
    return normalized === '' ? normalized : normalized + '\n';
  };

  async waitUntilReady() {
    const startRenderCount = this.renderCount;
    if (!vi.isFakeTimers()) {
      // Give Ink a chance to start its rendering loop
      await new Promise((resolve) => setImmediate(resolve));
    }
    await act(async () => {
      if (vi.isFakeTimers()) {
        await vi.advanceTimersByTimeAsync(50);
      } else {
        // Ink renders synchronously under NODE_ENV=test, so a settled
        // component has already painted by now and usually no further
        // 'render' event will arrive. The one deferred render source is
        // Ink's incomplete-escape flush (App NORMAL_TIMEOUT = 50ms, e.g. a
        // lone ESC keypress), so only wait slightly longer than that.
        if (this.renderCount === startRenderCount) {
          const renderPromise = new Promise((resolve) =>
            this.once('render', resolve),
          );
          const timeoutPromise = new Promise((resolve) =>
            setTimeout(resolve, DEFERRED_RENDER_WAIT_MS),
          );
          await Promise.race([renderPromise, timeoutPromise]);
        }
      }
    });

    let attempts = 0;
    const maxAttempts = 50;

    let lastCurrent = '';
    let lastExpected = '';

    while (attempts < maxAttempts) {
      // Ensure all pending writes to the terminal are processed.
      await this.queue.promise;

      const currentFrame = stripAnsi(
        this.lastFrame({ allowEmpty: true }),
      ).trim();
      const expectedFrame = this.normalizeFrame(
        stripAnsi(
          (this.lastRenderStaticContent ?? '') + (this.lastRenderOutput ?? ''),
        ),
      ).trim();

      lastCurrent = currentFrame;
      lastExpected = expectedFrame;

      const isMatch = () => {
        if (expectedFrame === '...') {
          // '...' is our fallback when output isn't in stats, meaning Ink rendered *something*
          // but we don't know what it is. If terminal has content, we consider it a match.
          // However, if the component rendered null, both would be empty, but our fallback
          // made expectedFrame '...'. In that case, we can't easily know if it's ready,
          // but we can assume if there are no pending writes, it's ready.
          return currentFrame !== '' || this.pendingWrites === 0;
        }

        // If Ink expects nothing (no new static content and no dynamic output),
        // we consider it a match because the terminal buffer will just hold the historical static content.
        if (expectedFrame === '') {
          return true;
        }

        if (this.lastRenderOutput === undefined) {
          return false;
        }

        // If the terminal is empty but Ink expects something, it's not a match.
        if (currentFrame === '') {
          return false;
        }

        // Check if the current frame contains the expected content.
        // We use includes because xterm might have some formatting or
        // extra whitespace that Ink doesn't account for in its raw output measurements.
        return currentFrame.includes(expectedFrame);
      };

      if (this.pendingWrites === 0 && isMatch()) {
        return;
      }

      attempts++;
      await act(async () => {
        if (vi.isFakeTimers()) {
          await vi.advanceTimersByTimeAsync(10);
        } else {
          await new Promise((resolve) => setTimeout(resolve, 10));
        }
      });
    }

    throw new Error(
      `waitUntilReady() timed out after ${maxAttempts} attempts.\n` +
        `Expected content (stripped ANSI):\n"${lastExpected}"\n` +
        `Actual content (stripped ANSI):\n"${lastCurrent}"\n` +
        `Pending writes: ${this.pendingWrites}\n` +
        `Render count: ${this.renderCount}`,
    );
  }
}

class XtermStderr extends EventEmitter {
  private state: TerminalState;
  private pendingWrites = 0;
  private queue: { promise: Promise<void> };
  isTTY = true;

  constructor(state: TerminalState, queue: { promise: Promise<void> }) {
    super();
    this.state = state;
    this.queue = queue;
  }

  write = (data: string) => {
    this.pendingWrites++;
    this.queue.promise = this.queue.promise.then(async () => {
      await new Promise<void>((resolve) =>
        this.state.terminal.write(data, resolve),
      );
      this.pendingWrites--;
    });
  };

  dispose = () => {
    this.state.terminal.dispose();
  };

  lastFrame = () => '';
}

class XtermStdin extends EventEmitter {
  isTTY = true;
  data: string | null = null;
  constructor(options: { isTTY?: boolean } = {}) {
    super();
    this.isTTY = options.isTTY ?? true;
  }

  write = (data: string) => {
    this.data = data;
    this.emit('readable');
    this.emit('data', data);
  };

  setEncoding() {}
  setRawMode() {}
  resume() {}
  pause() {}
  ref() {}
  unref() {}

  read = () => {
    const { data } = this;
    this.data = null;
    return data;
  };
}

export type RenderInstance = {
  rerender: (tree: React.ReactElement) => void;
  /**
   * Deliver pending ResizeObserver measurements and commit the state they
   * set. In this harness the first paint runs before refs attach, so
   * observers registered on mount only report on a later layout-dirtying
   * commit; in the app the deferred paint delivers them before any input.
   * Unlike `rerender`, the terminal is not cleared.
   */
  settleLayout: () => Promise<void>;
  unmount: () => void;
  cleanup: () => void;
  stdout: XtermStdout;
  stderr: XtermStderr;
  stdin: XtermStdin;
  frames: string[];
  lastFrame: (options?: { allowEmpty?: boolean }) => string;
  lastFrameRaw: (options?: { allowEmpty?: boolean }) => string;
  generateSvg: () => string;
  terminal: Terminal;
  waitUntilReady: () => Promise<void>;
  capturedOverflowState: OverflowState | undefined;
  capturedOverflowActions: OverflowActions | undefined;
};

export type RenderWithProvidersInstance = RenderInstance & {
  simulateClick: (
    col: number,
    row: number,
    button?: 0 | 1 | 2,
  ) => Promise<void>;
  capturedRegistry: ActionHandlerRegistryImpl | undefined;
};

const instances: InkInstance[] = [];

export const render = async (
  tree: React.ReactElement,
  terminalWidth?: number,
  terminalHeight = 1000,
): Promise<
  Omit<RenderInstance, 'capturedOverflowState' | 'capturedOverflowActions'>
> => {
  const cols = terminalWidth ?? 100;
  // We use 1000 rows to avoid windows with incorrect snapshots if a correct
  // value was used (e.g. 40 rows). The alternatives to make things worse are
  // windows unfortunately with odd duplicate content in the backbuffer
  // which does not match actual behavior in xterm.js on windows.
  const rows = terminalHeight;
  const terminal = new Terminal({
    cols,
    rows,
    allowProposedApi: true,
    convertEol: true,
  });

  const state: TerminalState = {
    terminal,
    cols,
    rows,
  };
  const writeQueue = { promise: Promise.resolve() };
  const stdout = new XtermStdout(state, writeQueue);
  const stderr = new XtermStderr(state, writeQueue);
  const stdin = new XtermStdin();

  let instance!: InkInstance;
  stdout.clear();
  act(() => {
    instance = inkRenderDirect(tree, {
      stdout: stdout as unknown as NodeJS.WriteStream,

      stderr: stderr as unknown as NodeJS.WriteStream,

      stdin: stdin as unknown as NodeJS.ReadStream,
      debug: false,
      exitOnCtrlC: false,
      patchConsole: false,
      onRender: (stats: RenderSnapshot) => {
        const output = isInkRenderSnapshot(stats) ? stats.output : '...';
        const staticOutput = isInkRenderSnapshot(stats)
          ? (stats.staticOutput ?? '')
          : '';
        stdout.onRender(staticOutput, output);
      },
    });
  });

  instances.push(instance);

  await stdout.waitUntilReady();

  return {
    rerender: (newTree: React.ReactElement) => {
      act(() => {
        stdout.clear();
        instance.rerender(newTree);
      });
    },
    settleLayout: async () => {
      // In test mode the engine paints from resetAfterCommit, before React
      // attaches refs, so the first layout pass finds no observed elements
      // and a clean tree never re-runs layout. Collect against the layout
      // the paint computed and deliver the callbacks inside act so their
      // setState commits now.
      await act(async () => {
        triggerResizeObservers();
        flushResizeObserversSync();
      });
      await stdout.waitUntilReady();
    },
    unmount: () => {
      act(() => {
        instance.unmount();
      });
      stdout.dispose();
      stderr.dispose();
    },
    cleanup: instance.cleanup,
    stdout,
    stderr,
    stdin,
    frames: stdout.frames,
    lastFrame: stdout.lastFrame,
    lastFrameRaw: stdout.lastFrameRaw,
    generateSvg: stdout.generateSvg,
    terminal: state.terminal,
    waitUntilReady: () => stdout.waitUntilReady(),
  };
};

export const cleanup = () => {
  for (const instance of instances) {
    act(() => {
      instance.unmount();
    });
    instance.cleanup();
  }
  instances.length = 0;
};

export const simulateClick = async (
  stdin: XtermStdin,
  col: number,
  row: number,
  button: 0 | 1 | 2 = 0, // 0 for left, 1 for middle, 2 for right
) => {
  // Terminal mouse events are 1-based, so convert if necessary.
  const mouseEventString = `\x1b[<${button};${col};${row}M`;
  await act(async () => {
    stdin.write(mouseEventString);
  });
};

export const mockSettings = createMockSettings();

/**
 * Render a focused component test with only the settings-backed UI i18n
 * context. Use this for legacy tests that intentionally assemble their other
 * providers by hand and therefore should not inherit the full app harness.
 */
export const renderWithI18n = async (
  tree: React.ReactElement,
  terminalWidth?: number,
  terminalHeight = 1000,
  settings: LoadedSettings = mockSettings,
  i18nService?: I18nService,
) => {
  const wrap = (nextTree: React.ReactElement) => (
    <SettingsContext.Provider value={settings}>
      <I18nTestProvider service={i18nService}>{nextTree}</I18nTestProvider>
    </SettingsContext.Provider>
  );
  const result = await render(wrap(tree), terminalWidth, terminalHeight);

  return {
    ...result,
    rerender: (nextTree: React.ReactElement) => result.rerender(wrap(nextTree)),
  };
};

/** Inert prompt stash for tests that build an InputState literal. */
export const mockPromptStash: PromptStashState = {
  hasStash: false,
  toggleStash: () => 'noop',
  markRestorePending: () => {},
};

// A minimal mock UIState to satisfy the context provider.
// Tests that need specific UIState values should provide their own.
const baseMockUiState = {
  history: [],
  renderMarkdown: true,
  isInputVisible: true,
  isInputActive: true,
  sessionName: undefined,
  conversationKey: 0,
  streamingState: StreamingState.Idle,
  compressionProgress: null,
  activeModelQueue: null,
  isConfigInitialized: true,
  sessionGateVisible: false,
  terminalWidth: 100,
  terminalHeight: 40,
  currentModel: 'gemini-pro',
  currentReasoningEffort: undefined,
  currentContextWindow: undefined,
  terminalBackgroundColor: 'black' as const,
  cleanUiDetailsVisible: false,
  allowPlanMode: true,
  activeShellId: undefined,
  quota: {
    stats: undefined,
    proQuotaRequest: null,
  },
  hintMode: false,
  hintBuffer: '',
  nightly: false,
  isWorktreeExitDialogOpen: false,
  sessionRailSelectionMode: undefined,
  updateInfo: null,
  unifiedTasks: [],
  workflowHistoryTasks: undefined,
  unifiedRunningCount: 0,
  modelNextActionSuggestions: null,
  conversationScreen: 'prompt' as const,
  mainControlsRef: () => {},
  rootUiRef: { current: null },
};

export const mockAppState: AppState = {
  version: '1.2.3',
};

const mockUIActions: UIActions = {
  handleThemeSelect: vi.fn(),
  closeThemeDialog: vi.fn(),
  handleThemeHighlight: vi.fn(),
  onSessionGateStateChange: vi.fn(),
  handleEditorSelect: vi.fn(),
  exitEditorDialog: vi.fn(),
  closeSettingsDialog: vi.fn(),
  openAgentConfigDialog: vi.fn(),
  closeAgentConfigDialog: vi.fn(),
  openAgentBrowser: vi.fn(),
  closeAgentBrowser: vi.fn(),
  setAgentBrowserActiveTab: vi.fn(),
  openMcpBrowser: vi.fn(),
  closeMcpBrowser: vi.fn(),
  openHookBrowser: vi.fn(),
  closeHookBrowser: vi.fn(),
  openHookConfigDialog: vi.fn(),
  closeHookConfigDialog: vi.fn(),
  openSkillBrowser: vi.fn(),
  closeSkillBrowser: vi.fn(),
  openSkillDetailView: vi.fn(),
  closeSkillDetailView: vi.fn(),
  openConfigErrorDetail: vi.fn(),
  closeConfigErrorDetail: vi.fn(),
  openPluginBrowser: vi.fn(),
  closePluginBrowser: vi.fn(),
  openWorktreeExitDialog: vi.fn(),
  closeWorktreeExitDialog: vi.fn(),
  openSessionBrowser: vi.fn(),
  closeSessionBrowser: vi.fn(),
  openRewindDialog: vi.fn(),
  handleResumeSession: vi.fn(),
  handleDeleteSession: vi.fn(),
  setShellModeActive: vi.fn(),
  handleFolderTrustSelect: vi.fn(),
  handleMcpApproval: vi.fn(),
  handleExternalImportApproval: vi.fn(),
  handlePeerInboundApproval: vi.fn(),
  setConstrainHeight: vi.fn(),
  onEscapePromptChange: vi.fn(),
  requestRender: vi.fn(),
  handleFinalSubmit: vi.fn(),
  handleClearScreen: vi.fn(),
  setQueueErrorMessage: vi.fn(),
  addMessage: vi.fn(),
  popAllMessages: vi.fn(),
  sendQueuedNow: vi.fn(),
  setShortcutsHelpVisible: vi.fn(),
  setCleanUiDetailsVisible: vi.fn(),
  toggleCleanUiDetailsVisible: vi.fn(),
  revealCleanUiDetailsTemporarily: vi.fn(),
  handleWarning: vi.fn(),
  openBackgroundTaskList: vi.fn(() => true),
  viewAgentSession: vi.fn(),
  viewWorkflowSessions: vi.fn(),
  viewWorkflowSession: vi.fn(),
  viewMainSession: vi.fn(),
  onHintInput: vi.fn(),
  onHintBackspace: vi.fn(),
  onHintClear: vi.fn(),
  onHintSubmit: vi.fn(),
  handleRestart: vi.fn(),
  getPreferredEditor: vi.fn(),
  runAgent: vi.fn(),
  setInputText: vi.fn(),
};

import { type TextBuffer } from '../ui/components/shared/text-buffer.js';
import { InputContext, type InputState } from '../ui/contexts/InputContext.js';
import type { PromptStashState } from '../ui/hooks/usePromptStash.js';

let capturedOverflowState: OverflowState | undefined;
let capturedOverflowActions: OverflowActions | undefined;
let capturedRegistry: ActionHandlerRegistryImpl | undefined;
const ContextCapture: React.FC<{ children: React.ReactNode }> = ({
  children,
}) => {
  capturedOverflowState = useOverflowState();
  capturedOverflowActions = useOverflowActions();
  capturedRegistry = useActionHandlerRegistry() ?? undefined;
  return <>{children}</>;
};

/**
 * Bridge component that activates context-based keyboard routing in tests.
 * Calls useContextRouting to dispatch raw keypress events through the
 * KeyboardContextRegistry → ActionHandlerRegistry pipeline.
 *
 * Also registers the always-on `Global` and `Chat` contexts that AppContainer
 * normally activates via useAppFocusContextSync(). Without these, key events
 * never reach component-level fallback handlers (e.g. InputPrompt's
 * `useRegisterFallbackHandler('Chat', handleInput, ...)`), and tests that
 * exercise basic chat/shell-mode keystrokes silently no-op.
 */
const ContextRoutingBridge: React.FC<{ children: React.ReactNode }> = ({
  children,
}) => {
  useContextRouting({ enabled: true });
  useRegisterKeyboardContext('Global', true);
  useRegisterKeyboardContext('Chat', true);
  return <>{children}</>;
};

export const renderWithProviders = async (
  component: React.ReactElement,
  {
    settings = mockSettings,
    uiState: providedUiState,
    inputState: providedInputState,
    width,
    mouseEventsEnabled = false,
    config,
    uiActions,
    toolActions,
    initialFoldLevel = FoldLevel.FullyExpanded,
    persistentState,
    appState = mockAppState,
    i18nService,
  }: {
    settings?: LoadedSettings;
    i18nService?: I18nService;
    uiState?: Partial<UIState> & Partial<PendingHistoryValue>;
    inputState?: Partial<InputState>;
    width?: number;
    mouseEventsEnabled?: boolean;
    config?: Config;
    uiActions?: Partial<UIActions>;
    toolActions?: Partial<{
      isExpanded: (callId: string) => boolean;
      toggleExpansion: (callId: string) => void;
      toggleAllExpansion: (callIds: string[]) => void;
    }>;
    initialFoldLevel?: FoldLevel;
    persistentState?: {
      get?: typeof persistentStateMock.get;
      set?: typeof persistentStateMock.set;
    };
    appState?: AppState;
  } = {},
): Promise<RenderWithProvidersInstance> => {
  const baseState: UIState = new Proxy(
    { ...baseMockUiState, ...providedUiState },
    {
      get(target, prop) {
        if (prop in target) {
          return target[prop as keyof typeof target];
        }
        // For properties not in the base mock or provided state,
        // we'll check the original proxy to see if it's a defined but
        // unprovided property, and if not, throw.
        if (prop in baseMockUiState) {
          return baseMockUiState[prop as keyof typeof baseMockUiState];
        }
        throw new Error(`mockUiState does not have property ${String(prop)}`);
      },
    },
  ) as UIState;

  const inputState = {
    buffer: { text: '' } as unknown as TextBuffer,
    userMessages: [],
    shellModeActive: false,
    showEscapePrompt: false,
    inputWidth: 80,
    suggestionsWidth: 40,
    stash: mockPromptStash,
    ...(providedUiState as unknown as Partial<InputState>),
    ...providedInputState,
  };

  // Recover the default get/set implementations first — a test's
  // `vi.restoreAllMocks()` in beforeEach strips them, which would leave the
  // fake store unreadable. Custom overrides (below) then apply on top.
  persistentStateMock.ensureImplementations();

  if (persistentState?.get) {
    persistentStateMock.get.mockImplementation(persistentState.get);
  }
  if (persistentState?.set) {
    persistentStateMock.set.mockImplementation(persistentState.set);
  }

  persistentStateMock.mockClear();

  const terminalWidth = width ?? baseState.terminalWidth;

  if (!config) {
    config = makeFakeConfig({
      useAlternateBuffer: settings.merged.ui?.useAlternateBuffer,
      accessibility: settings.merged.ui?.accessibility,
    });
  }

  const mainAreaWidth = providedUiState?.mainAreaWidth ?? terminalWidth;

  // pendingHistoryItems / pendingGeminiHistoryItems moved out of UIState into
  // PendingHistoryContext. Tests still pass them through the uiState bag, so
  // split them back out here rather than churning every call site.
  const pendingHistoryValue: PendingHistoryValue = {
    pendingHistoryItems: providedUiState?.pendingHistoryItems ?? [],
    pendingGeminiHistoryItems: providedUiState?.pendingGeminiHistoryItems ?? [],
    thought: providedUiState?.thought ?? null,
  };

  const finalUiState = {
    ...baseState,
    terminalWidth,
    mainAreaWidth,
  };

  themeManager.setTerminalBackground(baseState.terminalBackgroundColor);
  const themeName = pickDefaultThemeName(
    baseState.terminalBackgroundColor,
    themeManager.getAllThemes(),
    DEFAULT_THEME.name,
    DefaultLight.name,
  );
  themeManager.setActiveTheme(themeName);

  const finalUIActions = { ...mockUIActions, ...uiActions };

  const allToolCalls = pendingHistoryValue.pendingHistoryItems
    .filter((item): item is HistoryItemToolGroup => item.type === 'tool_group')
    .flatMap((item) => item.tools);

  capturedOverflowState = undefined;
  capturedOverflowActions = undefined;
  capturedRegistry = undefined;

  const wrapWithProviders = (comp: React.ReactElement) => (
    <AppContext.Provider value={appState}>
      <ConfigContext.Provider value={config}>
        <SettingsContext.Provider value={settings}>
          <I18nTestProvider service={i18nService}>
            <InputContext.Provider value={inputState}>
              <UIStateContext.Provider value={finalUiState}>
                <PendingHistoryContext.Provider value={pendingHistoryValue}>
                  <VimModeProvider>
                    <FoldStateProvider initialFoldLevel={initialFoldLevel}>
                      <SessionStatsProvider
                        getSessionId={() => config.getSessionId()}
                      >
                        <StreamingContext.Provider
                          value={finalUiState.streamingState}
                        >
                          <UIActionsContext.Provider value={finalUIActions}>
                            <OverflowProvider>
                              <ToolActionsProvider
                                toolCalls={allToolCalls}
                                isExpanded={
                                  toolActions?.isExpanded ??
                                  vi.fn().mockReturnValue(false)
                                }
                                toggleExpansion={
                                  toolActions?.toggleExpansion ?? vi.fn()
                                }
                                toggleAllExpansion={
                                  toolActions?.toggleAllExpansion ?? vi.fn()
                                }
                              >
                                <KeypressProvider>
                                  <KeyboardContextProvider>
                                    <ActionHandlerRegistryProvider>
                                      <ContextRoutingBridge>
                                        <MouseProvider
                                          mouseEventsEnabled={
                                            mouseEventsEnabled
                                          }
                                        >
                                          <TerminalProvider>
                                            <ScrollProvider>
                                              <ContextCapture>
                                                <Box
                                                  width={terminalWidth}
                                                  flexShrink={0}
                                                  flexGrow={0}
                                                  flexDirection="column"
                                                >
                                                  {comp}
                                                </Box>
                                              </ContextCapture>
                                            </ScrollProvider>
                                          </TerminalProvider>
                                        </MouseProvider>
                                      </ContextRoutingBridge>
                                    </ActionHandlerRegistryProvider>
                                  </KeyboardContextProvider>
                                </KeypressProvider>
                              </ToolActionsProvider>
                            </OverflowProvider>
                          </UIActionsContext.Provider>
                        </StreamingContext.Provider>
                      </SessionStatsProvider>
                    </FoldStateProvider>
                  </VimModeProvider>
                </PendingHistoryContext.Provider>
              </UIStateContext.Provider>
            </InputContext.Provider>
          </I18nTestProvider>
        </SettingsContext.Provider>
      </ConfigContext.Provider>
    </AppContext.Provider>
  );

  const renderResult = await render(
    wrapWithProviders(component),
    terminalWidth,
  );

  return {
    ...renderResult,
    rerender: (newComponent: React.ReactElement) => {
      renderResult.rerender(wrapWithProviders(newComponent));
    },
    capturedOverflowState,
    capturedOverflowActions,
    capturedRegistry,
    simulateClick: (col: number, row: number, button?: 0 | 1 | 2) =>
      simulateClick(renderResult.stdin, col, row, button),
  };
};

export async function renderHook<Result, Props>(
  renderCallback: (props: Props) => Result,
  options?: {
    initialProps?: Props;
    wrapper?: React.ComponentType<{ children: React.ReactNode }>;
  },
): Promise<{
  result: { current: Result };
  rerender: (props?: Props) => void;
  unmount: () => void;
  waitUntilReady: () => Promise<void>;
  generateSvg: () => string;
}> {
  const result = { current: undefined as unknown as Result };
  let currentProps = options?.initialProps as Props;

  function TestComponent({
    renderCallback,
    props,
  }: {
    renderCallback: (props: Props) => Result;
    props: Props;
  }) {
    result.current = renderCallback(props);
    return null;
  }

  const Wrapper = options?.wrapper || (({ children }) => <>{children}</>);

  let inkRerender: (tree: React.ReactElement) => void = () => {};
  let unmount: () => void = () => {};
  let waitUntilReady: () => Promise<void> = async () => {};
  let generateSvg: () => string = () => '';

  const renderResult = await render(
    <Wrapper>
      <TestComponent renderCallback={renderCallback} props={currentProps} />
    </Wrapper>,
  );
  inkRerender = renderResult.rerender;
  unmount = renderResult.unmount;
  waitUntilReady = renderResult.waitUntilReady;
  generateSvg = renderResult.generateSvg;

  function rerender(props?: Props) {
    if (arguments.length > 0) {
      currentProps = props as Props;
    }
    act(() => {
      inkRerender(
        <Wrapper>
          <TestComponent renderCallback={renderCallback} props={currentProps} />
        </Wrapper>,
      );
    });
  }

  return { result, rerender, unmount, waitUntilReady, generateSvg };
}

export async function renderHookWithProviders<Result, Props>(
  renderCallback: (props: Props) => Result,
  options: {
    initialProps?: Props;
    wrapper?: React.ComponentType<{ children: React.ReactNode }>;
    // Options for renderWithProviders
    settings?: LoadedSettings;
    uiState?: Partial<UIState> & Partial<PendingHistoryValue>;
    width?: number;
    mouseEventsEnabled?: boolean;
    config?: Config;
  } = {},
): Promise<{
  result: { current: Result };
  rerender: (props?: Props) => void;
  unmount: () => void;
  waitUntilReady: () => Promise<void>;
  generateSvg: () => string;
}> {
  const result = { current: undefined as unknown as Result };

  let setPropsFn: ((props: Props) => void) | undefined;
  let forceUpdateFn: (() => void) | undefined;

  function TestComponent({ initialProps }: { initialProps: Props }) {
    const [props, setProps] = useState(initialProps);
    const [, forceUpdate] = useState(0);
    setPropsFn = setProps;
    forceUpdateFn = () => forceUpdate((n) => n + 1);
    result.current = renderCallback(props);
    return null;
  }

  const Wrapper = options.wrapper || (({ children }) => <>{children}</>);

  let renderResult: RenderWithProvidersInstance;

  await act(async () => {
    renderResult = await renderWithProviders(
      <Wrapper>
        {}
        <TestComponent initialProps={options.initialProps as Props} />
      </Wrapper>,
      options,
    );
  });

  function rerender(newProps?: Props) {
    act(() => {
      if (arguments.length > 0 && setPropsFn) {
        setPropsFn(newProps as Props);
      } else if (forceUpdateFn) {
        forceUpdateFn();
      }
    });
  }

  return {
    result,
    rerender,
    unmount: () => {
      act(() => {
        renderResult.unmount();
      });
    },
    waitUntilReady: () => renderResult.waitUntilReady(),
    generateSvg: () => renderResult.generateSvg(),
  };
}
