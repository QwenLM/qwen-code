/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { renderWithProviders } from '../../test-utils/render.js';
import { StatusNode, StatusRow } from './StatusRow.js';
import { describe, it, expect, vi, beforeEach, type Mock } from 'vitest';
import { useComposerStatus } from '../hooks/useComposerStatus.js';
import { type UIState } from '../contexts/UIStateContext.js';
import { type PendingHistoryValue } from '../contexts/PendingHistoryContext.js';

import { type SessionStatsState } from '../contexts/SessionContext.js';
import { StreamingState } from '../types.js';
import { Box, Text } from 'ink';
import { act, useState } from 'react';
import { createMockSettings } from '../../test-utils/settings.js';

vi.mock('../hooks/useComposerStatus.js', () => ({
  useComposerStatus: vi.fn(),
}));

let mockStatusText = 'Try /effort or /context-window to adjust model settings';
let updateMockStatusText: ((text: string) => void) | undefined;

vi.mock('./StatusDisplay.js', () => ({
  StatusDisplay: () => {
    const [statusText, setStatusText] = useState(mockStatusText);
    updateMockStatusText = setStatusText;
    return (
      <Box height={1} paddingX={1} overflow="hidden">
        <Text wrap="truncate-end">{statusText}</Text>
      </Box>
    );
  },
}));

describe('<StatusRow />', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockStatusText = 'Try /effort or /context-window to adjust model settings';
    updateMockStatusText = undefined;
  });

  const defaultUiState: Partial<UIState> & Partial<PendingHistoryValue> = {
    currentTip: undefined,
    thought: null,
    activeModelQueue: null,
    elapsedTime: 0,
    currentWittyPhrase: undefined,
    isCommandProgressActive: false,
    activeHooks: [],
    sessionStats: { lastPromptTokenCount: 0 } as unknown as SessionStatsState,
    shortcutsHelpVisible: false,
    contextFileNames: [],
    showPermissionModeIndicator: 'default',
    allowPlanMode: false,
    renderMarkdown: true,
    currentModel: 'gemini-3',
    isResuming: false,
  };

  it('localizes the real row-2 shell and raw-markdown indicators', async () => {
    (useComposerStatus as Mock).mockReturnValue({
      showLoadingIndicator: false,
      showTips: false,
      showWit: false,
      modeContentObj: null,
      showMinimalContext: false,
    });
    const settings = createMockSettings({
      user: {
        path: '/read-only/settings.json',
        settings: { ui: { language: 'zh-CN' } },
        originalSettings: { ui: { language: 'zh-CN' } },
        readOnly: true,
      },
    });
    const { lastFrame, waitUntilReady, unmount } = await renderWithProviders(
      <StatusRow
        showUiDetails
        isNarrow={false}
        terminalWidth={120}
        hideContextSummary={false}
        hideUiDetailsForSuggestions={false}
        hasPendingActionRequired={false}
      />,
      {
        width: 120,
        settings,
        uiState: {
          ...defaultUiState,
          renderMarkdown: false,
          streamingState: StreamingState.Idle,
        },
        inputState: { shellModeActive: true },
      },
    );

    await waitUntilReady();
    expect(lastFrame()).toContain('Shell 模式已启用');
    expect(lastFrame()).toContain('原始 Markdown 模式');
    expect(lastFrame()).toMatch(/Option\+M|Alt\+M/);
    unmount();
  });

  it.each([
    {
      mode: 'default' as const,
      expected: '按 Shift+Tab 切换到接受编辑',
    },
    {
      mode: 'auto' as const,
      expected: '自动模式 按 Shift+Tab 切换到不再询问',
    },
  ])(
    'localizes the normal permission row for $mode mode',
    async ({ mode, expected }) => {
      (useComposerStatus as Mock).mockReturnValue({
        showLoadingIndicator: false,
        showTips: false,
        showWit: false,
        modeContentObj: null,
        showMinimalContext: false,
      });
      const settings = createMockSettings({
        user: {
          path: '/read-only/settings.json',
          settings: { ui: { language: 'zh-CN' } },
          originalSettings: { ui: { language: 'zh-CN' } },
          readOnly: true,
        },
      });
      const { lastFrame, waitUntilReady, unmount } = await renderWithProviders(
        <StatusRow
          showUiDetails
          isNarrow={false}
          terminalWidth={120}
          hideContextSummary={false}
          hideUiDetailsForSuggestions={false}
          hasPendingActionRequired={false}
        />,
        {
          width: 120,
          settings,
          uiState: {
            ...defaultUiState,
            showPermissionModeIndicator: mode,
            streamingState: StreamingState.Idle,
          },
          inputState: { shellModeActive: false },
        },
      );

      await waitUntilReady();
      expect(lastFrame()).toContain(expected);
      unmount();
    },
  );

  it('renders the localized context label through the minimal StatusRow branch', async () => {
    (useComposerStatus as Mock).mockReturnValue({
      showLoadingIndicator: false,
      showTips: false,
      showWit: false,
      modeContentObj: null,
      showMinimalContext: true,
    });
    const settings = createMockSettings({
      user: {
        path: '/read-only/settings.json',
        settings: { ui: { language: 'zh-CN' } },
        originalSettings: { ui: { language: 'zh-CN' } },
        readOnly: true,
      },
    });
    const { lastFrame, waitUntilReady, unmount } = await renderWithProviders(
      <StatusRow
        showUiDetails={false}
        isNarrow={false}
        terminalWidth={120}
        hideContextSummary={false}
        hideUiDetailsForSuggestions={false}
        hasPendingActionRequired={false}
      />,
      {
        width: 120,
        settings,
        uiState: {
          ...defaultUiState,
          sessionStats: {
            lastPromptTokenCount: 64_000,
          } as unknown as SessionStatsState,
          streamingState: StreamingState.Idle,
        },
      },
    );

    await waitUntilReady();
    expect(lastFrame()).toContain('已使用');
    expect(lastFrame()).toContain('%');
    unmount();
  });

  it.each([
    {
      suppressed: false,
      expected: 'Dynamic workflow requested for this turn · Option+W to ignore',
    },
    {
      suppressed: true,
      expected: 'Ultracode keyword ignored for this prompt · Option+W to undo',
    },
  ])('renders the UltraCode status in the tip slot', async (status) => {
    (useComposerStatus as Mock).mockReturnValue({
      showLoadingIndicator: false,
      showTips: true,
      showWit: false,
      modeContentObj: null,
      showMinimalContext: false,
    });

    const { lastFrame, waitUntilReady } = await renderWithProviders(
      <StatusRow
        showUiDetails={true}
        isNarrow={false}
        terminalWidth={180}
        hideContextSummary={false}
        hideUiDetailsForSuggestions={false}
        hasPendingActionRequired={false}
        workflowKeywordStatus={{
          suppressed: status.suppressed,
          shortcut: 'Option+W',
        }}
      />,
      {
        width: 180,
        uiState: {
          ...defaultUiState,
          currentTip: 'A lower-priority generic tip',
          streamingState: StreamingState.Idle,
        },
      },
    );

    await waitUntilReady();
    expect(lastFrame()).toContain(status.expected);
    expect(lastFrame()).not.toContain('A lower-priority generic tip');
  });

  it('keeps transient messages above the UltraCode status', async () => {
    (useComposerStatus as Mock).mockReturnValue({
      showLoadingIndicator: false,
      showTips: false,
      showWit: false,
      modeContentObj: null,
      showMinimalContext: false,
    });

    const { lastFrame, waitUntilReady } = await renderWithProviders(
      <StatusRow
        showUiDetails={true}
        isNarrow={false}
        terminalWidth={180}
        hideContextSummary={false}
        hideUiDetailsForSuggestions={false}
        hasPendingActionRequired={false}
        workflowKeywordStatus={{ suppressed: false, shortcut: 'Option+W' }}
      />,
      {
        width: 180,
        uiState: {
          ...defaultUiState,
          ctrlCPressedOnce: true,
          streamingState: StreamingState.Idle,
        },
      },
    );

    await waitUntilReady();
    expect(lastFrame()).toContain('Ctrl+C exit again to exit.');
    expect(lastFrame()).not.toContain('Dynamic workflow requested');
  });

  it('renders generic thinking text without the thought subject', async () => {
    (useComposerStatus as Mock).mockReturnValue({
      showLoadingIndicator: true,
      showTips: false,
      showWit: false,
      modeContentObj: null,
      showMinimalContext: false,
    });

    const uiState: Partial<UIState> & Partial<PendingHistoryValue> = {
      ...defaultUiState,
      thought: {
        subject: 'Dynamic subject must not be displayed',
        description: 'Thinking details remain available in history.',
      },
      streamingState: StreamingState.Responding,
      elapsedTime: 5,
    };

    const { lastFrame, waitUntilReady } = await renderWithProviders(
      <StatusRow
        showUiDetails={false}
        isNarrow={false}
        terminalWidth={100}
        hideContextSummary={false}
        hideUiDetailsForSuggestions={false}
        hasPendingActionRequired={false}
      />,
      {
        width: 100,
        uiState,
      },
    );

    await waitUntilReady();
    const output = lastFrame();
    expect(output).toContain('Thinking...');
    expect(output).not.toContain('Dynamic subject must not be displayed');
  });

  it('renders generating text before reasoning starts', async () => {
    (useComposerStatus as Mock).mockReturnValue({
      showLoadingIndicator: true,
      showTips: false,
      showWit: false,
      modeContentObj: null,
      showMinimalContext: false,
    });

    const { lastFrame, waitUntilReady } = await renderWithProviders(
      <StatusRow
        showUiDetails={false}
        isNarrow={false}
        terminalWidth={100}
        hideContextSummary={false}
        hideUiDetailsForSuggestions={false}
        hasPendingActionRequired={false}
      />,
      {
        width: 100,
        uiState: {
          ...defaultUiState,
          streamingState: StreamingState.Responding,
        },
      },
    );

    await waitUntilReady();
    const output = lastFrame();
    expect(output.split('\n')[0]).toBe('');
    expect(output.split('\n')[1]).toContain('Generating...');
    expect(output).toContain('Generating...');
    expect(output).not.toContain('Thinking...');
  });

  it.each([60, 80, 120])(
    'localizes the active model status and cancel hint at %i columns',
    async (width) => {
      (useComposerStatus as Mock).mockReturnValue({
        showLoadingIndicator: true,
        showTips: false,
        showWit: false,
        modeContentObj: null,
        showMinimalContext: false,
      });
      const settings = createMockSettings({
        user: {
          path: '/read-only/settings.json',
          settings: { ui: { language: 'zh-CN' } },
          originalSettings: { ui: { language: 'zh-CN' } },
          readOnly: true,
        },
      });

      const { lastFrame, waitUntilReady, unmount } = await renderWithProviders(
        <StatusRow
          showUiDetails={false}
          isNarrow={width === 60}
          terminalWidth={width}
          hideContextSummary={false}
          hideUiDetailsForSuggestions={false}
          hasPendingActionRequired={false}
        />,
        {
          width,
          settings,
          uiState: {
            ...defaultUiState,
            streamingState: StreamingState.Responding,
            elapsedTime: 5,
          },
        },
      );

      await waitUntilReady();
      const output = lastFrame();
      expect(output).toContain('正在生成...');
      expect(output).toContain('按 esc 取消');
      expect(output).not.toContain('Generating...');
      expect(output).not.toContain('esc to cancel');
      unmount();
    },
  );

  it('replaces generating with a multi-line model queue phase', async () => {
    (useComposerStatus as Mock).mockReturnValue({
      showLoadingIndicator: true,
      showTips: false,
      showWit: false,
      modeContentObj: null,
      showMinimalContext: false,
    });

    const { lastFrame, waitUntilReady } = await renderWithProviders(
      <StatusRow
        showUiDetails={false}
        isNarrow={false}
        terminalWidth={100}
        hideContextSummary={false}
        hideUiDetailsForSuggestions={false}
        hasPendingActionRequired={false}
      />,
      {
        width: 100,
        uiState: {
          ...defaultUiState,
          streamingState: StreamingState.Responding,
          elapsedTime: 273,
          activeModelQueue: {
            status: 'queued',
            requestSetId: 'set-1',
            waitTimeMs: 90_000,
            progress: 55,
          },
        },
      },
    );

    await waitUntilReady();
    const output = lastFrame();
    const contentLines = output
      .split('\n')
      .filter((line) => line.trim().length > 0);
    expect(contentLines).toHaveLength(3);
    expect(contentLines[0]).toContain('Model request queued');
    expect(contentLines[0]).toContain('(esc to cancel, 4m 33s)');
    expect(contentLines[1]).toContain('████');
    expect(contentLines[1]).toContain('moving');
    expect(contentLines[2]).toContain('estimated wait 1min');
    expect(output).not.toContain('Generating...');
  });

  it('keeps the progress rows while the queued model becomes ready', async () => {
    (useComposerStatus as Mock).mockReturnValue({
      showLoadingIndicator: true,
      showTips: false,
      showWit: false,
      modeContentObj: null,
      showMinimalContext: false,
    });

    const { lastFrame, waitUntilReady } = await renderWithProviders(
      <StatusRow
        showUiDetails={false}
        isNarrow={false}
        terminalWidth={100}
        hideContextSummary={false}
        hideUiDetailsForSuggestions={false}
        hasPendingActionRequired={false}
      />,
      {
        width: 100,
        uiState: {
          ...defaultUiState,
          streamingState: StreamingState.Responding,
          elapsedTime: 275,
          activeModelQueue: {
            status: 'ready',
            requestSetId: 'set-1',
            waitTimeMs: 90_000,
            progress: 100,
          },
        },
      },
    );

    await waitUntilReady();
    const output = lastFrame();
    const contentLines = output
      .split('\n')
      .filter((line) => line.trim().length > 0);
    expect(contentLines).toHaveLength(3);
    expect(contentLines[0]).toContain('Model is available');
    expect(contentLines[1]).toContain('██████████');
    expect(contentLines[1]).toContain('ready');
    expect(contentLines[2]).toContain('Continuing request...');
    expect(output).not.toContain('Generating...');
  });

  it('keeps model queue progress ahead of every competing progress phase', async () => {
    (useComposerStatus as Mock).mockReturnValue({
      showLoadingIndicator: true,
      showTips: false,
      showWit: false,
      modeContentObj: null,
      showMinimalContext: false,
    });

    const { lastFrame, waitUntilReady } = await renderWithProviders(
      <StatusRow
        showUiDetails={false}
        isNarrow={false}
        terminalWidth={100}
        hideContextSummary={false}
        hideUiDetailsForSuggestions={false}
        hasPendingActionRequired={false}
      />,
      {
        width: 100,
        uiState: {
          ...defaultUiState,
          streamingState: StreamingState.Responding,
          activeModelQueue: {
            status: 'queued',
            requestSetId: 'set-1',
            waitTimeMs: 90_000,
            progress: 55,
          },
          isResuming: true,
          compressionProgress: {
            stage: 'summarizing',
            label: 'Compacting conversation…',
            percent: 24,
            tone: 'active',
          },
          isCommandProgressActive: true,
          currentLoadingPhrase: 'Loading commands...',
          activeHooks: [
            {
              eventName: 'PreToolUse',
              index: 1,
              total: 1,
              statusMessage: 'Checking',
              settled: false,
            },
          ],
        },
      },
    );

    await waitUntilReady();
    const output = lastFrame();
    expect(output).toContain('Model request queued');
    expect(output).toContain('moving');
    expect(output).not.toContain('Resuming session...');
    expect(output).not.toContain('Compacting conversation…');
    expect(output).not.toContain('Loading commands...');
    expect(output).not.toContain('Checking…');
    expect(output).not.toContain('Generating...');
  });

  it('keeps model queue progress instead of a colliding toast', async () => {
    (useComposerStatus as Mock).mockReturnValue({
      showLoadingIndicator: true,
      showTips: false,
      showWit: false,
      modeContentObj: null,
      showMinimalContext: false,
    });

    const { lastFrame, waitUntilReady } = await renderWithProviders(
      <StatusRow
        showUiDetails={false}
        isNarrow={true}
        terminalWidth={32}
        hideContextSummary={false}
        hideUiDetailsForSuggestions={false}
        hasPendingActionRequired={false}
      />,
      {
        width: 32,
        uiState: {
          ...defaultUiState,
          streamingState: StreamingState.Responding,
          queueErrorMessage: 'Queue failed',
          activeModelQueue: {
            status: 'queued',
            requestSetId: 'set-1',
            waitTimeMs: 90_000,
            progress: 55,
          },
        },
      },
    );

    await waitUntilReady();
    const output = lastFrame();
    expect(output).toContain('Model queued');
    expect(output).toContain('moving');
    expect(output).not.toContain('Queue failed');
  });

  it('uses the foreground status lane while resuming', async () => {
    (useComposerStatus as Mock).mockReturnValue({
      showLoadingIndicator: false,
      showTips: false,
      showWit: false,
      modeContentObj: null,
      showMinimalContext: false,
    });

    const { lastFrame, waitUntilReady } = await renderWithProviders(
      <StatusRow
        showUiDetails={false}
        isNarrow={false}
        terminalWidth={100}
        hideContextSummary={false}
        hideUiDetailsForSuggestions={false}
        hasPendingActionRequired={false}
      />,
      {
        width: 100,
        uiState: {
          ...defaultUiState,
          isResuming: true,
          streamingState: StreamingState.Idle,
        },
      },
    );

    await waitUntilReady();
    expect(lastFrame()).toContain('Resuming session...');
    expect(lastFrame()).not.toContain('Thinking...');
    expect(lastFrame()).not.toContain('Generating...');
  });

  it('keeps hook and command progress ahead of the model phase', async () => {
    (useComposerStatus as Mock).mockReturnValue({
      showLoadingIndicator: true,
      showTips: false,
      showWit: false,
      modeContentObj: null,
      showMinimalContext: false,
    });

    const { lastFrame, waitUntilReady } = await renderWithProviders(
      <StatusRow
        showUiDetails={false}
        isNarrow={false}
        terminalWidth={100}
        hideContextSummary={false}
        hideUiDetailsForSuggestions={false}
        hasPendingActionRequired={false}
      />,
      {
        width: 100,
        uiState: {
          ...defaultUiState,
          streamingState: StreamingState.Responding,
          isCommandProgressActive: true,
          currentLoadingPhrase: 'Loading commands...',
          thought: { subject: 'Reasoning', description: '' },
          activeHooks: [
            {
              eventName: 'PreToolUse',
              index: 1,
              total: 1,
              statusMessage: 'Checking',
              settled: false,
            },
          ],
        },
      },
    );

    await waitUntilReady();
    const output = lastFrame();
    expect(output).toContain('Checking…');
    expect(output).not.toContain('Loading commands...');
    expect(output).not.toContain('Thinking...');
  });

  it('labels final hook batch elapsed separately from the total task elapsed', async () => {
    const startedAt = Date.now() - 5000;
    const view = await renderWithProviders(
      <StatusNode
        showTips={false}
        showWit={false}
        elapsedTime={273}
        currentWittyPhrase={undefined}
        activeHooks={[
          {
            eventName: 'PreToolUse',
            index: 1,
            total: 1,
            settled: true,
            batchStartedAt: startedAt,
            batchEndedAt: startedAt + 2100,
          },
        ]}
        showLoadingIndicator
        errorVerbosity={undefined}
      />,
      { width: 120, uiState: { streamingState: StreamingState.Responding } },
    );
    await view.waitUntilReady();
    expect(view.lastFrame()).toContain(
      'Running PreToolUse hook… · Hook batch 2s',
    );
    expect(view.lastFrame()).toContain('(esc to cancel, 4m 33s)');
    view.unmount();
  });

  it('keeps ordinary tips visible while Thinking', async () => {
    (useComposerStatus as Mock).mockReturnValue({
      showLoadingIndicator: true,
      showTips: true,
      showWit: false,
      modeContentObj: null,
      showMinimalContext: false,
    });
    const { lastFrame, waitUntilReady, unmount } = await renderWithProviders(
      <StatusRow
        showUiDetails={false}
        isNarrow={false}
        terminalWidth={120}
        hideContextSummary={false}
        hideUiDetailsForSuggestions={false}
        hasPendingActionRequired={false}
      />,
      {
        width: 120,
        uiState: {
          ...defaultUiState,
          currentTip: 'Ordinary local tip',
          thought: { subject: 'Reasoning', description: '' },
          streamingState: StreamingState.Responding,
          isModelTurnActive: true,
        },
      },
    );
    await waitUntilReady();
    expect(lastFrame()).toContain('Thinking...');
    expect(lastFrame()).toContain('Ordinary local tip');
    unmount();
  });

  it('renders compression phase progress without thoughts, tips, or token counts', async () => {
    (useComposerStatus as Mock).mockReturnValue({
      showLoadingIndicator: true,
      showTips: true,
      showWit: true,
      modeContentObj: null,
      showMinimalContext: false,
    });

    const { lastFrame, waitUntilReady } = await renderWithProviders(
      <StatusRow
        showUiDetails={false}
        isNarrow={false}
        terminalWidth={100}
        hideContextSummary={false}
        hideUiDetailsForSuggestions={false}
        hasPendingActionRequired={false}
      />,
      {
        width: 100,
        uiState: {
          ...defaultUiState,
          currentTip: 'Test Tip',
          thought: {
            subject: 'Dynamic subject must not be displayed',
            description: 'Thinking details remain available in history.',
          },
          compressionProgress: {
            stage: 'summarizing',
            label: 'Compacting conversation…',
            percent: 24,
            tone: 'active',
          },
        },
      },
    );

    await waitUntilReady();
    const output = lastFrame();
    expect(output).toContain('Compacting conversation…');
    expect(output).toContain('24%');
    expect(output).not.toContain('Thinking...');
    expect(output).not.toContain('Generating...');
    expect(output).not.toContain('Tip:');
    expect(output).not.toMatch(/tokens?/i);
  });

  it('renders compression progress on one line in narrow mode', async () => {
    (useComposerStatus as Mock).mockReturnValue({
      showLoadingIndicator: true,
      showTips: true,
      showWit: true,
      modeContentObj: null,
      showMinimalContext: false,
    });

    const { lastFrame, waitUntilReady } = await renderWithProviders(
      <StatusRow
        showUiDetails={false}
        isNarrow={true}
        terminalWidth={40}
        hideContextSummary={false}
        hideUiDetailsForSuggestions={false}
        hasPendingActionRequired={false}
      />,
      {
        width: 40,
        uiState: {
          ...defaultUiState,
          compressionProgress: {
            stage: 'post_processing',
            label: 'Applying compacted context…',
            percent: 90,
            tone: 'active',
          },
        },
      },
    );

    await waitUntilReady();
    const contentLines = lastFrame()
      .split('\n')
      .filter((line) => line.trim().length > 0);
    expect(contentLines.filter((line) => line.includes('90%'))).toHaveLength(1);
    expect(contentLines).toHaveLength(1);
  });

  it('renders tip with absolute positioning when it fits but might collide (verification of container logic)', async () => {
    (useComposerStatus as Mock).mockReturnValue({
      showLoadingIndicator: false,
      showTips: true,
      showWit: true,
      modeContentObj: null,
      showMinimalContext: false,
    });

    const uiState: Partial<UIState> = {
      ...defaultUiState,
      currentTip: 'Test Tip',
    };

    const { lastFrame, waitUntilReady } = await renderWithProviders(
      <StatusRow
        showUiDetails={false}
        isNarrow={false}
        terminalWidth={120}
        hideContextSummary={false}
        hideUiDetailsForSuggestions={false}
        hasPendingActionRequired={false}
      />,
      {
        width: 120,
        uiState,
      },
    );

    await waitUntilReady();
    expect(lastFrame()).toContain('Tip: Test Tip');
  });

  it('shows a transient exit message even in narrow mode', async () => {
    (useComposerStatus as Mock).mockReturnValue({
      showLoadingIndicator: false,
      showTips: false,
      showWit: false,
      modeContentObj: null,
      showMinimalContext: false,
    });

    const { lastFrame, waitUntilReady } = await renderWithProviders(
      <StatusRow
        showUiDetails={true}
        isNarrow={true}
        terminalWidth={40}
        hideContextSummary={false}
        hideUiDetailsForSuggestions={false}
        hasPendingActionRequired={false}
      />,
      {
        width: 40,
        uiState: {
          ...defaultUiState,
          ctrlCPressedOnce: true,
        },
      },
    );

    await waitUntilReady();
    expect(lastFrame()).toContain('Ctrl+C exit again to exit.');
  });

  it('keeps the shortcut hint visible in narrow mode when it fits', async () => {
    (useComposerStatus as Mock).mockReturnValue({
      showLoadingIndicator: false,
      showTips: false,
      showWit: false,
      modeContentObj: null,
      showMinimalContext: false,
    });

    const { lastFrame, waitUntilReady } = await renderWithProviders(
      <StatusRow
        showUiDetails={true}
        isNarrow={true}
        terminalWidth={40}
        hideContextSummary={false}
        hideUiDetailsForSuggestions={false}
        hasPendingActionRequired={false}
      />,
      {
        width: 40,
        uiState: defaultUiState,
      },
    );

    await waitUntilReady();
    expect(lastFrame()).toContain('? for shortcuts');
  });

  it.each([
    {
      name: 'Escape',
      uiState: {
        history: [{ id: 1, type: 'user', text: 'test' }],
      } as Partial<UIState>,
      inputState: { showEscapePrompt: true },
      expected: 'Esc again to rewind.',
    },
    {
      name: 'transcript',
      uiState: { showIsExpandableHint: true } as Partial<UIState>,
      inputState: {},
      expected: 'Press Ctrl+O to view detailed transcript',
    },
  ])(
    'shows the $name hint in narrow mode',
    async ({ uiState, inputState, expected }) => {
      (useComposerStatus as Mock).mockReturnValue({
        showLoadingIndicator: false,
        showTips: false,
        showWit: false,
        modeContentObj: null,
        showMinimalContext: false,
      });

      const { lastFrame, waitUntilReady } = await renderWithProviders(
        <StatusRow
          showUiDetails={true}
          isNarrow={true}
          terminalWidth={60}
          hideContextSummary={false}
          hideUiDetailsForSuggestions={false}
          hasPendingActionRequired={false}
        />,
        {
          width: 60,
          uiState: { ...defaultUiState, ...uiState },
          inputState,
        },
      );

      await waitUntilReady();
      expect(lastFrame()).toContain(expected);
    },
  );

  it('keeps progress beside the transcript hint when the row is wide enough', async () => {
    (useComposerStatus as Mock).mockReturnValue({
      showLoadingIndicator: true,
      showTips: false,
      showWit: false,
      modeContentObj: null,
      showMinimalContext: false,
    });

    const { lastFrame, waitUntilReady } = await renderWithProviders(
      <StatusRow
        showUiDetails={true}
        isNarrow={false}
        terminalWidth={160}
        hideContextSummary={false}
        hideUiDetailsForSuggestions={false}
        hasPendingActionRequired={false}
      />,
      {
        width: 160,
        uiState: {
          ...defaultUiState,
          streamingState: StreamingState.Responding,
          showIsExpandableHint: true,
        },
      },
    );

    await waitUntilReady();
    const output = lastFrame();
    expect(output).toContain('Generating...');
    expect(output).toContain('Press Ctrl+O to view detailed transcript');
  });

  it('gives a transient message priority when it collides with progress', async () => {
    (useComposerStatus as Mock).mockReturnValue({
      showLoadingIndicator: true,
      showTips: false,
      showWit: false,
      modeContentObj: null,
      showMinimalContext: false,
    });

    const { lastFrame, waitUntilReady } = await renderWithProviders(
      <StatusRow
        showUiDetails={false}
        isNarrow={true}
        terminalWidth={32}
        hideContextSummary={false}
        hideUiDetailsForSuggestions={false}
        hasPendingActionRequired={false}
      />,
      {
        width: 32,
        uiState: {
          ...defaultUiState,
          streamingState: StreamingState.Responding,
          isCommandProgressActive: true,
          currentLoadingPhrase: 'A very long running operation',
          queueErrorMessage: 'Queue failed',
        },
      },
    );

    await waitUntilReady();
    const output = lastFrame();
    expect(output).toContain('Queue failed');
    expect(output).not.toContain('A very long running operation');
  });

  it('keeps the permission hint and rotating status on one line', async () => {
    (useComposerStatus as Mock).mockReturnValue({
      showLoadingIndicator: false,
      showTips: false,
      showWit: false,
      modeContentObj: null,
      showMinimalContext: false,
    });

    const statusRow = (
      <StatusRow
        showUiDetails={true}
        isNarrow={false}
        terminalWidth={80}
        hideContextSummary={false}
        hideUiDetailsForSuggestions={false}
        hasPendingActionRequired={false}
      />
    );
    const { lastFrame, waitUntilReady, unmount } = await renderWithProviders(
      statusRow,
      {
        width: 80,
        uiState: defaultUiState,
      },
    );

    await waitUntilReady();
    const longFrame = lastFrame();
    const statusLine = longFrame
      .split('\n')
      .find((line) => line.includes('Shift+Tab'));
    expect(statusLine).toContain('Shift+Tab to Accept Edits');
    expect(statusLine).toMatch(/Try .*…$/);

    const longHeight = longFrame.split('\n').length;
    unmount();
    mockStatusText = 'Short status';
    const shortRender = await renderWithProviders(statusRow, {
      width: 80,
      uiState: defaultUiState,
    });
    await shortRender.waitUntilReady();
    const shortFrame = shortRender.lastFrame();
    const shortStatusLine = shortFrame
      .split('\n')
      .find((line) => line.includes('Shift+Tab'));
    expect(shortStatusLine).toContain('Shift+Tab to Accept Edits');
    expect(shortStatusLine?.indexOf('Short status')).toBe(67);
    expect(shortFrame.split('\n')).toHaveLength(longHeight);
  });

  it('does not grow when the rotating status changes from short to long', async () => {
    (useComposerStatus as Mock).mockReturnValue({
      showLoadingIndicator: false,
      showTips: false,
      showWit: false,
      modeContentObj: null,
      showMinimalContext: false,
    });

    const uiState: Partial<UIState> = {
      ...defaultUiState,
      showPermissionModeIndicator: 'auto',
    };
    const statusRow = () => (
      <StatusRow
        showUiDetails={true}
        isNarrow={false}
        terminalWidth={80}
        hideContextSummary={false}
        hideUiDetailsForSuggestions={false}
        hasPendingActionRequired={false}
      />
    );

    mockStatusText = 'Try /model to switch models';
    const { lastFrame, waitUntilReady } = await renderWithProviders(
      statusRow(),
      { width: 80, uiState },
    );
    await waitUntilReady();
    const shortFrame = lastFrame().trimEnd();
    expect(shortFrame).toContain("Auto Mode Shift+Tab to Don't Ask");
    const shortHeight = shortFrame.split('\n').length;

    await act(async () => {
      updateMockStatusText?.(
        'Try /effort or /context-window to adjust model settings',
      );
    });
    await waitUntilReady();
    const longFrame = lastFrame().trimEnd();
    expect(longFrame.split('\n')).toHaveLength(shortHeight);
    expect(longFrame).toContain("Auto Mode Shift+Tab to Don't Ask");
    expect(longFrame).toMatch(/Try .*…$/);
  });

  it('keeps its height when model progress stops', async () => {
    const statusRow = (
      <StatusRow
        showUiDetails={true}
        isNarrow={false}
        terminalWidth={80}
        hideContextSummary={false}
        hideUiDetailsForSuggestions={false}
        hasPendingActionRequired={false}
      />
    );

    (useComposerStatus as Mock).mockReturnValue({
      showLoadingIndicator: true,
      showTips: false,
      showWit: false,
      modeContentObj: null,
      showMinimalContext: false,
    });

    const activeRender = await renderWithProviders(statusRow, {
      width: 80,
      uiState: {
        ...defaultUiState,
        streamingState: StreamingState.Responding,
      },
    });
    await activeRender.waitUntilReady();
    const activeFrame = activeRender.lastFrame();
    const activeHeight = activeFrame.split('\n').length;
    expect(activeFrame.split('\n')[0]).toBe('');
    expect(activeFrame).toContain('Generating...');
    activeRender.unmount();

    (useComposerStatus as Mock).mockReturnValue({
      showLoadingIndicator: false,
      showTips: false,
      showWit: false,
      modeContentObj: null,
      showMinimalContext: false,
    });

    const idleRender = await renderWithProviders(statusRow, {
      width: 80,
      uiState: {
        ...defaultUiState,
        streamingState: StreamingState.Idle,
      },
    });
    await idleRender.waitUntilReady();
    const idleFrame = idleRender.lastFrame();
    expect(idleFrame.split('\n')[0]).toBe('');
    expect(idleFrame).not.toContain('Generating...');
    expect(idleFrame.split('\n')).toHaveLength(activeHeight);
  });

  it('never wraps the permission hint or rotating status on narrow screens', async () => {
    (useComposerStatus as Mock).mockReturnValue({
      showLoadingIndicator: false,
      showTips: false,
      showWit: false,
      modeContentObj: null,
      showMinimalContext: false,
    });

    const { lastFrame, waitUntilReady } = await renderWithProviders(
      <StatusRow
        showUiDetails={true}
        isNarrow={true}
        terminalWidth={40}
        hideContextSummary={false}
        hideUiDetailsForSuggestions={false}
        hasPendingActionRequired={false}
      />,
      {
        width: 40,
        uiState: defaultUiState,
      },
    );

    await waitUntilReady();
    const contentLines = lastFrame()
      .split('\n')
      .filter((line) => line.trim().length > 0);
    expect(contentLines.filter((line) => line.includes('Shift+Tab'))).toEqual([
      expect.stringContaining('Shift+Tab to Accept Edits'),
    ]);
    expect(contentLines.filter((line) => line.includes('Try '))).toEqual([
      expect.stringMatching(/Try .*…$/),
    ]);
  });
});
