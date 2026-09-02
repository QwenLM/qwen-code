/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { render } from 'ink-testing-library';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AgentStatus, ApprovalMode } from '@qwen-code/qwen-code-core';
import {
  useAgentViewActions,
  useAgentViewState,
} from '../../contexts/AgentViewContext.js';
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
vi.mock('../BaseTextInput.js', () => ({ BaseTextInput: () => null }));
vi.mock('../LoadingIndicator.js', () => ({ LoadingIndicator: () => null }));
vi.mock('../QueuedMessageDisplay.js', () => ({
  QueuedMessageDisplay: () => null,
}));
vi.mock('./AgentFooter.js', () => ({ AgentFooter: () => null }));

type KeypressHandler = (key: Key) => void;

describe('AgentComposer', () => {
  const setAgentInputBufferText = vi.fn();
  const setAgentTabBarFocused = vi.fn();
  const setAgentApprovalMode = vi.fn();
  let capturedKeypressHandlers: KeypressHandler[];

  beforeEach(() => {
    vi.clearAllMocks();
    capturedKeypressHandlers = [];

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
    } as never);
    vi.mocked(useAgentViewActions).mockReturnValue({
      setAgentInputBufferText,
      setAgentTabBarFocused,
      setAgentApprovalMode,
    } as never);
    vi.mocked(useConfig).mockReturnValue({
      getContentGeneratorConfig: () => undefined,
    } as never);
    vi.mocked(usePreferredEditor).mockReturnValue(undefined);
    vi.mocked(useTerminalSize).mockReturnValue({ columns: 80, rows: 24 });
    vi.mocked(useKeypress).mockImplementation(
      (handler: KeypressHandler, _options) => {
        capturedKeypressHandlers.push(handler);
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
});
