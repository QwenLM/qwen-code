/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, vi } from 'vitest';
import { useCallback, useState } from 'react';
import { createRequire } from 'node:module';
import type chalk from 'chalk';
import { theme } from '../semantic-colors.js';
import { render } from 'ink-testing-library';
import { Text } from 'ink';
import { Composer } from './Composer.js';
import { InputPrompt } from './InputPrompt.js';
import { UIStateContext, type UIState } from '../contexts/UIStateContext.js';
import {
  UIActionsContext,
  type UIActions,
} from '../contexts/UIActionsContext.js';
import { ConfigContext } from '../contexts/ConfigContext.js';
// Mock VimModeContext hook
vi.mock('../contexts/VimModeContext.js', () => ({
  useVimModeState: vi.fn(() => ({
    vimEnabled: false,
    vimMode: 'NORMAL',
  })),
  useVimModeActions: vi.fn(() => ({
    toggleVimEnabled: vi.fn(),
    setVimMode: vi.fn(),
  })),
  useVimMode: vi.fn(() => ({
    vimEnabled: false,
    vimMode: 'NORMAL',
    toggleVimEnabled: vi.fn(),
    setVimMode: vi.fn(),
  })),
}));
import { ApprovalMode, type Config } from '@qwen-code/qwen-code-core';
import { MessageType, StreamingState } from '../types.js';

// Mock child components
vi.mock('./LoadingIndicator.js', () => ({
  LoadingIndicator: ({
    currentLoadingPhrase,
    candidatesTokens,
    taskStartTokens,
    taskStartStreamingChars,
    showResponseTokensPerSecond,
  }: {
    currentLoadingPhrase?: string;
    candidatesTokens?: number;
    taskStartTokens?: number;
    taskStartStreamingChars?: number;
    showResponseTokensPerSecond?: boolean;
  }) => (
    <Text>
      LoadingIndicator
      {currentLoadingPhrase ? `: ${currentLoadingPhrase}` : ''}
      {typeof candidatesTokens === 'number' ? `: ${candidatesTokens}` : ''}
      {typeof taskStartTokens === 'number' ? `: start ${taskStartTokens}` : ''}
      {typeof taskStartStreamingChars === 'number'
        ? `: chars ${taskStartStreamingChars}`
        : ''}
      {showResponseTokensPerSecond ? ': show t/s' : ''}
    </Text>
  ),
}));

vi.mock('./ContextSummaryDisplay.js', () => ({
  ContextSummaryDisplay: () => <Text>ContextSummaryDisplay</Text>,
}));

vi.mock('./AutoAcceptIndicator.js', () => ({
  AutoAcceptIndicator: () => <Text>AutoAcceptIndicator</Text>,
}));

vi.mock('./ShellModeIndicator.js', () => ({
  ShellModeIndicator: () => <Text>ShellModeIndicator</Text>,
}));

vi.mock('./InputPrompt.js', () => ({
  InputPrompt: vi.fn(() => <Text>InputPrompt</Text>),
  calculatePromptWidths: vi.fn(() => ({
    inputWidth: 80,
    suggestionsWidth: 40,
    containerWidth: 84,
  })),
}));

vi.mock('./Footer.js', () => ({
  Footer: () => <Text>Footer</Text>,
}));

vi.mock('./QueuedMessageDisplay.js', () => ({
  QueuedMessageDisplay: ({ messageQueue }: { messageQueue: string[] }) => {
    if (messageQueue.length === 0) {
      return null;
    }
    return (
      <>
        {messageQueue.map((message, index) => (
          <Text key={index}>{message}</Text>
        ))}
      </>
    );
  },
}));

const modBand = vi.hoisted(() => ({ current: undefined as unknown }));
vi.mock('../hooks/use-mod-band.js', () => ({
  useModBand: () => modBand.current,
}));

vi.mock('../FeedbackDialog.js', () => ({
  FeedbackDialog: () => <Text>FeedbackDialog</Text>,
}));

// Mock contexts
vi.mock('../contexts/OverflowContext.js', () => ({
  OverflowProvider: ({ children }: { children: React.ReactNode }) => children,
}));

// Create mock context providers
const createMockUIState = (overrides: Partial<UIState> = {}): UIState =>
  ({
    streamingState: null,
    contextFileNames: [],
    showAutoAcceptIndicator: ApprovalMode.DEFAULT,
    messageQueue: [],
    constrainHeight: false,
    isInputActive: true,
    isConfigInitialized: true,
    buffer: { text: '' },
    history: [],
    subscriptionHintsDismissed: false,
    inputWidth: 80,
    suggestionsWidth: 40,
    userMessages: [],
    slashCommands: [],
    commandContext: null,
    shellModeActive: false,
    isFocused: true,
    thought: null,
    currentLoadingPhrase: '',
    elapsedTime: 0,
    ctrlCPressedOnce: false,
    ctrlDPressedOnce: false,
    showEscapePrompt: false,
    ideContextState: null,
    memoryFileCount: 0,
    showToolDescriptions: false,
    sessionStats: {
      lastPromptTokenCount: 0,
      sessionTokenCount: 0,
      totalPrompts: 0,
    },
    branchName: 'main',
    debugMessage: '',
    nightly: false,
    isTrustedFolder: true,
    taskStartTokens: 0,
    taskStartStreamingChars: 0,
    responseCandidateTokens: 0,
    streamingResponseLengthRef: { current: 0 },
    voiceMicWarnedStatusRef: { current: null },
    isReceivingContent: false,
    pendingLlmHistoryItems: [],
    terminalWidth: 80,
    ...overrides,
  }) as UIState;

const createMockUIActions = (): UIActions =>
  ({
    handleFinalSubmit: vi.fn(),
    handleRetryLastPrompt: vi.fn(),
    handleClearScreen: vi.fn(),
    setShellModeActive: vi.fn(),
    onEscapePromptChange: vi.fn(),
    vimHandleInput: vi.fn(),
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
  }) as any;

const createMockConfig = (overrides = {}) => ({
  getAuthType: vi.fn(() => 'openai'),
  getModel: vi.fn(() => 'gemini-1.5-pro'),
  getTargetDir: vi.fn(() => '/test/dir'),
  getDebugMode: vi.fn(() => false),
  getAccessibility: vi.fn(() => ({})),
  getShowResponseTokensPerSecond: vi.fn(() => false),
  getMcpServers: vi.fn(() => ({})),
  getBlockedMcpServers: vi.fn(() => []),
  ...overrides,
});

function ComposerOwner({
  uiState,
  config,
  uiActions,
  showComposer,
}: {
  uiState: UIState;
  config: ReturnType<typeof createMockConfig>;
  uiActions: UIActions;
  showComposer: boolean;
}) {
  const [subscriptionHintsDismissed, setSubscriptionHintsDismissed] = useState(
    uiState.subscriptionHintsDismissed,
  );
  const dismissSubscriptionHints = useCallback(
    () => setSubscriptionHintsDismissed(true),
    [],
  );
  return (
    <ConfigContext.Provider value={config as unknown as Config}>
      <UIStateContext.Provider
        value={{ ...uiState, subscriptionHintsDismissed }}
      >
        <UIActionsContext.Provider
          value={{ ...uiActions, dismissSubscriptionHints }}
        >
          {showComposer ? <Composer /> : <Text>Auth dialog</Text>}
        </UIActionsContext.Provider>
      </UIStateContext.Provider>
    </ConfigContext.Provider>
  );
}

const composerElement = (
  uiState: UIState,
  config = createMockConfig(),
  uiActions = createMockUIActions(),
  showComposer = true,
) => (
  <ComposerOwner
    uiState={uiState}
    config={config}
    uiActions={uiActions}
    showComposer={showComposer}
  />
);

const renderComposer = (
  uiState: UIState,
  config = createMockConfig(),
  uiActions = createMockUIActions(),
) => render(composerElement(uiState, config, uiActions));

describe('Composer', () => {
  describe('Footer Display', () => {
    it('renders Footer by default', () => {
      const uiState = createMockUIState();

      const { lastFrame } = renderComposer(uiState);

      // Smoke check that the Footer renders
      expect(lastFrame()).toContain('Footer');
    });

    it('renders the startup footer while config initialization is pending', () => {
      // Footer is the sole production consumer of useConfigInitMessage, which
      // returns a message only while isConfigInitialized is false. Gating the
      // footer on isInputActive alone makes the two windows disjoint, so
      // startup would show no progress feedback at all.
      const uiState = createMockUIState({
        isInputActive: false,
        isConfigInitialized: false,
      });

      const { lastFrame } = renderComposer(uiState);

      expect(lastFrame()).toContain('Footer');
      // The race this change closes must stay closed: no input before init.
      expect(lastFrame()).not.toContain('InputPrompt');
    });

    it('keeps the footer hidden when input is inactive and initialization is done', () => {
      const uiState = createMockUIState({
        isInputActive: false,
        isConfigInitialized: true,
      });

      const { lastFrame } = renderComposer(uiState);

      expect(lastFrame()).not.toContain('Footer');
    });
  });

  describe('Loading Indicator', () => {
    it('renders LoadingIndicator with phrase when streaming', () => {
      const uiState = createMockUIState({
        streamingState: StreamingState.Responding,
        currentLoadingPhrase: 'Analyzing',
        elapsedTime: 1500,
      });

      const { lastFrame } = renderComposer(uiState);

      const output = lastFrame();
      expect(output).toContain('LoadingIndicator');
      expect(output).toContain('LoadingIndicator: Analyzing');
    });

    it('passes the response token rate setting to LoadingIndicator', () => {
      const uiState = createMockUIState({
        streamingState: StreamingState.Responding,
        currentLoadingPhrase: 'Analyzing',
        responseCandidateTokens: 550,
        taskStartTokens: 500,
        taskStartStreamingChars: 200,
      });
      const config = createMockConfig({
        getShowResponseTokensPerSecond: vi.fn(() => true),
      });

      const { lastFrame } = renderComposer(uiState, config);

      expect(lastFrame()).toContain('LoadingIndicator: Analyzing');
      expect(lastFrame()).toContain(': 550: start 500: chars 200');
      expect(lastFrame()).toContain(': show t/s');
    });

    // ─── Narrow-terminal suppression (suppressBottomLoadingIndicator) ───
    // The indicator is hidden only when actively Responding on a terminal
    // ≤ 30 cols wide. WaitingForConfirmation must NEVER be suppressed.

    it('hides LoadingIndicator when Responding on a 30-col terminal', () => {
      const uiState = createMockUIState({
        streamingState: StreamingState.Responding,
        terminalWidth: 30,
      });

      const { lastFrame } = renderComposer(uiState);

      expect(lastFrame()).not.toContain('LoadingIndicator');
    });

    it('hides LoadingIndicator when Responding on a 25-col terminal', () => {
      const uiState = createMockUIState({
        streamingState: StreamingState.Responding,
        terminalWidth: 25,
      });

      const { lastFrame } = renderComposer(uiState);

      expect(lastFrame()).not.toContain('LoadingIndicator');
    });

    it('preserves "esc to cancel" fallback when LoadingIndicator is suppressed', () => {
      // Even when the full LoadingIndicator is hidden on ultra-narrow
      // terminals, the cancel affordance must remain so users can abort.
      const uiState = createMockUIState({
        streamingState: StreamingState.Responding,
        terminalWidth: 25,
      });

      const { lastFrame } = renderComposer(uiState);

      const output = lastFrame();
      expect(output).not.toContain('LoadingIndicator');
      expect(output).toContain('Esc to cancel');
    });

    it('does not render the esc fallback once the full indicator is visible', () => {
      const uiState = createMockUIState({
        streamingState: StreamingState.Responding,
        terminalWidth: 31,
      });

      const { lastFrame } = renderComposer(uiState);

      const output = lastFrame();
      expect(output).toContain('LoadingIndicator');
      // The minimal fallback string only appears when the full indicator is
      // suppressed — when LoadingIndicator renders, it owns the cancel hint.
      expect(output).not.toContain('Esc to cancel');
    });

    it('shows LoadingIndicator when Responding on a 31-col terminal', () => {
      const uiState = createMockUIState({
        streamingState: StreamingState.Responding,
        terminalWidth: 31,
      });

      const { lastFrame } = renderComposer(uiState);

      expect(lastFrame()).toContain('LoadingIndicator');
    });

    it('shows LoadingIndicator when WaitingForConfirmation even on a 25-col terminal', () => {
      // Confirmation prompts must remain visible regardless of width — the
      // user needs to see something is awaiting their input.
      const uiState = createMockUIState({
        streamingState: StreamingState.WaitingForConfirmation,
        terminalWidth: 25,
      });

      const { lastFrame } = renderComposer(uiState);

      expect(lastFrame()).toContain('LoadingIndicator');
    });

    it('renders LoadingIndicator during WaitingForConfirmation', () => {
      const uiState = createMockUIState({
        streamingState: StreamingState.WaitingForConfirmation,
      });

      const { lastFrame } = renderComposer(uiState);

      expect(lastFrame()).toContain('LoadingIndicator');
    });
  });

  describe('Message Queue Display', () => {
    it('displays queued messages when present', () => {
      const uiState = createMockUIState({
        messageQueue: [
          'First queued message',
          'Second queued message',
          'Third queued message',
        ],
      });

      const { lastFrame } = renderComposer(uiState);

      const output = lastFrame();
      expect(output).toContain('First queued message');
      expect(output).toContain('Second queued message');
      expect(output).toContain('Third queued message');
    });

    it('renders QueuedMessageDisplay with empty message queue', () => {
      const uiState = createMockUIState({
        messageQueue: [],
      });

      const { lastFrame } = renderComposer(uiState);

      // The component should render but return null for empty queue
      // This test verifies that the component receives the correct prop
      const output = lastFrame();
      expect(output).toContain('InputPrompt'); // Verify basic Composer rendering
    });
  });

  describe('Mod band', () => {
    it('draws the band between the survey and the prompt, only while the input shows', () => {
      modBand.current = {
        tree: { type: 'Text', children: ['☀ Clear 12%'] },
        owner: 'token-weather',
        revision: 1,
      };
      try {
        const { lastFrame } = renderComposer(
          createMockUIState({ isFeedbackDialogOpen: true, terminalHeight: 24 }),
        );
        const output = lastFrame()!;
        expect(output.indexOf('FeedbackDialog')).toBeLessThan(
          output.indexOf('☀ Clear 12%'),
        );
        expect(output.indexOf('☀ Clear 12%')).toBeLessThan(
          output.indexOf('InputPrompt'),
        );
        expect(
          renderComposer(createMockUIState({ isInputActive: false }))
            .lastFrame()!
            .includes('☀'),
        ).toBe(false);
      } finally {
        modBand.current = undefined;
      }
    });
  });

  describe('Context and Status Display', () => {
    // Note: ContextSummaryDisplay and status prompts are now rendered in Footer, not Composer
    it('shows empty space in normal state (ContextSummaryDisplay moved to Footer)', () => {
      const uiState = createMockUIState({
        ctrlCPressedOnce: false,
        ctrlDPressedOnce: false,
        showEscapePrompt: false,
      });

      const { lastFrame } = renderComposer(uiState);

      // ContextSummaryDisplay is now in Footer, so we just verify normal state renders
      expect(lastFrame()).toBeDefined();
    });

    // Note: Ctrl+C, Ctrl+D, and Escape prompts are now rendered in Footer component
    // These are tested in Footer.test.tsx
    it('renders Footer which handles Ctrl+C exit prompt', () => {
      const uiState = createMockUIState({
        ctrlCPressedOnce: true,
      });

      const { lastFrame } = renderComposer(uiState);

      // Ctrl+C prompt is now inside Footer, verify Footer renders
      expect(lastFrame()).toContain('Footer');
    });

    it('renders Footer which handles Ctrl+D exit prompt', () => {
      const uiState = createMockUIState({
        ctrlDPressedOnce: true,
      });

      const { lastFrame } = renderComposer(uiState);

      // Ctrl+D prompt is now inside Footer, verify Footer renders
      expect(lastFrame()).toContain('Footer');
    });

    it('renders Footer which handles escape prompt', () => {
      const uiState = createMockUIState({
        showEscapePrompt: true,
      });

      const { lastFrame } = renderComposer(uiState);

      // Escape prompt is now inside Footer, verify Footer renders
      expect(lastFrame()).toContain('Footer');
    });
  });

  describe('Input and Indicators', () => {
    it('renders InputPrompt when input is active', () => {
      const uiState = createMockUIState({
        isInputActive: true,
      });

      const { lastFrame } = renderComposer(uiState);

      expect(lastFrame()).toContain('InputPrompt');
    });

    it('does not render InputPrompt when input is inactive', () => {
      const uiState = createMockUIState({
        isInputActive: false,
      });

      const { lastFrame } = renderComposer(uiState);

      expect(lastFrame()).not.toContain('InputPrompt');
    });

    it('forwards the session voice permission ref across input-active toggles', () => {
      const mockedInputPrompt = vi.mocked(InputPrompt);
      mockedInputPrompt.mockClear();
      const voiceMicWarnedStatusRef = { current: null };
      const config = createMockConfig();
      const uiActions = createMockUIActions();
      const activeState = createMockUIState({ voiceMicWarnedStatusRef });
      const inactiveState = createMockUIState({
        voiceMicWarnedStatusRef,
        isInputActive: false,
      });

      const { rerender } = render(
        composerElement(activeState, config, uiActions),
      );
      expect(mockedInputPrompt).toHaveBeenCalled();
      expect(
        mockedInputPrompt.mock.calls.at(-1)![0].voiceMicWarnedStatusRef,
      ).toBe(voiceMicWarnedStatusRef);

      // Input goes inactive (InputPrompt unmounts), then active again — the
      // remounted InputPrompt must receive the same ref object, not a new one.
      rerender(composerElement(inactiveState, config, uiActions));
      mockedInputPrompt.mockClear();
      rerender(composerElement(activeState, config, uiActions));
      expect(mockedInputPrompt).toHaveBeenCalled();
      expect(
        mockedInputPrompt.mock.calls.at(-1)![0].voiceMicWarnedStatusRef,
      ).toBe(voiceMicWarnedStatusRef);
    });

    // Note: AutoAcceptIndicator and ShellModeIndicator are now rendered inside Footer component
    // These are tested in Footer.test.tsx
    it('renders Footer which contains AutoAcceptIndicator when approval mode is not default', () => {
      const uiState = createMockUIState({
        showAutoAcceptIndicator: ApprovalMode.YOLO,
        shellModeActive: false,
      });

      const { lastFrame } = renderComposer(uiState);

      // AutoAcceptIndicator is now inside Footer, verify Footer renders
      expect(lastFrame()).toContain('Footer');
    });

    it('renders Footer which contains ShellModeIndicator when shell mode is active', () => {
      const uiState = createMockUIState({
        shellModeActive: true,
      });

      const { lastFrame } = renderComposer(uiState);

      // ShellModeIndicator is now inside Footer, verify Footer renders
      expect(lastFrame()).toContain('Footer');
    });
  });
});

it('shows the subscription input and blue underlined command hints in the main composer', async () => {
  const inkRequire = createRequire(
    createRequire(import.meta.url).resolve('ink'),
  );
  const inkChalk: typeof chalk = (await import(inkRequire.resolve('chalk')))
    .default;
  const previousLevel = inkChalk.level;
  inkChalk.level = 3;
  const ui = renderComposer(
    createMockUIState(),
    createMockConfig({ getAuthType: () => 'qwen-subscription' }),
  );
  try {
    expect(ui.lastFrame()).toContain(
      ['/usage', '/status', '/upgrade', '/logout']
        .map((command) =>
          inkChalk.underline(inkChalk.hex(theme.text.link)(command)),
        )
        .join('  '),
    );
    expect(vi.mocked(InputPrompt).mock.calls.at(-1)?.[0].placeholder).toBe(
      '  Type your request, or /usage',
    );
  } finally {
    ui.unmount();
    inkChalk.level = previousLevel;
  }
});

it('shows hints after a fresh login despite earlier conversation and logout history', async () => {
  const history: UIState['history'] = [
    { id: 1, type: MessageType.USER, text: 'earlier conversation' },
    { id: 2, type: MessageType.USER, text: '/logout' },
    {
      id: 3,
      type: MessageType.INFO,
      text: 'new login',
      presentation: 'subscription-success',
    },
  ];
  const config = createMockConfig({ getAuthType: () => 'qwen-subscription' });
  const ui = renderComposer(createMockUIState({ history }), config);
  try {
    expect(ui.lastFrame()).toContain('/usage  /status  /upgrade  /logout');
    ui.rerender(
      composerElement(
        createMockUIState({
          history: [
            ...history,
            { id: 4, type: MessageType.USER, text: 'new question' },
          ],
        }),
        config,
      ),
    );
    await vi.waitFor(() =>
      expect(ui.lastFrame()).not.toContain(
        '/usage  /status  /upgrade  /logout',
      ),
    );
  } finally {
    ui.unmount();
  }
});

it('dismisses the subscription welcome hints after first input and keeps them dismissed after clearing or a response', async () => {
  const config = createMockConfig({ getAuthType: () => 'qwen-subscription' });
  const actions = createMockUIActions();
  const idle = createMockUIState({
    buffer: { text: '' } as UIState['buffer'],
    history: [],
    userMessages: [],
  });
  const ui = render(composerElement(idle, config, actions));
  try {
    expect(ui.lastFrame()).toContain('/usage  /status  /upgrade  /logout');
    ui.rerender(
      composerElement(
        { ...idle, buffer: { text: 'hello' } as UIState['buffer'] },
        config,
        actions,
      ),
    );
    await vi.waitFor(() =>
      expect(vi.mocked(InputPrompt).mock.calls.at(-1)?.[0].buffer.text).toBe(
        'hello',
      ),
    );
    expect
      .soft(ui.lastFrame())
      .not.toContain('/usage  /status  /upgrade  /logout');
    ui.rerender(composerElement(idle, config, actions));
    await vi.waitFor(() =>
      expect(vi.mocked(InputPrompt).mock.calls.at(-1)?.[0].buffer.text).toBe(
        '',
      ),
    );
    expect
      .soft(ui.lastFrame())
      .not.toContain('/usage  /status  /upgrade  /logout');
    ui.rerender(
      composerElement(
        { ...idle, streamingState: StreamingState.Responding },
        config,
        actions,
      ),
    );
    await vi.waitFor(() =>
      expect(ui.lastFrame()).not.toContain(
        '/usage  /status  /upgrade  /logout',
      ),
    );
    ui.rerender(composerElement(idle, config, actions));
    await vi.waitFor(() => expect(ui.lastFrame()).toContain('InputPrompt'));
    expect
      .soft(ui.lastFrame())
      .not.toContain('/usage  /status  /upgrade  /logout');
  } finally {
    ui.unmount();
  }
});

it('does not show subscription welcome hints when opening an existing conversation', () => {
  const ui = renderComposer(
    createMockUIState({
      buffer: { text: '' } as UIState['buffer'],
      history: [{ id: 1, type: 'user', text: 'hello' }],
      userMessages: ['hello'],
    }),
    createMockConfig({ getAuthType: () => 'qwen-subscription' }),
  );
  try {
    expect(ui.lastFrame()).not.toContain('/usage  /status  /upgrade  /logout');
  } finally {
    ui.unmount();
  }
});

it('dismisses subscription welcome hints on submission even before buffer updates', async () => {
  const config = createMockConfig({ getAuthType: () => 'qwen-subscription' });
  const state = createMockUIState();
  const actions = createMockUIActions();
  const ui = renderComposer(state, config, actions);
  try {
    expect(ui.lastFrame()).toContain('/usage  /status  /upgrade  /logout');
    const props = vi.mocked(InputPrompt).mock.calls.at(-1)![0];
    const options = { deferUntilIdle: true, submittedPrompt: 'hello' };
    props.onSubmit('hello', options);
    expect(actions.handleFinalSubmit).toHaveBeenCalledWith('hello', options);
    await vi.waitFor(() =>
      expect(ui.lastFrame()).not.toContain(
        '/usage  /status  /upgrade  /logout',
      ),
    );
    ui.rerender(composerElement(state, config, actions));
    await vi.waitFor(() =>
      expect(ui.lastFrame()).not.toContain(
        '/usage  /status  /upgrade  /logout',
      ),
    );
  } finally {
    ui.unmount();
  }
});

it('keeps subscription hints dismissed when a response finishes without local typing', async () => {
  const config = createMockConfig({ getAuthType: () => 'qwen-subscription' });
  const idle = createMockUIState();
  const actions = createMockUIActions();
  const ui = renderComposer(idle, config, actions);
  try {
    expect(ui.lastFrame()).toContain('/usage  /status  /upgrade  /logout');
    ui.rerender(
      composerElement(
        { ...idle, streamingState: StreamingState.Responding },
        config,
        actions,
      ),
    );
    await vi.waitFor(() =>
      expect(ui.lastFrame()).not.toContain(
        '/usage  /status  /upgrade  /logout',
      ),
    );
    const calls = vi.mocked(InputPrompt).mock.calls.length;
    ui.rerender(composerElement(idle, config, actions));
    await vi.waitFor(() =>
      expect(vi.mocked(InputPrompt).mock.calls.length).toBeGreaterThan(calls),
    );
    expect(ui.lastFrame()).not.toContain('/usage  /status  /upgrade  /logout');
  } finally {
    ui.unmount();
  }
});

it('allows initial subscription welcome hints after /auth setup history', () => {
  const ui = renderComposer(
    createMockUIState({
      history: [{ id: 1, type: 'user', text: '/auth' }],
      userMessages: ['/auth'],
    }),
    createMockConfig({ getAuthType: () => 'qwen-subscription' }),
  );
  try {
    expect(ui.lastFrame()).toContain('/usage  /status  /upgrade  /logout');
  } finally {
    ui.unmount();
  }
});

it('keeps welcome hints dismissed across auth-dialog unmount and remount within the same owner', async () => {
  const config = createMockConfig({ getAuthType: () => 'qwen-subscription' });
  const actions = createMockUIActions();
  const initial = createMockUIState();
  const ui = renderComposer(initial, config, actions);
  try {
    expect(ui.lastFrame()).toContain('/usage  /status  /upgrade  /logout');
    vi.mocked(InputPrompt).mock.calls.at(-1)![0].onSubmit('/auth');
    await vi.waitFor(() =>
      expect(ui.lastFrame()).not.toContain(
        '/usage  /status  /upgrade  /logout',
      ),
    );
    const withAuthHistory = createMockUIState({
      history: [{ id: 1, type: 'user', text: '/auth' }],
      userMessages: ['/auth'],
    });
    ui.rerender(composerElement(withAuthHistory, config, actions, false));
    await vi.waitFor(() => expect(ui.lastFrame()).toContain('Auth dialog'));
    expect(ui.lastFrame()).not.toContain('InputPrompt');
    ui.rerender(composerElement(withAuthHistory, config, actions, true));
    await vi.waitFor(() => expect(ui.lastFrame()).toContain('InputPrompt'));
    expect(ui.lastFrame()).not.toContain('/usage  /status  /upgrade  /logout');
  } finally {
    ui.unmount();
  }
});
