/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Runtime reproduction of the agent-tab stale-viewport root cause (#9507).
 *
 * On an agent tab AppContainer sizes the transcript viewport from
 *   availableTerminalHeight = terminalHeight - controlsHeight - tabBarHeight
 * where `controlsHeight` is measured from the controls box (which contains
 * AgentComposer) inside a useLayoutEffect gated by a dependency array. The
 * agent footer grows when the agent reaches a terminal status (the
 * Completed/Failed row appears) or messages are queued while it streams, but
 * those changes live inside AgentComposer (agent events / local queue state)
 * and never touch AppContainer's own deps. So unless the composer-synced
 * layout key is part of the deps, the effect does not re-run: controlsHeight
 * stays stale-high and — once the transcript fills the viewport — the column
 * (viewport + grown composer + tab bar) lands past the terminal's last row.
 *
 * This test mirrors that measurement contract on a minimal component — real
 * ink render, real measureElement, real getAgentComposerLayoutKey — and shows
 * that WITHOUT the key in the deps a growing footer leaves the available
 * height stale, while WITH it the re-measure shrinks the reserved room by
 * exactly the growth. A real AppContainer cannot be exercised here because
 * ink-testing-library's rerender remounts it (re-running every mount effect
 * regardless of deps); see app-container-controls-dep.test.ts for the
 * source-level guard on the actual deps array.
 */

import { describe, it, expect } from 'vitest';
import { useLayoutEffect, useRef, useState } from 'react';
import { render } from 'ink-testing-library';
import { Box, Text, measureElement, type DOMElement } from 'ink';
import { StreamingState } from '../../types.js';
import { getAgentComposerLayoutKey } from './AgentComposer.js';

const TERMINAL_HEIGHT = 24;
// The agent tab always renders a 1-row tab bar under the controls box;
// AppContainer subtracts it separately from availableTerminalHeight.
const TAB_BAR_HEIGHT = 1;

interface FooterShape {
  streamingState: StreamingState;
  statusLabel: string;
  queuedMessageCount: number;
  inputText: string;
}

/** Rows the stand-in renders for the queued-message display. */
function queuedRows(count: number): number {
  if (count === 0) return 0;
  // 1 margin row + up to 3 previews + a "more" row, as in QueuedMessageDisplay
  return 1 + Math.min(count, 3) + (count > 3 ? 1 : 0);
}

/**
 * Minimal stand-in for AppContainer's footer-measurement contract on the
 * agent tab. The controls box renders one row per height-shifting part of
 * AgentComposer (loading row, terminal status row, queued-message rows,
 * input line, footer row), measures itself into `controlsHeight` via a
 * useLayoutEffect, and reports the resulting available height.
 * `wireComposerKeyDep` toggles whether the composer layout key is part of
 * the effect deps — i.e. buggy vs fixed.
 */
function AgentFooterMeasured({
  shape,
  wireComposerKeyDep,
  report,
}: {
  shape: FooterShape;
  wireComposerKeyDep: boolean;
  report: (availableHeight: number) => void;
}) {
  const ref = useRef<DOMElement>(null);
  const [controlsHeight, setControlsHeight] = useState(0);

  const composerKey = getAgentComposerLayoutKey(shape);
  const deps = wireComposerKeyDep ? [composerKey] : [];

  useLayoutEffect(() => {
    if (!ref.current) return;
    const { height } = measureElement(ref.current);
    setControlsHeight((prev) => (prev === height ? prev : height));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);

  report(Math.max(0, TERMINAL_HEIGHT - controlsHeight - TAB_BAR_HEIGHT));

  return (
    <Box flexDirection="column" ref={ref}>
      {shape.streamingState !== StreamingState.Idle && <Text>Thinking…</Text>}
      {shape.statusLabel !== '' && <Text>{shape.statusLabel}</Text>}
      {Array.from({ length: queuedRows(shape.queuedMessageCount) }, (_, i) => (
        <Text key={`queued-${i}`}>queued</Text>
      ))}
      <Text>{shape.inputText}</Text>
      <Text>footer</Text>
    </Box>
  );
}

async function availableAfterGrowth(
  wireComposerKeyDep: boolean,
): Promise<{ before: number; after: number }> {
  let availableHeight = -1;
  const report = (v: number) => {
    availableHeight = v;
  };

  const streamingShape: FooterShape = {
    streamingState: StreamingState.Responding,
    statusLabel: '',
    queuedMessageCount: 0,
    inputText: 'hi',
  };

  const { rerender, unmount } = render(
    <AgentFooterMeasured
      shape={streamingShape}
      wireComposerKeyDep={wireComposerKeyDep}
      report={report}
    />,
  );
  await new Promise((r) => setTimeout(r, 20));
  const before = availableHeight;

  // The agent finishes (Completed status row appears) and two messages were
  // queued while it streamed: the footer grows by 1 + queuedRows(2) rows.
  rerender(
    <AgentFooterMeasured
      shape={{
        ...streamingShape,
        statusLabel: 'Completed',
        queuedMessageCount: 2,
      }}
      wireComposerKeyDep={wireComposerKeyDep}
      report={report}
    />,
  );
  await new Promise((r) => setTimeout(r, 20));
  const after = availableHeight;
  unmount();
  return { before, after };
}

describe('agent composer footer re-measurement (#9507)', () => {
  it('leaves the available height stale without the composer key dep', async () => {
    const { before, after } = await availableAfterGrowth(false);
    // The footer objectively grew, but the measurement effect never
    // re-runs: the reserved room stays overestimated by exactly the growth.
    expect(after).toBe(before);
  });

  it('re-measures and shrinks the reserved room with the composer key dep', async () => {
    const growth = 1 + queuedRows(2); // Completed row + queued display
    const { before, after } = await availableAfterGrowth(true);
    expect(after).toBe(before - growth);
  });
});

describe('getAgentComposerLayoutKey', () => {
  const base: FooterShape = {
    streamingState: StreamingState.Idle,
    statusLabel: '',
    queuedMessageCount: 0,
    inputText: '',
  };

  it('is stable for unchanged footer state', () => {
    expect(getAgentComposerLayoutKey(base)).toBe(
      getAgentComposerLayoutKey({ ...base }),
    );
  });

  it('changes when the terminal status row appears', () => {
    expect(
      getAgentComposerLayoutKey({ ...base, statusLabel: 'Completed' }),
    ).not.toBe(getAgentComposerLayoutKey(base));
  });

  it('changes when messages are queued', () => {
    expect(
      getAgentComposerLayoutKey({ ...base, queuedMessageCount: 2 }),
    ).not.toBe(getAgentComposerLayoutKey(base));
  });

  it('changes when the input text grows', () => {
    expect(getAgentComposerLayoutKey({ ...base, inputText: 'hello' })).not.toBe(
      getAgentComposerLayoutKey(base),
    );
  });

  it('changes when the loading row toggles (streaming state)', () => {
    expect(
      getAgentComposerLayoutKey({
        ...base,
        streamingState: StreamingState.Responding,
      }),
    ).not.toBe(getAgentComposerLayoutKey(base));
  });
});
