/* eslint-disable react/no-unknown-property */
/** @jsxImportSource @opentui/react */
/** Real native frames with mocked keyboard input; this is not a PTY test. */
import { act } from 'react';
import { DISPLAY_HOOK_EVENTS } from '../src/ui/components/hooks/constants.js';
import { HookEventName } from '@qwen-code/qwen-code-core/hooks/types.js';
import type { Config } from '@qwen-code/qwen-code-core/config/config.js';
import type { LoadedSettings } from '../src/config/settings.js';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { testRender } from '@opentui/react/test-utils';
import { useTerminalDimensions } from '@opentui/react';
import { ScrollBoxRenderable, type Renderable } from '@opentui/core';
import { OpenTuiDiffDialog } from '../src/ui/opentui/dialogs-misc.js';
import { OpenTuiHooksDialog } from '../src/ui/opentui/dialogs-hooks.js';
import { dialogAreaWidth } from '../src/ui/opentui/dialogs-shared.js';
type Setup = Awaited<ReturnType<typeof testRender>>;
const settings = { merged: {} } as LoadedSettings;
const steps = ['events', 'matchers', 'handlers', 'detail'];
const literal =
  '§ 甲乙丙 カナ 한글 ' +
  Array.from(
    { length: 80 },
    (_, i) => String.fromCharCode(0x400 + i) + ' ' + 'word '.repeat(4),
  ).join('\n') +
  ' ¶ ' +
  'word '.repeat(80) +
  '¤';
const config = {
  getDisableAllHooks: () => false,
  isSafeMode: () => false,
  getBareMode: () => false,
  isTrustedFolder: () => true,
  getSessionId: () => undefined,
  getHookSystem: () => ({
    getAllHooks: () =>
      Array.from({ length: 15 }, (_, i) => ({
        eventName: 'PreToolUse',
        matcher: i === 0 ? 'Read' : `matcher-${i}`,
        enabled: true,
        source: 'user',
        config: {
          type: 'command',
          command: literal,
          timeout: 123,
          async: true,
          statusMessage: '※',
        },
      })),
  }),
} as unknown as Config;
function all(n: Renderable): Renderable[] {
  return [n, ...n.getChildren().flatMap(all)];
}
function summary(s: Setup, region: number) {
  const painted = s.captureCharFrame().split('\n');
  const nodes = all(s.renderer.root);
  assert(
    !painted.slice(region).some((r: string) => r.trim()),
    `paint outside region ${region}: ${JSON.stringify(painted.slice(region).filter((r: string) => r.trim()))}`,
  );
  const frame = s.renderer.root.getChildren()[0]?.getChildren()[0];
  assert(
    frame && frame.height <= region,
    `native frame ${frame?.height} exceeds ${region}`,
  );
  return {
    frameHeight: s.renderer.root.getChildren()[0]?.getChildren()[0]?.height,
    overpaint: painted.slice(region).some((r: string) => r.trim()),
    outside: painted.slice(region).filter((r: string) => r.trim()),
    drawn: painted.slice(0, region),
    scrolls: nodes
      .filter((n) => n instanceof ScrollBoxRenderable)
      .map((n) => ({
        height: n.height,
        scrollHeight: n.scrollHeight,
        scrollTop: n.scrollTop,
      })),
  };
}
async function renderDiff(width: number, region: number, sandboxed: boolean) {
  let s: Setup | undefined;
  await act(async () => {
    s = await testRender(
      <box
        height={region}
        width={dialogAreaWidth(width)}
        marginLeft={2}
        overflow="hidden"
        flexDirection="column"
      >
        <OpenTuiDiffDialog
          config={
            { getShellExecutionSandbox: () => sandboxed } as unknown as Config
          }
          settings={settings}
          onClose={() => {}}
          availableTerminalHeight={region}
        />
      </box>,
      { width, height: 60 },
    );
  });
  assert(s);
  const setup = s;
  setup.renderer.start();
  await act(async () => setup.waitForVisualIdle());
  return s;
}
async function emptyHooks() {
  for (const event of [HookEventName.PreToolUse, HookEventName.Stop]) {
    let setup: Setup | undefined;
    function Responsive() {
      const { width, height } = useTerminalDimensions();
      return (
        <box
          height={height - 60}
          width={dialogAreaWidth(width)}
          marginLeft={2}
          overflow="hidden"
          flexDirection="column"
        >
          <OpenTuiHooksDialog
            settings={settings}
            onClose={() => {}}
            availableTerminalHeight={height - 60}
          />
        </box>
      );
    }
    await act(async () => {
      setup = await testRender(<Responsive />, { width: 100, height: 100 });
    });
    assert(setup);
    const ready = setup;
    ready.renderer.start();
    try {
      await act(async () => ready.waitForVisualIdle());
      for (let i = 0; i < DISPLAY_HOOK_EVENTS.indexOf(event); i++) {
        await act(async () => ready.mockInput.pressKey('ARROW_DOWN'));
      }
      await act(async () => ready.mockInput.pressEnter());
      await act(async () => ready.waitForVisualIdle());
      for (const width of [20, 40, 100])
        for (const region of [1, 2, 3, 4, 5, 6, 11, 12, 15, 40]) {
          await act(async () => ready.resize(width, region + 60));
          await act(async () => ready.waitForVisualIdle());
          if (width === 40 && region === 15) {
            const sb = all(ready.renderer.root).find(
              (n): n is ScrollBoxRenderable => n instanceof ScrollBoxRenderable,
            );
            assert(sb, 'missing empty scrollbox');
            const wordFrames: Record<string, string> = {};
            const words = ['event', 'settings.json'];
            for (let top = 0; top <= sb.scrollHeight; top++) {
              sb.scrollTo(top);
              await ready.renderOnce();
              summary(ready, region);
              const frame = ready.captureCharFrame();
              for (const word of words) {
                if (frame.includes(word)) wordFrames[word] ??= frame;
              }
            }
            console.log(
              JSON.stringify({
                case: 'empty-word-boundaries',
                event,
                width,
                region,
                wordFrames,
              }),
            );
            assert(
              words.every((word) => wordFrames[word]?.includes(word)),
              'empty 40x15: event/settings.json must be visible as complete words',
            );
          }
          console.log(
            JSON.stringify({
              case: 'empty-hooks',
              event,
              width,
              region,
              ...summary(ready, region),
            }),
          );
        }
    } finally {
      await act(async () => ready.renderer.destroy());
    }
  }
}

async function main() {
  await emptyHooks();
  for (const sandboxed of [true, false])
    for (const width of [20, 40, 100])
      for (const region of [1, 2, 3, 4, 5, 6, 15]) {
        const setup = await renderDiff(width, region, sandboxed);
        try {
          console.log(
            JSON.stringify({
              case: 'diff',
              sandboxed,
              width,
              region,
              ...summary(setup, region),
            }),
          );
          if (sandboxed) {
            const scroll = all(setup.renderer.root).find(
              (node): node is ScrollBoxRenderable =>
                node instanceof ScrollBoxRenderable,
            );
            assert(scroll, 'sandbox notice has no scrollbox');
            await act(async () => setup.mockInput.pressKey('END'));
            await act(async () => setup.waitForVisualIdle());
            assert(
              setup.captureCharFrame().includes('tool.'),
              `sandbox ${width}x${region}: End cannot reach the notice tail`,
            );
            if (scroll.scrollHeight > scroll.height) {
              assert(scroll.scrollTop > 0, 'End did not scroll the notice');
            }
            await act(async () => setup.mockInput.pressKey('HOME'));
            await act(async () => setup.waitForVisualIdle());
            assert.equal(
              scroll.scrollTop,
              0,
              'Home returns to the notice head',
            );
            summary(setup, region);
          }
        } finally {
          await act(async () => setup.renderer.destroy());
        }
      }
  for (const sandboxed of [true, false]) {
    let closes = 0;
    let s: Setup | undefined;
    function Responsive() {
      const { width, height } = useTerminalDimensions();
      return (
        <box
          height={height - 60}
          width={dialogAreaWidth(width)}
          marginLeft={2}
          overflow="hidden"
          flexDirection="column"
        >
          <OpenTuiDiffDialog
            config={
              { getShellExecutionSandbox: () => sandboxed } as unknown as Config
            }
            settings={settings}
            onClose={() => closes++}
            availableTerminalHeight={height - 60}
          />
        </box>
      );
    }
    await act(async () => {
      s = await testRender(<Responsive />, { width: 100, height: 100 });
    });
    assert(s);
    const setup = s;
    setup.renderer.start();
    await act(async () => setup.waitForVisualIdle());
    try {
      for (const [width, region] of [
        [20, 6],
        [40, 15],
        [100, 2],
        [40, 40],
      ]) {
        await act(async () => setup.resize(width, region + 60));
        await act(async () => setup.waitForVisualIdle());
        console.log(
          JSON.stringify({
            case: 'diff-resize',
            sandboxed,
            width,
            region,
            ...summary(setup, region),
          }),
        );
      }
      await act(async () => setup.mockInput.pressEscape());
      await act(async () => setup.waitForVisualIdle());
      assert.equal(closes, 1, 'Diff Esc closes');
      console.log(JSON.stringify({ case: 'diff-escape', sandboxed, closes }));
    } finally {
      await act(async () => setup.renderer.destroy());
    }
  }
  for (const step of steps) {
    let closes = 0;
    let s: Setup | undefined;
    function ResponsiveHooks() {
      const { width, height } = useTerminalDimensions();
      return (
        <box
          height={height - 60}
          width={dialogAreaWidth(width)}
          marginLeft={2}
          overflow="hidden"
          flexDirection="column"
        >
          <OpenTuiHooksDialog
            config={config}
            settings={settings}
            onClose={() => closes++}
            availableTerminalHeight={height - 60}
          />
        </box>
      );
    }
    await act(async () => {
      s = await testRender(<ResponsiveHooks />, { width: 100, height: 100 });
    });
    assert(s);
    const setup = s;
    setup.renderer.start();
    await act(async () => setup.waitForVisualIdle());
    try {
      for (let j = 0; j < steps.indexOf(step); j++) {
        await act(async () => setup.mockInput.pressEnter());
        await act(async () => setup.waitForVisualIdle());
      }
      console.log(
        JSON.stringify({
          case: 'hooks-step-entry',
          step,
          frame: setup.captureCharFrame(),
        }),
      );
      for (const width of [20, 28, 29, 40, 100])
        for (const region of [1, 2, 3, 4, 5, 6, 15, 40]) {
          await act(async () => setup.resize(width, region + 60));
          await act(async () => setup.waitForVisualIdle());
          console.log(
            JSON.stringify({
              case: 'hooks-resize',
              width,
              region,
              step,
              ...summary(setup, region),
            }),
          );
          if (step === 'matchers' && width === 100 && region === 15) {
            assert(
              setup.captureCharFrame().includes('matcher-2'),
              'last budgeted matcher absent',
            );
            assert(
              !setup.captureCharFrame().includes('matcher-3'),
              'matcher exceeds paid window',
            );
            for (let index = 0; index < 14; index++) {
              await act(async () => setup.mockInput.pressKey('ARROW_DOWN'));
              await act(async () => setup.waitForVisualIdle());
            }
            assert.match(
              setup.captureCharFrame(),
              /›\s+15\.\s+matcher-14/,
              'final matcher must be visibly selected',
            );
            await act(async () => setup.mockInput.pressEnter());
            await act(async () => setup.waitForVisualIdle());
            assert(
              setup.captureCharFrame().includes('Matcher: matcher-14'),
              'Enter did not commit the visibly selected matcher',
            );
            summary(setup, region);
            await act(async () => setup.mockInput.pressEscape());
            await act(async () => setup.waitForVisualIdle());
          }
          if (step === 'detail') {
            const sb: ScrollBoxRenderable | undefined = all(
              setup.renderer.root,
            ).find(
              (n): n is ScrollBoxRenderable => n instanceof ScrollBoxRenderable,
            );
            const seen = Object.fromEntries(
              [
                '§',
                '甲',
                '乙',
                '丙',
                'カ',
                'ナ',
                '한',
                '글',
                '¶',
                '¤',
                '※',
                ...Array.from({ length: 80 }, (_, i) =>
                  String.fromCharCode(0x400 + i),
                ),
              ].map((k) => [k, false]),
            );
            let settingsWordFrame: string | undefined;
            const scan = () => {
              const f = setup.captureCharFrame();
              if (f.includes('settings.json')) settingsWordFrame ??= f;
              for (const k of Object.keys(seen))
                seen[k as keyof typeof seen] ||= f.includes(k);
            };
            scan();
            assert(
              sb instanceof ScrollBoxRenderable,
              'missing detail scrollbox',
            );
            assert.equal(sb.scrollTop, 0, 'resize resets detail to head');
            if (region === 1) {
              assert(
                setup.captureCharFrame().includes('Event:'),
                'one-row detail starts with a hook field',
              );
              assert(
                !setup.captureCharFrame().includes('Hook details'),
                'one-row detail sheds its heading',
              );
            }
            for (let top = 0; top <= sb.scrollHeight; top++) {
              sb.scrollTo(top);
              await setup.renderOnce();
              scan();
            }
            assert(sb, `detail ${width}x${region}: no native scrollbox`);
            assert(
              Object.values(seen).every(Boolean),
              `detail ${width}x${region}: unreachable glyphs ${Object.entries(
                seen,
              )
                .filter(([, v]) => !v)
                .map(([k]) => k)
                .join('')}`,
            );
            if (width === 29 && region === 15) {
              console.log(
                JSON.stringify({
                  case: 'detail-word-boundaries',
                  width,
                  region,
                  frame: settingsWordFrame,
                }),
              );
              assert(
                settingsWordFrame?.includes('settings.json'),
                'detail 29x15: settings.json must be visible as a complete word',
              );
            }
            if (region === 40) {
              const press = async (key: string) => {
                await act(async () => setup.mockInput.pressKey(key));
                await act(async () => setup.waitForVisualIdle());
              };
              await press('HOME');
              assert.equal(sb.scrollTop, 0);
              await press('ARROW_DOWN');
              assert.equal(sb.scrollTop, 1);
              await press('ARROW_UP');
              assert.equal(sb.scrollTop, 0);
              await press('\x1b[6~');
              assert.equal(sb.scrollTop, sb.height);
              await press('\x1b[5~');
              assert.equal(sb.scrollTop, 0);
              await press('END');
              assert(sb.scrollTop > 0);
              const previousTop = sb.scrollTop;
              await act(async () => setup.resize(width, 110));
              await act(async () => setup.waitForVisualIdle());
              summary(setup, 50);
              const unchanged = all(setup.renderer.root).find(
                (node): node is ScrollBoxRenderable =>
                  node instanceof ScrollBoxRenderable,
              );
              assert.equal(
                unchanged?.scrollTop,
                previousTop,
                'unchanged viewport preserves scroll',
              );
              await act(async () => setup.resize(width, 100));
              await act(async () => setup.waitForVisualIdle());
              assert(
                s
                  .captureCharFrame()
                  .replace(/[│╭╰╯╮─▀▄█\s]/g, '')
                  .includes('help.'),
                'instruction tail unreachable',
              );
            }
            console.log(
              JSON.stringify({
                case: 'literal',
                width,
                region,
                seen,
                hasScrollbox: Boolean(sb),
              }),
            );
          }
        }
      for (let j = 0; j <= steps.indexOf(step); j++) {
        await act(async () => setup.mockInput.pressEscape());
        await act(async () => setup.waitForVisualIdle());
        assert.equal(
          closes,
          j === steps.indexOf(step) ? 1 : 0,
          `hooks ${step} Esc ${j + 1}`,
        );
        console.log(
          JSON.stringify({
            case: 'hooks-escape',
            step,
            back: j + 1,
            closes,
            frame: setup.captureCharFrame(),
          }),
        );
      }
    } finally {
      await act(async () => setup.renderer.destroy());
    }
  }
}
const originalCwd = process.cwd();
const originalGitCeiling = process.env['GIT_CEILING_DIRECTORIES'];
const emptyCwd = await mkdtemp(join(tmpdir(), 'qwen-hook-content-'));
try {
  // The non-sandbox case is an empty preview, independent of local changes.
  process.env['GIT_CEILING_DIRECTORIES'] = dirname(emptyCwd);
  process.chdir(emptyCwd);
  await main();
} catch (error) {
  console.error(error);
  process.exitCode = 1;
} finally {
  process.chdir(originalCwd);
  if (originalGitCeiling === undefined) {
    delete process.env['GIT_CEILING_DIRECTORIES'];
  } else {
    process.env['GIT_CEILING_DIRECTORIES'] = originalGitCeiling;
  }
  await rm(emptyCwd, { recursive: true, force: true });
}
