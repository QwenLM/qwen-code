/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { render } from 'ink-testing-library';
import { act } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AgentStatus, ApprovalMode } from '@qwen-code/qwen-code-core';
import {
  useAgentViewActions,
  useAgentViewState,
} from '../../contexts/AgentViewContext.js';
import {
  ContextMenuProvider,
  useContextMenu,
  type ContextMenuContextValue,
} from '../../context-menu/ContextMenuContext.js';
import { useConfig } from '../../contexts/ConfigContext.js';
import { useAgentStreamingState } from '../../hooks/useAgentStreamingState.js';
import { useKeypress, type Key } from '../../hooks/useKeypress.js';
import { usePreferredEditor } from '../../hooks/usePreferredEditor.js';
import { useTerminalSize } from '../../hooks/useTerminalSize.js';
import { StreamingState } from '../../types.js';
import { useTextBuffer } from '../shared/text-buffer.js';
import { AgentComposer } from './AgentComposer.js';

vi.mock('../../contexts/AgentViewContext.js');
vi.mock('../../contexts/ConfigContext.js');
vi.mock('../../hooks/useAgentStreamingState.js');
vi.mock('../../hooks/useKeypress.js');
vi.mock('../../hooks/usePreferredEditor.js');
vi.mock('../../hooks/useTerminalSize.js');
vi.mock('../shared/text-buffer.js');
// Capture the props instead of dropping them: `onKeypress` is the seam where
// the composer decides whether BaseTextInput may act on a key.
const { baseTextInputProps } = vi.hoisted(() => ({
  baseTextInputProps: {} as {
    onKeypress?: (key: Key) => boolean;
    onSubmit?: (text: string) => void;
  },
}));
vi.mock('../BaseTextInput.js', () => ({
  BaseTextInput: (props: {
    onKeypress?: (key: Key) => boolean;
    onSubmit?: (text: string) => void;
  }) => {
    baseTextInputProps.onKeypress = props.onKeypress;
    baseTextInputProps.onSubmit = props.onSubmit;
    return null;
  },
}));
vi.mock('../LoadingIndicator.js', () => ({ LoadingIndicator: () => null }));
vi.mock('../QueuedMessageDisplay.js', () => ({
  QueuedMessageDisplay: () => null,
}));
vi.mock('./AgentFooter.js', () => ({ AgentFooter: () => null }));

type KeypressHandler = (key: Key) => void;

// `AgentComposer` calls useKeypress twice per render, in a fixed order:
// [0] Escape-to-cancel, [1] Shift+Tab approval-mode cycler.
const ESCAPE_CANCEL = 0;
const SHIFT_TAB_CYCLE = 1;

const MenuProbe = () => {
  menuApi = useContextMenu();
  return null;
};
let menuApi: ContextMenuContextValue | null = null;

const renderWithMenu = () =>
  render(
    <ContextMenuProvider>
      <AgentComposer agentId="agent-1" />
      <MenuProbe />
    </ContextMenuProvider>,
  );

describe('AgentComposer', () => {
  const setAgentInputBufferText = vi.fn();
  const setAgentComposerLayoutKey = vi.fn();
  const setAgentTabBarFocused = vi.fn();
  const setAgentApprovalMode = vi.fn();
  let capturedKeypressHandlers: KeypressHandler[];
  let capturedKeypressOptions: Array<{ isActive: boolean }>;

  beforeEach(() => {
    vi.clearAllMocks();
    menuApi = null;
    capturedKeypressHandlers = [];
    capturedKeypressOptions = [];

    vi.mocked(useAgentViewState).mockReturnValue({
      activeView: 'agent-1',
      agents: new Map([
        [
          'agent-1',
          {
            modelId: 'qwen',
            color: 'cyan',
            interactiveAgent: {
              cancelCurrentRound: vi.fn(),
              enqueueMessage: vi.fn(),
              getError: vi.fn(),
              getLastRoundError: vi.fn(),
            },
          },
        ],
      ]),
      agentShellFocused: false,
      agentInputBufferText: '',
      agentTabBarFocused: false,
      agentApprovalModes: new Map(),
      agentMessageQueues: new Map(),
    } as never);
    vi.mocked(useAgentViewActions).mockReturnValue({
      setAgentInputBufferText,
      setAgentComposerLayoutKey,
      setAgentTabBarFocused,
      setAgentApprovalMode,
      setAgentMessageQueue: vi.fn(),
    } as never);
    vi.mocked(useConfig).mockReturnValue({
      getContentGeneratorConfig: () => undefined,
    } as never);
    vi.mocked(usePreferredEditor).mockReturnValue(undefined);
    vi.mocked(useTerminalSize).mockReturnValue({ columns: 80, rows: 24 });
    vi.mocked(useKeypress).mockImplementation(
      (handler: KeypressHandler, options: { isActive: boolean }) => {
        capturedKeypressHandlers.push(handler);
        capturedKeypressOptions.push(options);
      },
    );
    vi.mocked(useAgentStreamingState).mockReturnValue({
      status: AgentStatus.IDLE,
      streamingState: StreamingState.Idle,
      isInputActive: true,
      elapsedTime: 0,
      lastPromptTokenCount: 0,
    } as never);
    vi.mocked(useTextBuffer).mockReturnValue({
      text: 'draft',
      allVisualLines: ['draft'],
      visualCursor: [0, 5],
    } as never);
  });

  it('does not reset the parent input-buffer state during unmount', () => {
    const { unmount } = render(<AgentComposer agentId="agent-1" />);

    expect(setAgentInputBufferText).toHaveBeenCalledWith('draft');
    setAgentInputBufferText.mockClear();

    unmount();

    expect(setAgentInputBufferText).not.toHaveBeenCalled();
  });

  it('syncs the footer layout key and updates it when the agent completes', () => {
    // AppContainer's controls-height measure effect depends on this key; it
    // is the only re-measure trigger for the agent footer (#9507).
    const { rerender } = render(<AgentComposer agentId="agent-1" />);

    expect(setAgentComposerLayoutKey).toHaveBeenCalled();
    const initialKey = String(setAgentComposerLayoutKey.mock.calls.at(-1)?.[0]);
    // The input text is part of the key (input wrapping shifts the height).
    expect(initialKey).toContain('draft');

    vi.mocked(useAgentStreamingState).mockReturnValue({
      status: AgentStatus.COMPLETED,
      streamingState: StreamingState.Idle,
      isInputActive: false,
      elapsedTime: 0,
      lastPromptTokenCount: 0,
    } as never);
    rerender(<AgentComposer agentId="agent-1" />);

    // The terminal-status row appeared, so the key must change to trigger a
    // re-measure of the grown footer.
    const completedKey = String(
      setAgentComposerLayoutKey.mock.calls.at(-1)?.[0],
    );
    expect(completedKey).not.toBe(initialKey);
  });

  // The second useKeypress call is the Shift+Tab approval-mode cycler.
  const getShiftTabHandler = (): KeypressHandler => {
    render(<AgentComposer agentId="agent-1" />);
    return capturedKeypressHandlers[1]!;
  };

  it('cycles approval mode on Shift+Tab', () => {
    const handler = getShiftTabHandler();

    handler({ name: 'tab', shift: true, ctrl: false } as Key);

    expect(setAgentApprovalMode).toHaveBeenCalledWith(
      'agent-1',
      ApprovalMode.AUTO_EDIT,
    );
  });

  it('does not cycle approval mode on Ctrl+Shift+Tab', () => {
    const handler = getShiftTabHandler();

    handler({ name: 'tab', shift: true, ctrl: true } as Key);

    expect(setAgentApprovalMode).not.toHaveBeenCalled();
  });

  // The real useKeypress hook only subscribes while `isActive` is true, so the
  // registration from the most recent render is the gate in force right now.
  const latestOptions = (callSite: number): { isActive: boolean } =>
    capturedKeypressOptions[capturedKeypressOptions.length - 2 + callSite]!;

  it('releases same-chunk keys only after input dismisses the menu', async () => {
    renderWithMenu();
    const items = [{ id: 'open-link', label: 'Open Link', onSelect: vi.fn() }];
    const open = () =>
      act(async () => {
        menuApi?.openMenu(items, { x: 0, y: 0 });
      });
    await open();

    await act(async () => {
      // Hold the same callback: no render may occur between these keys.
      const handleKey = baseTextInputProps.onKeypress!;
      expect(handleKey({ name: 'a', sequence: 'a' } as Key)).toBe(false);
      expect(handleKey({ name: 'return', sequence: '\r' } as Key)).toBe(false);
    });

    await open();
    await act(async () => {
      const handleKey = baseTextInputProps.onKeypress!;
      // A fresh menu owns Enter even after the previous menu was dismissed.
      expect(handleKey({ name: 'return', sequence: '\r' } as Key)).toBe(true);
      menuApi?.executeIndex(0);
      // Even if the overlay executes first, the same Enter cannot submit.
      expect(handleKey({ name: 'return', sequence: '\r' } as Key)).toBe(true);
    });
    expect(items[0]!.onSelect).toHaveBeenCalledOnce();
  });

  it('goes quiet while the right-click context menu is open', async () => {
    // AgentChatContent mounts ContentMouseController on the teammate tab, so
    // this composer is now reachable with the menu open. KeypressContext
    // broadcasts to every subscriber and discards return values (the overlay
    // cannot consume a key for us), so each consumer has to gate itself or a
    // key aimed at the menu also cancels the round and steals tab-bar focus.
    vi.mocked(useAgentStreamingState).mockReturnValue({
      status: AgentStatus.IDLE,
      streamingState: StreamingState.Responding,
      isInputActive: false,
      elapsedTime: 0,
      lastPromptTokenCount: 0,
    } as never);

    renderWithMenu();

    // Control: with no menu open the composer still owns its keys.
    expect(latestOptions(ESCAPE_CANCEL).isActive).toBe(true);
    expect(latestOptions(SHIFT_TAB_CYCLE).isActive).toBe(true);
    expect(baseTextInputProps.onKeypress?.({ name: 'down' } as Key)).toBe(true);
    expect(setAgentTabBarFocused).toHaveBeenCalledWith(true);

    setAgentTabBarFocused.mockClear();
    await act(async () => {
      menuApi?.openMenu(
        [{ id: 'open-link', label: 'Open Link', onSelect: () => {} }],
        { x: 4, y: 2 },
      );
    });
    expect(menuApi?.menu).not.toBeNull();

    // Escape no longer reaches the cancel-round handler at all...
    expect(latestOptions(ESCAPE_CANCEL).isActive).toBe(false);
    // ...and neither does Shift+Tab reach the approval-mode cycler, which
    // writes straight through to the agent runtime's tool-scheduling policy:
    // a key aimed at the menu must not silently change the approval mode of
    // the teammate the user is deciding about.
    expect(latestOptions(SHIFT_TAB_CYCLE).isActive).toBe(false);
    // ...and BaseTextInput never sees the menu's navigation keys, so the draft
    // survives and the tab bar keeps its focus.
    for (const name of ['up', 'down', 'return', 'escape']) {
      expect(baseTextInputProps.onKeypress?.({ name } as Key)).toBe(true);
    }
    expect(setAgentTabBarFocused).not.toHaveBeenCalled();
  });
});
