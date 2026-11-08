/**
 * Wrap-parity golden: pins the line-break positions the OpenTUI renderer
 * produces for the paragraphs whose framing drove the 0.5.8 -> 0.5.10 bump.
 * Run with: bun packages/cli/scripts/opentui-wrap-parity.ts
 * Exit 0 = the pinned renderer still breaks these lines where Ink does.
 *
 * The goldens are the break columns measured out of the Ink renderer's own
 * frames for the approval dialog and the editor dialog in the acceptance
 * matrix, and 0.5.8 breaks all three differently, so re-pinning the renderer
 * to that release turns this gate red.
 */
import { createElement } from 'react';
import { testRender } from '@opentui/react/test-utils';

const CASES = [
  {
    name: 'editor description, 22 columns',
    width: 22,
    text: 'note that some editors cannot be used in sandbox mode.',
    expected: ['note that some editors', 'cannot be used in', 'sandbox mode.'],
  },
  {
    name: 'approval body, 31 columns',
    width: 31,
    text: 'Approval is bound to this exact configuration — if .mcp.json changes, you will be asked again.',
    expected: [
      'Approval is bound to this exact',
      'configuration — if .mcp.json',
      'changes, you will be asked',
      'again.',
    ],
  },
  {
    name: 'approval body, 45 columns',
    width: 45,
    text: 'Approval is bound to this exact configuration — if .mcp.json changes, you will be asked again.',
    expected: [
      'Approval is bound to this exact configuration',
      '— if .mcp.json changes, you will be asked',
      'again.',
    ],
  },
];

const lines = (frame: string) =>
  frame
    .split('\n')
    .map((l) => l.replace(/\s+$/, ''))
    .filter((l) => l !== '');

async function main() {
  let failed = 0;
  for (const c of CASES) {
    const setup = await testRender(
      createElement(
        'box',
        { width: c.width },
        createElement('text', {}, c.text),
      ),
      { width: c.width + 2, height: 10 },
    );
    await (setup as { waitForVisualIdle?: () => Promise<unknown> })
      .waitForVisualIdle?.()
      .catch(() => {});
    const actual = lines(
      (setup as { captureCharFrame: () => string }).captureCharFrame(),
    );
    (setup as { stop?: () => void }).stop?.();
    const ok = actual.join('\n') === c.expected.join('\n');
    console.log(`${ok ? 'PASS' : 'FAIL'}  ${c.name}`);
    if (!ok) {
      failed++;
      console.log(`  expected ${JSON.stringify(c.expected)}`);
      console.log(`  actual   ${JSON.stringify(actual)}`);
    }
  }
  console.log(failed === 0 ? 'WRAP PARITY PASS' : 'WRAP PARITY FAIL');
  process.exit(failed === 0 ? 0 : 1);
}

void main();
