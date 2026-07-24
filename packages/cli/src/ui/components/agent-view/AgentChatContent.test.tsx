/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { render } from 'ink-testing-library';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { AgentStatus } from '@qwen-code/qwen-code-core';
import { useUIState } from '../../contexts/UIStateContext.js';
import { useUIActions } from '../../contexts/UIActionsContext.js';
import { useAgentViewActions } from '../../contexts/AgentViewContext.js';
import { useKeypress } from '../../hooks/useKeypress.js';
import { useTerminalSize } from '../../hooks/useTerminalSize.js';
import { AgentChatContent } from './AgentChatContent.js';

vi.mock('../../contexts/UIStateContext.js');
vi.mock('../../contexts/UIActionsContext.js');
vi.mock('../../contexts/AgentViewContext.js');
vi.mock('../../hooks/useKeypress.js');
vi.mock('../../hooks/useTerminalSize.js');
vi.mock('../HistoryItemDisplay.js', () => ({ HistoryItemDisplay: () => null }));
vi.mock('../GeminiRespondingSpinner.js', () => ({
  GeminiRespondingSpinner: () => null,
}));
vi.mock('./AgentHeader.js', () => ({ AgentHeader: () => null }));

function makeCore(shellPids: Map<string, number> = new Map()) {
  const emitter = new EventEmitter();
  return {
    getEventEmitter: () => emitter,
    getMessages: () => [],
    getPendingApprovals: () => [],
    getLiveOutputs: () => new Map(),
    getShellPids: () => shellPids,
  };
}

function makeInteractiveAgent() {
  return {
    getStatus: () => AgentStatus.RUNNING,
    getExecutionStartTimes: () => new Map(),
    getCore: () => ({
      runtimeContext: { getApprovalMode: () => 'default' },
    }),
  };
}

describe('AgentChatContent Ctrl+F delegation', () => {
  const handleToggleKeypress = vi.fn(() => true);
  const setAgentShellFocused = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(useUIState).mockReturnValue({
      historyRemountKey: 0,
      availableTerminalHeight: 24,
      constrainHeight: false,
    } as never);
    vi.mocked(useUIActions).mockReturnValue({
      handleToggleKeypress,
    } as never);
    vi.mocked(useAgentViewActions).mockReturnValue({
      setAgentShellFocused,
      setAgentViewHasActiveShellPty: vi.fn(),
    } as never);
    vi.mocked(useTerminalSize).mockReturnValue({ columns: 80, rows: 24 });
    vi.mocked(useKeypress).mockImplementation(() => {});
  });

  function getKeypressHandler() {
    const calls = vi.mocked(useKeypress).mock.calls;
    const call = calls.find(
      (c) => typeof c[0] === 'function' && c[0].length >= 0,
    );
    if (!call) throw new Error('useKeypress was not called with a handler');
    return call[0] as (key: { name: string; ctrl: boolean }) => void;
  }

  const ctrlF = { name: 'f', ctrl: true, meta: false, shift: false };

  it('delegates Ctrl+F to model toggle when no active PTY', () => {
    const core = makeCore(new Map());
    render(
      <AgentChatContent
        core={core as never}
        interactiveAgent={makeInteractiveAgent() as never}
        instanceKey="test"
      />,
    );

    const handler = getKeypressHandler();
    handler(ctrlF);

    expect(handleToggleKeypress).toHaveBeenCalledWith(ctrlF);
  });

  it('does NOT delegate Ctrl+F to model toggle when a PTY is active', () => {
    const core = makeCore(new Map([['shell-1', 12345]]));
    render(
      <AgentChatContent
        core={core as never}
        interactiveAgent={makeInteractiveAgent() as never}
        instanceKey="test"
      />,
    );

    const handler = getKeypressHandler();
    handler(ctrlF);

    expect(handleToggleKeypress).not.toHaveBeenCalled();
  });
});
