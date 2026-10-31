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
import { OpenTuiSubagentCreateDialog } from '../src/ui/opentui/SubagentCreateDialog.js';
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
        const windowed = Dialog === OpenTuiSubagentListDialog;
        try {
          await setup.waitFor(
            () =>
              windowed
                ? setup.captureCharFrame().includes('row-0')
                : body(setup).scrollHeight >= 40,
            { maxPasses: 100 },
          );
        } catch (error) {
          throw new Error(
            `${Dialog.name} ${width} columns, 15 rows: scrollHeight=${body(setup).scrollHeight}\n${setup.captureCharFrame()}`,
            { cause: error },
          );
        }
        if (windowed) {
          for (let index = 0; index < fixtureRows.length - 1; index++) {
            await act(async () => setup.mockInput.pressKey('ARROW_DOWN'));
            await act(async () => setup.waitForVisualIdle());
          }
          assert.match(
            setup.captureCharFrame(),
            /›\s+§/,
            `${Dialog.name} ${width} columns: last agent is not visibly selected`,
          );
        }
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
          if (windowed) {
            assert.match(
              setup.captureCharFrame(),
              /›\s+§/,
              `${Dialog.name}: last agent is not visibly selected after resize to ${height}`,
            );
          } else {
            after.scrollTo(after.scrollHeight);
            await setup.renderOnce();
            assert(
              setup.captureCharFrame().includes(endMarker),
              `${Dialog.name}: last content is unreachable after resize to ${height}`,
            );
          }
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

async function creatorDialogs() {
  const creatorConfig = {
    getToolRegistry: () => ({ getAllTools: () => [] }),
    getSubagentManager: () => ({ loadSubagent: async () => null }),
  } as unknown as Config;
  for (const [width, region] of [
    [11, 12],
    [100, 30],
  ] as const) {
    const setup = await render(
      <box
        height={region}
        width={dialogAreaWidth(width)}
        marginLeft={2}
        overflow="hidden"
        flexDirection="column"
      >
        <OpenTuiSubagentCreateDialog
          config={creatorConfig}
          onClose={() => {
            throw new Error('unexpected creator close');
          }}
          availableTerminalHeight={region}
        />
      </box>,
      { width, height: 50 },
    );
    try {
      for (const [index, title] of [
        'Choose Location',
        'Choose Generation Method',
        'Enter Subagent Name',
      ].entries()) {
        if (index > 0)
          await act(async () => setup.mockInput.pressKey('RETURN'));
        if (index === 2) await act(async () => setup.mockInput.pressKey('Z'));
        await act(async () => setup.waitForVisualIdle());
        const frame = setup.renderer.root.getChildren()[0]?.getChildren()[0];
        assert(
          frame && frame.height <= region,
          `${width}x${region}: ${title} frame overflows`,
        );
        const rows = setup.captureCharFrame().split('\n');
        const visible = rows.slice(0, region).join('\n');
        assert(
          rows.slice(region).every((row) => row.trim() === ''),
          `${title}: paint outside creator region`,
        );
        if (index < 2) {
          assert.equal(
            rows.slice(0, region).filter((row) => row.includes('›')).length,
            1,
            `${title}: missing singular visible choice`,
          );
          const label =
            width === 11
              ? index === 0
                ? 'Pr…'
                : 'Ma…'
              : index === 0
                ? 'Project Level'
                : 'Manual Creation';
          assert(visible.includes(label), `${title}: choice label clipped`);
        }
        if (width === 100)
          assert(
            visible.includes(`Step ${index + 1}: ${title}`),
            `${title}: wrong manual step`,
          );
        if (index === 2)
          assert(
            visible.includes('Z'),
            'manual name field did not receive input',
          );
      }
    } finally {
      await destroy(setup);
    }
  }
  console.log('PASS: six real manual creator screen geometry checks');
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
    const fixtureDiff = execFileSync(
      'git',
      ['diff', '--no-ext-diff', '--no-textconv', '--color=never'],
      { encoding: 'utf8' },
    );
    assert(
      fixtureDiff.includes(`+${endMarker}`),
      'missing diff fixture last row',
    );
    assert.equal(
      fixtureDiff
        .split('\n')
        .filter((line) => line.startsWith('+') && !line.startsWith('+++'))
        .length,
      fixtureRows.length,
      'diff fixture must contain all added rows',
    );
    await boundedDialogs();
    await scrollAndResizeDialogs();
    await pickerResize();
    await creatorDialogs();
  } finally {
    process.chdir(originalDirectory);
    rmSync(fixture, { recursive: true, force: true });
  }
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
