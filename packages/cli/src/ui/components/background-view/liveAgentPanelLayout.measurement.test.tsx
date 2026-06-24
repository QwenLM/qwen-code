/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Runtime reproduction of the non-VP overflow flicker root cause.
 *
 * AppContainer reserves room for the footer with
 *   availableTerminalHeight = terminalHeight - controlsHeight - ...
 * where `controlsHeight` is measured from the controls box (which contains the
 * LiveAgentPanel) inside a `useLayoutEffect` gated by a dependency array. The
 * panel grows as agents launch, but the panel's only self-driven re-render is a
 * per-second elapsed-time tick that never changes the roster. So unless the
 * roster is part of the measurement effect's deps, the effect does not re-run
 * when an agent launches: `controlsHeight` stays stale, `availableTerminalHeight`
 * stays too large, the pending region overflows the terminal, and every repaint
 * forces the view back to the bottom with a flicker.
 *
 * This test faithfully mirrors that exact measurement contract on a minimal
 * component — real ink render, real `measureElement`, real
 * `getLiveAgentPanelLayoutKey` — and shows that:
 *   - WITHOUT the roster key in the deps, a roster that grows leaves the
 *     measured controls height (and thus availableHeight) stale; and
 *   - WITH the roster key in the deps, the controls are re-measured and the
 *     reserved room shrinks to match — which is exactly the one-line fix
 *     applied in AppContainer.
 */

import { describe, it, expect } from 'vitest';
import { useLayoutEffect, useRef, useState } from 'react';
import { render } from 'ink-testing-library';
import { Box, Text, measureElement, type DOMElement } from 'ink';
import { getLiveAgentPanelLayoutKey } from './liveAgentPanelVisibility.js';
import type { AgentDialogEntry } from '../../hooks/useBackgroundTaskView.js';

const TERMINAL_HEIGHT = 24;

const agent = (id: string): AgentDialogEntry =>
  ({
    kind: 'agent',
    agentId: id,
    description: 'desc',
    status: 'running',
    startTime: 0,
    abortController: new AbortController(),
  }) as unknown as AgentDialogEntry;

/**
 * Minimal stand-in for AppContainer's footer-measurement contract. The controls
 * box renders one row per agent (so its real measured height grows with the
 * roster), measures itself into `controlsHeight` via a useLayoutEffect, and
 * reports the resulting availableHeight. `wireRosterDep` toggles whether the
 * roster signal is part of the effect deps — i.e. buggy vs fixed.
 */
function ControlsMeasured({
  entries,
  wireRosterDep,
  report,
}: {
  entries: readonly AgentDialogEntry[];
  wireRosterDep: boolean;
  report: (availableHeight: number) => void;
}) {
  const ref = useRef<DOMElement>(null);
  const [controlsHeight, setControlsHeight] = useState(0);

  const rosterKey = getLiveAgentPanelLayoutKey(entries, false);
  const deps = wireRosterDep ? [rosterKey] : [];

  useLayoutEffect(() => {
    if (!ref.current) return;
    const { height } = measureElement(ref.current);
    setControlsHeight((prev) => (prev === height ? prev : height));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps);

  report(Math.max(0, TERMINAL_HEIGHT - controlsHeight));

  return (
    <Box flexDirection="column" ref={ref}>
      <Text>main</Text>
      {entries.map((e) => (
        <Text key={e.agentId}>{e.agentId} · running</Text>
      ))}
    </Box>
  );
}

async function measureGrowth(
  wireRosterDep: boolean,
): Promise<{ before: number; after: number }> {
  let availableHeight = -1;
  const report = (v: number) => {
    availableHeight = v;
  };

  const { rerender, unmount } = render(
    <ControlsMeasured
      entries={[]}
      wireRosterDep={wireRosterDep}
      report={report}
    />,
  );
  await new Promise((r) => setTimeout(r, 20));
  const before = availableHeight;

  // Three agents launch → the controls box is now three rows taller.
  rerender(
    <ControlsMeasured
      entries={[agent('a1'), agent('a2'), agent('a3')]}
      wireRosterDep={wireRosterDep}
      report={report}
    />,
  );
  await new Promise((r) => setTimeout(r, 20));
  const after = availableHeight;

  unmount();
  return { before, after };
}

describe('LiveAgentPanel growth → controls re-measurement', () => {
  it('BUG: without the roster in the measurement deps, reserved room goes stale on growth', async () => {
    const { before, after } = await measureGrowth(false);
    // Footer was measured once with an empty roster and never again, so the
    // reserved room does not shrink even though the panel grew by three rows.
    expect(before).toBeGreaterThan(0);
    expect(after).toBe(before);
  });

  it('FIX: wiring the roster key into the deps re-measures, shrinking reserved room', async () => {
    const { before, after } = await measureGrowth(true);
    // The taller controls footprint is now reflected: less room is left for the
    // main content, so it can no longer overflow the terminal.
    expect(after).toBeLessThan(before);
    expect(before - after).toBe(3); // exactly the three new agent rows
  });
});
