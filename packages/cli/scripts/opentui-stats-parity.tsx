/* eslint-disable no-control-regex */
/** @jsxImportSource @opentui/react */
/**
 * Real-component cross-renderer parity snapshot (M5): renders the ORIGINAL ink
 * StatsDisplay (inside SessionStatsProvider) and the OpenTUI port
 * (OpenTuiStatsDialog) with the SAME (reset) uiTelemetryService, then asserts
 * the shared Session rows/labels appear in BOTH frames. Whole-frame equality is
 * the wrong assertion for a port (cosmetic chrome differs); row-level presence
 * of the same data is the meaningful cross-renderer check.
 * Run: bun packages/cli/scripts/opentui-stats-parity.tsx  (exit 0 = parity)
 */
import { createElement } from 'react';
import { render as inkRender } from 'ink-testing-library';
import { uiTelemetryService } from '@qwen-code/qwen-code-core';
import { testRender } from '@opentui/react/test-utils';
import { SessionStatsProvider } from '../src/ui/contexts/SessionContext.js';
import { SessionTab } from '../src/ui/components/StatsSessionTab.js';
import { OpenTuiStatsDialog } from '../src/ui/opentui/dialogs-stats-skills.js';

const stripAnsi = (s: string) =>
  s.replace(/\x1b\[[0-9;]*[a-zA-Z]/g, '').replace(/\x1b\][^\x07]*\x07/g, '');

const LABELS = [
  'Interaction Summary',
  'Performance',
  'Session ID:',
  'Tool Calls:',
  'Success Rate:',
  'Tokens',
];

async function main() {
  uiTelemetryService.reset();

  const ink = inkRender(
    createElement(SessionStatsProvider, null, createElement(SessionTab)),
  );
  const inkFrame = stripAnsi(ink.lastFrame() ?? '');

  const setup = await testRender(
    <OpenTuiStatsDialog config={undefined} onClose={() => {}} />,
    { width: 90, height: 40 },
  );
  await (setup as { waitForVisualIdle?: () => Promise<unknown> })
    .waitForVisualIdle?.()
    .catch(() => {});
  const otFrame = stripAnsi(
    (setup as { captureCharFrame: () => string }).captureCharFrame(),
  );

  let ok = true;
  for (const label of LABELS) {
    const inInk = inkFrame.includes(label);
    const inOt = otFrame.includes(label);
    console.log(
      `${label.padEnd(22)} ink=${inInk ? 'Y' : 'N'} opentui=${inOt ? 'Y' : 'N'}`,
    );
    if (!inInk || !inOt) ok = false;
  }
  console.log(ok ? 'STATS PARITY PASS' : 'STATS PARITY FAIL');
  process.exit(ok ? 0 : 1);
}

void main();
