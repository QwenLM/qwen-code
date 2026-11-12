/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, vi } from 'vitest';
import { render } from 'ink-testing-library';
import { Text } from 'ink';
import { act } from 'react';
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

vi.mock('./KeyboardShortcuts.js', () => ({
  KeyboardShortcuts: () => <Text>KeyboardShortcuts</Text>,
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
  return (
    <ConfigContext.Provider value={config as unknown as Config}>
      <UIStateContext.Provider value={uiState}>
        <UIActionsContext.Provider value={uiActions}>
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

    it('keeps the footer mounted while messages are queued during a busy turn', () => {
      // #8666: isInputActive is false across the whole window a queued message
      // can exist in (approval-mode resets, slash-command processing,
      // WaitingForConfirmation). The footer holds the only always-on "N
      // queued" badge, so hiding it there leaves the queue invisible.
      const uiState = createMockUIState({
        isInputActive: false,
        isConfigInitialized: true,
        messageQueue: ['queued while busy'],
      });

      const { lastFrame } = renderComposer(uiState);

      expect(lastFrame()).toContain('Footer');
      expect(lastFrame()).toContain('queued while busy');
    });

    it('keeps the footer hidden when input is inactive and the queue is empty', () => {
      const uiState = createMockUIState({
        isInputActive: false,
        isConfigInitialized: true,
        messageQueue: [],
      });

      const { lastFrame } = renderComposer(uiState);

      expect(lastFrame()).not.toContain('Footer');
    });

    it('renders the footer rather than the shortcuts panel when a queued message mounts the slot with the input inactive', () => {
      // showShortcuts has one writer and nothing resets it when isInputActive
      // flips, so a panel left open would otherwise take the slot the queue
      // just mounted and hide the count this change exists for.
      const uiState = createMockUIState({
        isInputActive: true,
        isConfigInitialized: true,
      });

      const { lastFrame, rerender } = renderComposer(uiState);

      const inputPrompt = vi.mocked(InputPrompt);
      const firstProps = inputPrompt.mock.calls.at(-1)?.[0] as {
        onToggleShortcuts?: () => void;
      };
      // The premise is asserted: a later refactor that stops passing the prop
      // would otherwise make the case green without opening the panel at all.
      expect(firstProps.onToggleShortcuts).toBeDefined();
      act(() => firstProps.onToggleShortcuts!());
      expect(lastFrame()).toContain('KeyboardShortcuts');

      rerender(
        composerElement(
          createMockUIState({
            isInputActive: false,
            isConfigInitialized: true,
            messageQueue: ['queued'],
          }),
        ),
      );

      expect(lastFrame()).toContain('Footer');
      expect(lastFrame()).not.toContain('KeyboardShortcuts');
    });

    it('keeps the shortcuts panel reachable while the input is active', () => {
      // The mirror of the suppression case: an inverted or collapsed ternary
      // would make the panel unreachable in every state and leave the rest of
      // the suite green.
      const uiState = createMockUIState({
        isInputActive: true,
        isConfigInitialized: true,
      });

      const { lastFrame } = renderComposer(uiState);

      const inputPrompt = vi.mocked(InputPrompt);
      const props = inputPrompt.mock.calls.at(-1)?.[0] as {
        onToggleShortcuts?: () => void;
      };
      expect(props.onToggleShortcuts).toBeDefined();
      act(() => props.onToggleShortcuts!());

      expect(lastFrame()).toContain('KeyboardShortcuts');
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

    it('hides the narrow cancel hint while command cancellation is blocked', () => {
      const uiState = createMockUIState({
        streamingState: StreamingState.Responding,
        terminalWidth: 25,
        commandCancellationBlocked: true,
      });

      expect(renderComposer(uiState).lastFrame()).not.toContain(
        'Esc to cancel',
      );
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

it.each<{ history: UIState['history'] }>([
  { history: [] },
  { history: [{ id: 1, type: MessageType.USER, text: '/auth' }] },
])(
  'keeps the subscription placeholder without the command hint row (%j)',
  ({ history }) => {
    const actions = createMockUIActions();
    const ui = renderComposer(
      createMockUIState({ history }),
      createMockConfig({ getAuthType: () => 'qwen-subscription' }),
      actions,
    );
    try {
      expect(ui.lastFrame()).not.toContain('Try:');
      expect(ui.lastFrame()).not.toContain(
        '/usage  /status  /upgrade  /logout',
      );
      expect(ui.lastFrame()).toContain('Footer');
      const props = vi.mocked(InputPrompt).mock.calls.at(-1)![0];
      expect(props.placeholder).toBe('  Type your request, or /usage');
      const options = { deferUntilIdle: true, submittedPrompt: '/usage' };
      props.onSubmit('/usage', options);
      expect(actions.handleFinalSubmit).toHaveBeenCalledWith('/usage', options);
    } finally {
      ui.unmount();
    }
  },
);
