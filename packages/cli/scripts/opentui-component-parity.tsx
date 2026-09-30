/* eslint-disable no-control-regex, react/no-unknown-property */
/** @jsxImportSource @opentui/react */
/**
 * Component-level parity snapshot (M5): renders the SAME logical fragment under
 * the original Ink renderer (ink-testing-library lastFrame) and the OpenTUI
 * port (headless test renderer captureCharFrame), strips ANSI, and compares
 * layout/text. Run with: bun packages/cli/scripts/opentui-component-parity.tsx
 * Exit 0 = parity, 1 = drift.
 */
import { createElement } from 'react';
import { render as inkRender } from 'ink-testing-library';
import { Box as IBox, Text as IText } from 'ink';
import { testRender } from '@opentui/react/test-utils';

const stripAnsi = (s: string) =>
  s.replace(/\x1b\[[0-9;]*[a-zA-Z]/g, '').replace(/\x1b\][^\x07]*\x07/g, '');
const norm = (s: string) =>
  stripAnsi(s)
    .split('\n')
    .map((l) => l.trimEnd())
    .filter((l) => l.trim() !== '')
    .join('\n');

// Reference: the ink StatsDisplay StatRow shape (28-wide label gutter + value).
const inkNode = createElement(
  IBox,
  null,
  createElement(IBox, { width: 28 }, createElement(IText, null, 'Session ID:')),
  createElement(IText, null, 'abc-123'),
);

// The OpenTUI port equivalent (Row in dialogs-stats-skills).
const opentuiNode = (
  <box flexDirection="row">
    <box width={28}>
      <text>{'Session ID:'}</text>
    </box>
    <box flexGrow={1}>
      <text>{'abc-123'}</text>
    </box>
  </box>
);

async function main() {
  const ink = inkRender(inkNode as never);
  const inkFrame = norm(ink.lastFrame() ?? '');
  const setup = await testRender(opentuiNode as never, {
    width: 60,
    height: 5,
  });
  await (setup as { waitForVisualIdle?: () => Promise<unknown> })
    .waitForVisualIdle?.()
    .catch(() => {});
  const otFrame = norm(
    (setup as { captureCharFrame: () => string }).captureCharFrame(),
  );
  console.log('--- ink ---\n' + inkFrame);
  console.log('--- opentui ---\n' + otFrame);
  const pass = inkFrame === otFrame;
  console.log(pass ? 'PARITY PASS' : 'PARITY FAIL');
  process.exit(pass ? 0 : 1);
}

void main();
