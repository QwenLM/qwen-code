/* eslint-disable react/no-unknown-property */
/** @jsxImportSource @opentui/react */
/** Native dialog geometry and resize regression checks. Run with Bun. */
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { act, type ReactNode } from 'react';
import { ScrollBoxRenderable, type Renderable } from '@opentui/core';
import { testRender } from '@opentui/react/test-utils';
import { useTerminalDimensions } from '@opentui/react';
import type { Config } from '@qwen-code/qwen-code-core/config/config.js';
import {
  OpenTuiDiffDialog,
  OpenTuiSubagentListDialog,
} from '../src/ui/opentui/dialogs-misc.js';
import { OpenTuiSkillsDialog } from '../src/ui/opentui/dialogs-stats-skills.js';
import { OpenTuiSessionPicker } from '../src/ui/opentui/session-picker.js';
import { dialogAreaWidth } from '../src/ui/opentui/dialogs-shared.js';
import type { LoadedSettings } from '../src/config/settings.js';

type Setup = Awaited<ReturnType<typeof testRender>>;
const noop = () => {};
const settings = { merged: {} } as LoadedSettings;
const endMarker = '§';
const fixtureRows = Array.from({ length: 40 }, (_, index) => ({
  name: index === 39 ? endMarker : `row-${index}`,
  description: index === 39 ? '' : 'description',
}));
const config = {
  getSkillManager: () => ({ listSkills: async () => fixtureRows }),
  getSubagentManager: () => ({ listSubagents: async () => fixtureRows }),
} as unknown as Config;

function children(node: Renderable): Renderable[] {
  return [node, ...node.getChildren().flatMap(children)];
}
function body(setup: Setup): ScrollBoxRenderable {
  const found = children(setup.renderer.root).find(
    (node) => node instanceof ScrollBoxRenderable,
  );
  assert(found instanceof ScrollBoxRenderable, 'missing native scrollbox');
  return found;
}
function nativeShrink(node: Renderable): number {
  return (
    node as unknown as { yogaNode: { getFlexShrink: () => number } }
  ).yogaNode.getFlexShrink();
}
async function destroy(setup: Setup) {
  await act(async () => setup.renderer.destroy());
}

async function render(
  node: ReactNode,
  options: Parameters<typeof testRender>[1],
) {
  let setup: Setup | undefined;
  await act(async () => {
    setup = await testRender(node, options);
  });
  assert(setup);
  return setup;
}

async function boundedDialogs() {
  for (const width of [11, 20, 40, 100]) {
    for (const region of [1, 2, 3, 4, 5, 6, 7, 8, 12, 15, 40]) {
      for (const Dialog of [
        OpenTuiSkillsDialog,
        OpenTuiDiffDialog,
        OpenTuiSubagentListDialog,
      ]) {
        const label = `${Dialog.name} ${width} columns, ${region} rows`;
        const setup = await render(
          <box
            height={region}
            width={dialogAreaWidth(width)}
            marginLeft={2}
            overflow="hidden"
            flexDirection="column"
          >
            <Dialog
              config={config}
              settings={settings}
              onClose={noop}
              availableTerminalHeight={region}
            />
          </box>,
          { width, height: 50 },
        );
        try {
          await act(async () => setup.waitForVisualIdle());
          const frame = setup.renderer.root.getChildren()[0].getChildren()[0];
          assert(frame, `${label}: missing frame`);
          assert(
            frame.height <= region,
            `${label}: frame is ${frame.height} rows`,
          );
          // Geometry alone cannot detect a border painting outside its parent.
          const painted = setup.captureCharFrame().split('\n');
          assert(
            painted.slice(region).every((row) => row.trim() === ''),
            `${label}: overpaint below region`,
          );
        } finally {
          await destroy(setup);
        }
      }
    }
  }
  console.log('PASS: 132 native short/narrow dialog cases');
}

async function scrollAndResizeDialogs() {
  for (const width of [20, 40, 100]) {
    for (const Dialog of [
      OpenTuiSkillsDialog,
      OpenTuiDiffDialog,
      OpenTuiSubagentListDialog,
    ]) {
      function Responsive() {
        const { height, width } = useTerminalDimensions();
        return (
          <box
            height={height}
            width={dialogAreaWidth(width)}
            marginLeft={2}
            overflow="hidden"
            flexDirection="column"
          >
            <Dialog
              config={config}
              settings={settings}
              onClose={noop}
              availableTerminalHeight={height}
            />
          </box>
        );
      }
      const setup = await render(<Responsive />, { width, height: 15 });
      try {
        setup.renderer.start();
        await setup.waitFor(() => body(setup).scrollHeight >= 40, {
          maxPasses: 100,
        });
        setup.renderer.pause();
        for (const height of [7, 20, 4, 12]) {
          const before = body(setup);
          await act(async () => setup.resize(width, height));
          await act(async () => setup.waitForVisualIdle());
          const after = body(setup);
          assert.notEqual(
            after,
            before,
            `${Dialog.name}: resize did not remount`,
          );
          assert.equal(
            nativeShrink(after),
            1,
            `${Dialog.name}: lost native shrink`,
          );
          assert(
            setup.renderer.root.getChildren()[0].getChildren()[0].height <=
              height,
            `${Dialog.name}: resize frame overflow`,
          );
          after.scrollTo(after.scrollHeight);
          await setup.renderOnce();
          assert(
            setup.captureCharFrame().includes(endMarker),
            `${Dialog.name}: last content is unreachable after resize to ${height}`,
          );
        }
      } finally {
        await destroy(setup);
      }
    }
  }
  console.log(
    'PASS: native short/narrow scroll-to-last content and shrink/grow resize',
  );
}

async function pickerResize() {
  for (const preview of [false, true]) {
    const setup = await render(
      <OpenTuiSessionPicker
        sessionService={null}
        initialSessions={[
          {
            sessionId: 'native-id',
            prompt: 'Native picker',
            mtime: 0,
            startTime: '2026-01-01T00:00:00Z',
            cwd: '.',
            filePath: 'native.jsonl',
          },
        ]}
        onSelect={noop}
        onCancel={noop}
        enablePreview
      />,
      { width: 100, height: 40 },
    );
    try {
      await setup.renderOnce();
      if (preview) {
        await act(async () => setup.mockInput.pressKey(' '));
        await setup.renderOnce();
        assert(setup.captureCharFrame().includes('Enter to resume'));
      } else {
        assert(setup.captureCharFrame().includes('Resume Session'));
      }
      for (const [width, height] of [
        [80, 37],
        [70, 33],
        [100, 40],
      ]) {
        const before = setup.renderer.root.getChildren()[0];
        assert.equal(nativeShrink(before), 1);
        await act(async () => setup.resize(width, height));
        await setup.renderOnce();
        const after = setup.renderer.root.getChildren()[0];
        assert.notEqual(before, after, 'picker sized node was reused');
        assert.equal(
          nativeShrink(after),
          1,
          'picker native shrink was cleared',
        );
        assert.equal(after.height, height - 1);
      }
    } finally {
      await destroy(setup);
    }
  }
  console.log('PASS: real session picker list/preview native resize');
}

async function main() {
  const originalDirectory = process.cwd();
  const fixture = mkdtempSync(join(tmpdir(), 'qwen-dialog-layout-'));
  try {
    process.chdir(fixture);
    execFileSync('git', ['init', '--quiet']);
    writeFileSync('diff-fixture.txt', 'original\n');
    execFileSync('git', ['add', 'diff-fixture.txt']);
    writeFileSync(
      'diff-fixture.txt',
      fixtureRows.map((row) => row.name).join('\n') + '\n',
    );
    await boundedDialogs();
    await scrollAndResizeDialogs();
    await pickerResize();
  } finally {
    process.chdir(originalDirectory);
    rmSync(fixture, { recursive: true, force: true });
  }
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
