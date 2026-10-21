/* eslint-disable react/no-unknown-property */
/** @jsxImportSource @opentui/react */
/**
 * @license
 * Copyright 2026 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { act, type ReactNode } from 'react';
import { testRender } from '@opentui/react/test-utils';
import { useTerminalDimensions } from '@opentui/react';
import {
  RGBA,
  TextAttributes,
  type CapturedSpan,
  type Renderable,
} from '@opentui/core';
import type { Config } from '@qwen-code/qwen-code-core/config/config.js';
import {
  LoadedSettings,
  SettingScope,
  type Settings,
} from '../src/config/settings.js';
import { OpenTuiStatusLineDialog } from '../src/ui/opentui/dialogs-statusline.js';
import {
  OpenTuiFooter,
  type OpenTuiFooterProps,
} from '../src/ui/opentui/opentui-footer.js';
import { statusLineStyledText } from '../src/ui/opentui/status-line-text.js';
import { dialogAreaWidth } from '../src/ui/opentui/dialogs-shared.js';
import { applyOpenTuiTheme } from '../src/ui/opentui/theme.js';
import { getActiveOpenTuiTheme } from '../src/ui/opentui/theme-parity.js';
import { theme } from '../src/ui/semantic-colors.js';
import { StreamingState } from '../src/ui/types.js';
import type { StatusLineState } from '../src/ui/hooks/useStatusLine.js';

type Setup = Awaited<ReturnType<typeof testRender>>;
async function scenario(
  name: string,
  body: (context: {
    dir: string;
    mount: (ui: ReactNode, width?: number, height?: number) => Promise<Setup>;
  }) => Promise<void>,
) {
  const dir = fs.mkdtempSync(path.join(tmpdir(), 'qwen-statusline-native-'));
  const setups: Setup[] = [];
  let failure: unknown;
  const mount = async (ui: ReactNode, width = 120, height = 34) => {
    let setup: Setup | undefined;
    await act(async () => {
      setup = await testRender(ui, { width, height, exitOnCtrlC: false });
    });
    assert.ok(setup);
    setups.push(setup);
    setup.renderer.start();
    await idle(setup);
    return setup;
  };
  try {
    await body({ dir, mount });
  } catch (error) {
    failure = error;
    console.error(`FAIL: ${name}`);
  } finally {
    for (const setup of setups) {
      try {
        if (failure) console.error(setup.captureCharFrame());
      } catch (error) {
        failure ??= error;
      }
      try {
        await act(async () => setup.renderer.destroy());
      } catch (error) {
        failure ??= error;
      }
    }
    try {
      fs.rmSync(dir, { recursive: true, force: true });
      assert.ok(
        !fs.existsSync(dir),
        'owned settings directory was not removed',
      );
    } catch (error) {
      failure ??= error;
    }
  }
  if (failure) throw failure;
  console.log(`PASS: ${name}`);
}

const scopes = [
  SettingScope.System,
  SettingScope.SystemDefaults,
  SettingScope.User,
  SettingScope.Workspace,
];
const preset = {
  type: 'preset' as const,
  items: ['model'],
  useThemeColors: false,
  hideContextIndicator: true,
};
function settingsAt(
  dir: string,
  populated = [SettingScope.User],
  trusted = true,
) {
  const files = scopes.map((scope) => {
    const settings = {
      $version: 4,
      ...(populated.includes(scope)
        ? { ui: { statusLine: structuredClone(preset) } }
        : {}),
    } as Settings;
    const file = path.join(dir, `${scope}.json`);
    fs.writeFileSync(file, JSON.stringify(settings, null, 2) + '\n');
    return {
      path: file,
      settings,
      originalSettings: structuredClone(settings),
    };
  });
  return new LoadedSettings(
    files[0],
    files[1],
    files[2],
    files[3],
    trusted,
    new Set(),
  );
}
const bytes = (settings: LoadedSettings) =>
  Object.fromEntries(
    scopes.map((scope) => [
      scope,
      fs.readFileSync(settings.forScope(scope).path, 'utf8'),
    ]),
  );
const stats = {
  sessionId: 'u3-native-session',
  lastPromptTokenCount: 250,
  metrics: { models: {}, files: { totalLinesAdded: 0, totalLinesRemoved: 0 } },
} as StatusLineState['sessionStats'];
const state: StatusLineState = {
  sessionStats: stats,
  currentModel: 'u3-native-model',
  branchName: 'main',
  activeWorktree: null,
  streamingState: StreamingState.Idle,
};
function configFor(record: (v: unknown) => void = () => {}) {
  return {
    getTargetDir: () => '/owned/project',
    getCliVersion: () => 'native-fixture',
    getModel: () => 'u3-native-model',
    getModelDisplayName: () => 'U3 Native Model',
    getContentGeneratorConfig: () => ({ contextWindowSize: 1000 }),
    getShellExecutionSandbox: () => undefined,
    getChatRecordingService: () => ({ recordSlashCommand: record }),
  } as unknown as Config;
}

async function idle(s: Setup) {
  await act(async () => s.waitForVisualIdle({ maxFrames: 30 }));
}
async function key(s: Setup, value: string) {
  await act(async () => {
    if (value !== 'ESCAPE') {
      s.mockInput.pressKey(value);
      return;
    }
    await new Promise<void>((resolve, reject) => {
      const finish = (event: { name: string }) => {
        if (event.name !== 'escape') return;
        clearTimeout(timer);
        s.renderer.keyInput.off('keypress', finish);
        resolve();
      };
      const timer = setTimeout(() => {
        s.renderer.keyInput.off('keypress', finish);
        reject(new Error('Escape decoder did not emit within 1s'));
      }, 1000);
      s.renderer.keyInput.on('keypress', finish);
      s.mockInput.pressKey('ESCAPE');
    });
  });
  await idle(s);
}
async function type(s: Setup, value: string) {
  for (const char of value) await key(s, char);
}
const frame = (s: Setup) => s.captureCharFrame();
function span(s: Setup, char: string): CapturedSpan {
  const matches = s
    .captureSpans()
    .lines.flatMap((line) => line.spans)
    .filter((v) => v.text.includes(char));
  assert.equal(matches.length, 1, `native glyph ${char} must have one span`);
  assert.equal(
    matches[0].text.split(char).length - 1,
    1,
    `native glyph ${char} must be unique`,
  );
  return matches[0];
}
const rgb = (color: CapturedSpan['fg']) => color.toInts().slice(0, 3);
function nodes(r: Renderable): Renderable[] {
  return [r, ...r.getChildren().flatMap(nodes)];
}
function regionGeometry(s: Setup, region: number) {
  assert.ok(
    !frame(s)
      .split('\n')
      .slice(region)
      .some((line) => line.trim()),
    'paint escaped owned dialog region',
  );
  const outer = s.renderer.root.getChildren()[0],
    content = outer?.getChildren()[0];
  assert.ok(content);
  assert.ok(
    content.height <= region,
    `dialog height ${content.height} exceeds ${region}, overflow clip cannot count as fit`,
  );
  for (const n of nodes(content))
    assert.ok(
      n.width <= s.renderer.width,
      `renderable width ${n.width} exceeds terminal`,
    );
}
function DialogRegion(
  props: Omit<
    Parameters<typeof OpenTuiStatusLineDialog>[0],
    'availableTerminalHeight'
  >,
) {
  const { width, height } = useTerminalDimensions();
  return (
    <box
      height={height - 4}
      width={dialogAreaWidth(width)}
      marginLeft={2}
      flexDirection="column"
      overflow="hidden"
    >
      <OpenTuiStatusLineDialog
        {...props}
        availableTerminalHeight={height - 4}
      />
    </box>
  );
}
function checked(s: Setup, label: string, selected: boolean) {
  const row = frame(s)
    .split('\n')
    .find((line) => line.includes(label) && /\[[ x]\]/.test(line));
  assert.ok(row, `missing checkbox ${label}`);
  assert.equal(row.includes('[x]'), selected);
}

applyOpenTuiTheme(getActiveOpenTuiTheme());

await scenario('styles-rgb-bg-dim-reset-osc8', async ({ mount }) => {
  const ansi =
    'P\x1b[38;2;12;34;56mF\x1b[48;2;65;43;21mB\x1b[1;2mD\x1b[22mN\x1b[0mR\x1b]8;;https://example.invalid/u3\x07L\x1b]8;;\x07U';
  const styled = statusLineStyledText(ansi, { dim: false });
  assert.equal(styled.chunks.map((c) => c.text).join(''), 'PFBDNRLU');
  assert.equal(
    styled.chunks.find((c) => c.text.includes('L'))?.link?.url,
    'https://example.invalid/u3',
  );
  assert.equal(
    styled.chunks.find((c) => c.text.includes('U'))?.link,
    undefined,
  );
  const s = await mount(<text content={styled} />, 40, 8);
  assert.deepEqual(rgb(span(s, 'F').fg), [12, 34, 56]);
  assert.deepEqual(rgb(span(s, 'B').bg), [65, 43, 21]);
  assert.equal(
    span(s, 'D').attributes & (TextAttributes.BOLD | TextAttributes.DIM),
    TextAttributes.BOLD | TextAttributes.DIM,
  );
  assert.equal(
    span(s, 'N').attributes & (TextAttributes.BOLD | TextAttributes.DIM),
    0,
  );
  assert.deepEqual(rgb(span(s, 'R').fg), rgb(span(s, 'P').fg));
  assert.deepEqual(rgb(span(s, 'R').bg), rgb(span(s, 'P').bg));
  const colon = statusLineStyledText(
    '\u009b38:2::12:34:56mC\u009b0mZ\x1b[2JX\x1b]8;;https://example.invalid/st\x1b\\T\x1b]8;;\x1b\\V',
    { dim: false },
  );
  assert.deepEqual(
    colon.chunks
      .find((c) => c.text.includes('C'))
      ?.fg?.toInts()
      .slice(0, 3),
    [12, 34, 56],
  );
  assert.equal(colon.chunks.map((c) => c.text).join(''), 'CZXTV');
  assert.equal(
    colon.chunks.find((c) => c.text.includes('T'))?.link?.url,
    'https://example.invalid/st',
  );
  assert.equal(colon.chunks.find((c) => c.text.includes('V'))?.link, undefined);
  await mount(<text content={colon} />, 24, 8);
  const indexed = statusLineStyledText(
    '\x1b[31;44mA\x1b[38;5;196;48;5;21mI\x1b[39;49mZ',
    { dim: false },
  );
  const first = indexed.chunks.find((c) => c.text.includes('A')),
    second = indexed.chunks.find((c) => c.text.includes('I'));
  assert.equal(first?.fg?.intent, 'indexed');
  assert.equal(first?.fg?.slot, 1);
  assert.equal(first?.bg?.slot, 4);
  assert.equal(second?.fg?.slot, 196);
  assert.equal(second?.bg?.slot, 21);
  assert.equal(indexed.chunks.find((c) => c.text.includes('Z'))?.fg, undefined);
  assert.equal(indexed.chunks.find((c) => c.text.includes('Z'))?.bg, undefined);
  await mount(<text content={indexed} />, 24, 8);
  for (const [sgr, slot] of [
    ['\x1b[38;5;0m', 0],
    ['\x1b[38;5;255m', 255],
    ['\x1b[38;5;256m', null],
    ['\x1b[38;5;999m', null],
    ['\x1b[48:5:300m', null],
  ] as const) {
    const value = statusLineStyledText(`${sgr}X\x1b[0mZ`, { dim: false });
    assert.equal(value.chunks.map((c) => c.text).join(''), 'XZ');
    if (slot !== null) {
      assert.equal(value.chunks[0]?.fg?.intent, 'indexed');
      assert.equal(value.chunks[0]?.fg?.slot, slot);
    } else {
      assert.equal(value.chunks[0]?.fg, undefined);
      assert.equal(value.chunks[0]?.bg, undefined);
    }
    assert.equal(value.chunks.at(-1)?.fg, undefined);
    assert.equal(value.chunks.at(-1)?.bg, undefined);
    const rendered = await mount(<text content={value} />, 20, 4);
    assert.match(frame(rendered), /XZ/);
  }
});

await scenario(
  'footer-real-styledtext-color-policy-and-geometry',
  async ({ dir, mount }) => {
    const settings = settingsAt(dir);
    for (const [, respectUserColors, useThemeColors] of [
      ['user', true, false],
      ['theme', false, true],
      ['dim', false, false],
    ] as const) {
      const props: OpenTuiFooterProps = {
        config: configFor(),
        settings,
        sessionStats: stats,
        activeWorktree: null,
        streaming: false,
        statusLine: {
          lines: ['P\x1b[38;2;12;34;56mF\x1b[0mR'],
          respectUserColors,
          useThemeColors,
          hideContextIndicator: true,
        },
      };
      const s = await mount(<OpenTuiFooter {...props} />, 80, 12);
      assert.deepEqual(rgb(span(s, 'F').fg), [12, 34, 56]);
      assert.equal(
        Boolean(span(s, 'P').attributes & TextAttributes.DIM),
        !respectUserColors && !useThemeColors,
      );
      assert.deepEqual(rgb(span(s, 'R').fg), rgb(span(s, 'P').fg));
      if (useThemeColors)
        assert.deepEqual(
          rgb(span(s, 'P').fg),
          rgb(RGBA.fromHex(theme.text.accent)),
        );
    }
    const long = '甲🙂 '.repeat(80) + 'TAIL_NOT_ON_FIRST_TWO_ROWS';
    for (const [width, height] of [
      [24, 8],
      [80, 12],
      [120, 30],
    ]) {
      const s = await mount(
        <OpenTuiFooter
          config={configFor()}
          settings={settings}
          sessionStats={stats}
          activeWorktree={null}
          streaming={false}
          statusLine={{
            lines: [long, 'SECOND_SOURCE_ROW', 'THIRD_SOURCE_ROW'],
            respectUserColors: true,
            useThemeColors: false,
            hideContextIndicator: true,
          }}
        />,
        width,
        height,
      );
      const lines = frame(s)
        .split('\n')
        .filter((v) => v.trim());
      assert.equal(lines.length, 2);
      assert.ok(!frame(s).includes('THIRD_SOURCE_ROW'));
      assert.ok(!frame(s).includes('TAIL_NOT_ON_FIRST_TWO_ROWS'));
      assert.ok(!frame(s).includes('�'));
      await act(async () => s.resize(120, 30));
      await idle(s);
      assert.equal(
        frame(s)
          .split('\n')
          .filter((line) => line.trim()).length,
        2,
      );
      assert.ok(!frame(s).includes('THIRD_SOURCE_ROW'));
      assert.ok(!frame(s).includes('TAIL_NOT_ON_FIRST_TWO_ROWS'));
      assert.ok(!frame(s).includes('�'));
    }
  },
);

await scenario(
  'footer-context-ink-text-and-warning-color',
  async ({ dir, mount }) => {
    const settings = settingsAt(dir);
    for (const used of [250, 1250]) {
      const s = await mount(
        <OpenTuiFooter
          config={configFor()}
          settings={settings}
          sessionStats={{ ...stats, lastPromptTokenCount: used }}
          activeWorktree={null}
          streaming={false}
          statusLine={{
            lines: [],
            respectUserColors: false,
            useThemeColors: true,
            hideContextIndicator: false,
          }}
        />,
        120,
        8,
      );
      assert.equal(
        frame(s).trim(),
        used === 250 ? '25.0% context used' : '>100% context used',
      );
      const expected = used === 250 ? theme.text.secondary : theme.status.error;
      assert.deepEqual(rgb(span(s, '%').fg), rgb(RGBA.fromHex(expected)));
    }
  },
);

await scenario(
  'dialog-checkbox-filter-noresults-escape-cancel',
  async ({ dir, mount }) => {
    const settings = settingsAt(dir),
      initial = bytes(settings),
      added: unknown[] = [],
      recorded: unknown[] = [];
    let closed = 0;
    const s = await mount(
      <DialogRegion
        settings={settings}
        config={configFor((v) => recorded.push(v))}
        state={state}
        addItem={(v) => {
          added.push(v);
          return 1;
        }}
        onClose={() => {
          closed++;
        }}
      />,
    );
    checked(s, 'Use theme colors', false);
    await key(s, ' ');
    checked(s, 'Use theme colors', true);
    await type(s, 'total-input');
    checked(s, 'total-input-tokens', false);
    assert.ok(!frame(s).includes('git-branch'));
    await key(s, ' ');
    checked(s, 'total-input-tokens', true);
    assert.ok(frame(s).includes('0 total in'));
    await key(s, 'ESCAPE');
    assert.equal(closed, 0);
    assert.ok(frame(s).includes('git-branch'));
    await type(s, 'zzzzzz');
    assert.ok(frame(s).includes('No preset items match.'));
    await key(s, 'RETURN');
    assert.equal(closed, 0);
    assert.deepEqual(bytes(settings), initial);
    await key(s, 'BACKSPACE');
    assert.ok(frame(s).includes('> zzzzz'));
    await key(s, 'DELETE');
    assert.ok(frame(s).includes('> zzzz'));
    await key(s, 'ESCAPE');
    assert.equal(closed, 0);
    await key(s, 'ESCAPE');
    assert.equal(closed, 1);
    assert.deepEqual(bytes(settings), initial);
    assert.deepEqual(added, []);
    assert.deepEqual(recorded, []);
  },
);

await scenario(
  'dialog-compact-escape-cancels-hidden-query',
  async ({ dir, mount }) => {
    const settings = settingsAt(dir),
      before = bytes(settings);
    let closed = 0;
    const s = await mount(
      <DialogRegion
        settings={settings}
        config={configFor()}
        state={state}
        addItem={() => {
          throw new Error('cancel must not add feedback');
        }}
        onClose={() => {
          closed++;
        }}
      />,
    );
    await key(s, ' ');
    await type(s, 'identifier');
    await act(async () => s.resize(80, 9));
    await idle(s);
    assert.ok(!frame(s).includes('Type to search'));
    await key(s, 'ESCAPE');
    assert.equal(closed, 1);
    assert.deepEqual(bytes(settings), before);
  },
);

for (const [label, populated, trusted, expected] of [
  ['user', [SettingScope.User], true, SettingScope.User],
  [
    'system',
    [SettingScope.System, SettingScope.User, SettingScope.Workspace],
    true,
    SettingScope.System,
  ],
  [
    'workspace',
    [SettingScope.Workspace, SettingScope.User],
    true,
    SettingScope.Workspace,
  ],
  [
    'untrusted',
    [SettingScope.Workspace, SettingScope.User],
    false,
    SettingScope.User,
  ],
  ['defaults-only', [SettingScope.SystemDefaults], true, SettingScope.User],
] as const)
  await scenario(`dialog-save-${label}`, async ({ dir, mount }) => {
    const settings = settingsAt(dir, [...populated], trusted),
      before = bytes(settings),
      added: unknown[] = [],
      recorded: unknown[] = [];
    let closed = 0;
    const s = await mount(
      <DialogRegion
        settings={settings}
        config={configFor((v) => recorded.push(v))}
        state={state}
        addItem={(v) => {
          added.push(v);
          return 1;
        }}
        onClose={() => {
          closed++;
        }}
      />,
    );
    await key(s, ' ');
    await key(s, 'RETURN');
    assert.equal(closed, 1);
    const saved = JSON.parse(
      fs.readFileSync(settings.forScope(expected).path, 'utf8'),
    ).ui.statusLine;
    assert.deepEqual(saved, {
      type: 'preset',
      useThemeColors: true,
      items: ['model'],
      ...(label === 'defaults-only' ? {} : { hideContextIndicator: true }),
    });
    const after = bytes(settings);
    for (const scope of scopes)
      if (scope !== expected) assert.equal(after[scope], before[scope]);
    assert.equal(added.length, 1);
    assert.deepEqual(added[0], {
      type: 'info',
      text: `Status line preset saved to ${expected.toLowerCase()} settings.`,
    });
    assert.deepEqual(recorded, [
      { phase: 'result', rawCommand: '/statusline', outputHistoryItems: added },
    ]);
  });

await scenario(
  'dialog-resize-hidden-query-and-one-row-reachability',
  async ({ dir, mount }) => {
    const settings = settingsAt(dir);
    let closed = 0;
    const s = await mount(
      <DialogRegion
        settings={settings}
        config={configFor()}
        state={state}
        addItem={() => 1}
        onClose={() => {
          closed++;
        }}
      />,
    );
    await type(s, 'identifier');
    assert.ok(frame(s).includes('session-id'));
    assert.ok(!frame(s).includes('project-name'));
    for (const [width, region] of [
      [24, 1],
      [80, 5],
      [120, 15],
      [80, 16],
      [120, 30],
    ]) {
      await act(async () => s.resize(width, region + 4));
      await idle(s);
      regionGeometry(s, region);
      assert.equal(frame(s).includes('Type to search'), region >= 16);
      if (region >= 16) {
        assert.ok(frame(s).includes('> identifier'));
        assert.ok(frame(s).includes('session-id'));
      }
    }
    await key(s, 'ESCAPE');
    await act(async () => s.resize(80, 5));
    await idle(s);
    regionGeometry(s, 1);
    const labels = [
      'Use theme colors',
      'project-name',
      'git-branch',
      'model-with-reasoning',
      'model-only',
      'context-remaining',
      'total-input-tokens',
      'total-output-tokens',
      'current-dir',
      'pull-request-number',
      'branch-changes',
      'context-used',
      'run-state',
      'qwen-version',
      'context-window-size',
      'used-tokens',
      'session-id',
    ];
    // Filtering may have left the cursor on session-id; one down wraps to first.
    if (frame(s).includes('session-id')) await key(s, 'ARROW_DOWN');
    for (let i = 0; i < labels.length; i++) {
      assert.ok(frame(s).includes(labels[i]), `unreachable ${labels[i]}`);
      regionGeometry(s, 1);
      if (i + 1 < labels.length) await key(s, 'ARROW_DOWN');
    }
    await key(s, ' ');
    assert.ok(frame(s).includes('[x]'));
    await key(s, 'RETURN');
    assert.equal(closed, 1);
    assert.deepEqual(
      settings.forScope(SettingScope.User).settings.ui?.statusLine,
      { ...preset, items: ['model', 'session-id'] },
    );
  },
);

console.log('statusline native: all 11 scenarios passed');
