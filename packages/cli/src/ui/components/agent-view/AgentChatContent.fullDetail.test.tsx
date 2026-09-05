/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Ctrl+O full-detail must reach the agent view's transcript items.
 *
 * Thinking blocks already honored the toggle here (HistoryItemDisplay reads
 * ThoughtExpandedContext itself), but the tool side never received
 * `fullDetail` — so `ui.showToolCallArgs` could render a truncated args row
 * advertising `(ctrl+o)` for a key that did nothing in this view.
 */

import { describe, it, expect, vi } from 'vitest';
import { render } from 'ink-testing-library';
import { Text } from 'ink';
import { EventEmitter } from 'node:events';
import { ThoughtExpandedProvider } from '../../contexts/ThoughtExpandedContext.js';
import type { AgentCore } from '@qwen-code/qwen-code-core';

const receivedFullDetail: Array<boolean | undefined> = [];

vi.mock('../HistoryItemDisplay.js', () => ({
  HistoryItemDisplay: ({ fullDetail }: { fullDetail?: boolean }) => {
    receivedFullDetail.push(fullDetail);
    return <Text>item</Text>;
  },
}));

vi.mock('../../contexts/UIStateContext.js', () => ({
  useUIState: () => ({
    historyRemountKey: 0,
    availableTerminalHeight: 40,
    constrainHeight: false,
  }),
}));

vi.mock('../../hooks/useTerminalSize.js', () => ({
  useTerminalSize: () => ({ columns: 100, rows: 40 }),
}));

vi.mock('../../hooks/useKeypress.js', () => ({ useKeypress: () => {} }));

vi.mock('../../contexts/AgentViewContext.js', () => ({
  useAgentViewActions: () => ({ setAgentShellFocused: () => {} }),
}));

const { AgentChatContent } = await import('./AgentChatContent.js');

function makeCore(): AgentCore {
  const emitter = new EventEmitter();
  return {
    getEventEmitter: () => emitter,
    getMessages: () => [
      {
        role: 'assistant',
        content: 'hello from the subagent',
        timestamp: 0,
      },
      // An unmatched tool_call maps to a tool_group whose tool is still
      // Executing. `splitIndex` keeps such a group (and everything after it)
      // in the live area, so this fixture is what makes the second,
      // `isPending` render site run at all — without it the live-area
      // forwarding is unpinned.
      {
        role: 'tool_call',
        content: 'Tool call: replace',
        timestamp: 0,
        metadata: {
          callId: 'c1',
          toolName: 'replace',
          description: 'src/a.ts',
          args: { file_path: 'src/a.ts' },
        },
      },
    ],
    getPendingApprovals: () => new Map(),
    getLiveOutputs: () => new Map(),
    getShellPids: () => new Map(),
    runtimeContext: { getTargetDir: () => '' },
    modelConfig: { model: 'test-model' },
  } as unknown as AgentCore;
}

const renderAt = (allExpanded: boolean) => {
  receivedFullDetail.length = 0;
  render(
    <ThoughtExpandedProvider
      value={{
        allExpanded,
        expandedHeadIds: new Set<number>(),
        toggle: () => {},
      }}
    >
      <AgentChatContent core={makeCore()} instanceKey="a@team" />
    </ThoughtExpandedProvider>,
  );
  return receivedFullDetail;
};

describe('AgentChatContent — Ctrl+O full detail', () => {
  // Both render sites must be covered: the committed <Static> tree and the
  // live area that holds executing/confirming tool groups. Pinning only the
  // former let a mutation dropping the live-area prop survive, which would
  // leave a running tool group advertising `(ctrl+o)` for a dead key.
  const COMMITTED_AND_LIVE = 2;

  it('forwards the expanded state to both committed and live items', () => {
    const seen = renderAt(true);
    expect(seen.length).toBe(COMMITTED_AND_LIVE);
    expect(seen).toEqual([true, true]);
  });

  it('leaves both sites collapsed when the toggle is off', () => {
    const seen = renderAt(false);
    expect(seen.length).toBe(COMMITTED_AND_LIVE);
    expect(seen).toEqual([false, false]);
  });
});
