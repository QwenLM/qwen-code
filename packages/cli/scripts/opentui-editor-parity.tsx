/** @jsxImportSource @opentui/react */
/** Native textarea regression; external process behavior has its own PTY gate. */
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
// @ts-expect-error Bun-only native runner; no Bun globals in the Node build.
import { mock } from 'bun:test';
import { act } from 'react';
import type { OpenTuiComposerHandle } from '../src/ui/opentui/input-submission.js';
import type { VimBuffer } from '../src/ui/hooks/vim.js';
import { TextareaRenderable, type Renderable } from '@opentui/core';
import { testRender } from '@opentui/react/test-utils';

const scratch = await mkdtemp(join(tmpdir(), 'qwen-native-editor-'));
const here = dirname(fileURLToPath(import.meta.url));
const keys = ['HOME', 'QWEN_HOME', 'QWEN_RUNTIME_DIR'] as const;
const previousEnv = Object.fromEntries(
  keys.map((key) => [key, process.env[key]]),
);
const nodes = (node: Renderable): Renderable[] => [
  node,
  ...node.getChildren().flatMap(nodes),
];
let ui: Awaited<ReturnType<typeof testRender>> | undefined;
const submissions: string[] = [];
const composer = { current: null as OpenTuiComposerHandle | null };
const buffer = { current: null as VimBuffer | null };
const moveTo = (row: number, col: number) => {
  const owner = buffer.current!;
  owner.vimMoveToLine(row + 1);
  owner.vimMoveToLineStart();
  if (col >= [...owner.lines[row]].length) owner.vimAppendAtLineEnd();
  else if (col > 0) owner.vimMoveRight(col);
};
const longHistory = 'LONG_' + 'abcdef'.repeat(24) + '_TAIL_SENTINEL';
let editorOutput = 'external 甲🙂';
try {
  for (const key of keys) {
    process.env[key] = join(scratch, key.toLowerCase());
    await mkdir(process.env[key]!, { recursive: true });
  }
  mock.module(resolve(here, '../src/ui/opentui/slash-dispatch.js'), () => ({
    loadInteractiveCommands: async () => [],
  }));
  mock.module(resolve(here, '../src/ui/utils/external-editor.js'), () => ({
    editTextInExternalEditor: (
      _text: string,
      options: { beforeLaunch: () => void },
    ) => {
      options.beforeLaunch();
      return editorOutput;
    },
  }));
  const { OpenTuiInputPrompt } = await import(
    '../src/ui/opentui/input-prompt.js'
  );
  await act(async () => {
    ui = await testRender(
      <OpenTuiInputPrompt
        composerHandle={composer}
        vim={{ buffer, handleInput: () => false, enabled: false }}
        userMessages={[longHistory, 'HISTORY_OLD', 'HISTORY_NEW']}
        onSubmit={(text) => {
          submissions.push(text);
          return true;
        }}
      />,
      { width: 40, height: 12, exitOnCtrlC: false },
    );
  });
  assert(ui);
  const setup = ui;
  setup.renderer.start();
  const input = async (action: () => void | Promise<void>) => {
    await act(async () => {
      await action();
    });
    await act(async () => setup.waitForVisualIdle());
  };
  const key = (name: string, ctrl = false, shift = false) =>
    input(() => {
      if (name === 'z' && ctrl && shift) {
        setup.renderer.stdin.emit('data', Buffer.from('\x1b[27;6;122~'));
      } else setup.mockInput.pressKey(name, { ctrl, shift });
    });
  const type = (text: string) =>
    input(() => {
      setup.renderer.stdin.emit('data', Buffer.from(text));
    });
  const editor = nodes(setup.renderer.root).find(
    (node): node is TextareaRenderable => node instanceof TextareaRenderable,
  );
  assert(editor);
  const reset = (text: string) =>
    input(() => {
      composer.current!.setText(text);
    });

  for (const home of ['HOME', 'a']) {
    await reset('first\nsecond');
    await key(home, home === 'a');
    await key(home, home === 'a');
    await type('X');
    assert.equal(editor.plainText, 'first\nXsecond');
  }
  const mixed = 'alpha,甲乙🙂 beta.gamma\n下一段 zeta';
  for (const [sequence, fromStart, index] of [
    ['\x1b[1;5D', false, 25],
    ['\x1b[1;5D'.repeat(4), false, 20],
    ['\x1b[1;5C', true, 5],
    ['\x1b[1;5C'.repeat(4), true, 10],
    ['\x1b[1;3D'.repeat(2), false, 22],
    ['\x1b[1;3C'.repeat(3), true, 8],
    ['\x1bb'.repeat(4), false, 20],
    ['\x1bf'.repeat(4), true, 10],
  ] as const) {
    await reset(mixed);
    if (fromStart)
      await input(() => {
        moveTo(0, 0);
      });
    await type(sequence);
    await type('WORD_MARK');
    const points = [...mixed];
    assert.equal(
      editor.plainText,
      points.slice(0, index).join('') +
        'WORD_MARK' +
        points.slice(index).join(''),
    );
  }
  for (const direction of ['k', 'u']) {
    await reset('first\nsecond');
    await input(() =>
      moveTo(direction === 'k' ? 0 : 1, direction === 'k' ? 5 : 0),
    );
    await key(direction, true);
    assert.equal(editor.plainText, 'firstsecond');
    await key('z', true);
    assert.equal(editor.plainText, 'first\nsecond');
    await key('z', true, true);
    await type('X');
    assert.equal(editor.plainText, 'firstXsecond');
  }
  await reset('base');
  await key('ARROW_LEFT');
  await key('BACKSPACE');
  assert.equal(editor.plainText, 'bae');
  await key('z', true);
  assert.equal(editor.plainText, 'base');
  await key('z', true, true);
  assert.equal(editor.plainText, 'bae');

  // A visual row inside one logical line must move before recalling history.
  const wrapped = '甲🙂e\u0301'.repeat(30) + '尾';
  await reset(wrapped);
  assert(editor.editorView.getTotalVirtualLineCount() > 1);
  const offset = editor.cursorOffset;
  await key('p', true);
  assert.equal(editor.plainText, wrapped);
  assert(editor.cursorOffset < offset);
  await input(() => {
    moveTo(0, 0);
  });
  await key('p', true);
  assert.equal(editor.plainText, 'HISTORY_NEW');
  await input(() => {
    buffer.current!.vimMoveToLastLine();
    buffer.current!.vimAppendAtLineEnd();
  });
  await key('n', true);
  assert.equal(editor.plainText, wrapped);
  for (const [width, height] of [
    [24, 10],
    [80, 20],
  ]) {
    await input(() => setup.resize(width, height));
    assert.equal(editor.plainText, wrapped);
    await key('HOME');
    const row: number = editor.scrollY + editor.visualCursor.visualRow;
    await key('HOME');
    assert.equal(editor.scrollY + editor.visualCursor.visualRow, row);
  }

  await reset('NEW');
  await key('r', true);
  await act(async () =>
    setup.waitForFrame(
      (frame) =>
        frame.includes('HISTORY_NEW') && !frame.includes('HISTORY_OLD'),
    ),
  );
  await key('TAB', false, true);
  assert.equal(editor.plainText, 'HISTORY_NEW');
  assert.equal(submissions.length, 0);
  await type('_tail');
  await key('RETURN');
  assert.deepEqual(submissions, ['HISTORY_NEW_tail']);
  await reset('甲🙂tail');
  await input(() => moveTo(0, 2));
  await key('r', true);
  await type('no-match');
  await key('ESCAPE');
  await act(async () => setup.waitForFrame((frame) => !frame.includes('(r:)')));
  await type('X');
  assert.equal(editor.plainText, '甲🙂Xtail');

  await input(() => setup.resize(100, 30));
  await reset('LONG_');
  await key('r', true);
  const candidate = () => {
    const rows = setup.captureCharFrame().split('(r:)').at(-1)!.split('\n');
    const start = rows.findIndex((line) => line.trimStart().startsWith('> '));
    assert(start >= 0, 'active search row must be visible');
    return rows.slice(start).join('\n');
  };
  await act(async () =>
    setup.waitForFrame((frame) => {
      const body = frame.split('(r:)').at(-1)!;
      return body.includes('→') && !body.includes('HISTORY_NEW');
    }),
  );
  const collapsed = longHistory.slice(0, 147) + '...';
  const visibleLabel = () =>
    candidate()
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean)
      .join('')
      .replace(/^> /, '')
      .replace(/ [←→]/, '');
  assert.equal(visibleLabel(), collapsed);
  assert(!candidate().includes('TAIL_SENTINEL'));
  for (const modifier of [5, 3]) {
    await type(`\x1b[1;${modifier}C`);
    assert(candidate().includes('←'));
    assert.equal(visibleLabel(), longHistory);
    await type(`\x1b[1;${modifier}D`);
    assert(candidate().includes('→'));
    assert.equal(visibleLabel(), collapsed);
    assert.equal(editor.plainText, 'LONG_');
    assert.deepEqual(submissions, ['HISTORY_NEW_tail']);
  }
  await input(() => setup.resize(40, 12));
  assert(candidate().includes('→'));
  assert.equal(visibleLabel(), collapsed);
  await key('ESCAPE');
  await act(async () => setup.waitForFrame((frame) => !frame.includes('(r:)')));
  await reset('TAIL_SENTINEL');
  await key('r', true);
  await act(async () =>
    setup.waitForFrame((frame) => {
      const body = frame.split('(r:)').at(-1)!;
      return body.includes('→') && !body.includes('LONG_');
    }),
  );
  assert.equal(visibleLabel(), '...' + longHistory.slice(-147));
  await key('ESCAPE');
  await act(async () => setup.waitForFrame((frame) => !frame.includes('(r:)')));

  await reset('original');
  await key('x', true);
  assert.equal(editor.plainText, editorOutput);
  await input(() => setup.resize(40, 12));
  await type('X');
  assert.equal(editor.plainText, `${editorOutput}X`);
  await key('z', true);
  assert.equal(editor.plainText, editorOutput);
  await key('z', true);
  assert.equal(
    editor.plainText,
    'original',
    'one native undo reverses the whole external edit',
  );
  await key('z', true, true);
  assert.equal(editor.plainText, editorOutput);
  await type('Y');
  assert.equal(editor.plainText, `${editorOutput}Y`);
  await key('z', true);
  assert.equal(editor.plainText, editorOutput);
  editorOutput = editor.plainText;
  await key('x', true);
  await key('z', true);
  assert.equal(
    editor.plainText,
    'original',
    'unchanged external output adds no undo entry',
  );
  await type('_after');
  assert.equal(editor.plainText, 'original_after');
} catch (error) {
  if (ui) console.error(ui.captureCharFrame());
  throw error;
} finally {
  try {
    if (ui) {
      await act(async () => ui!.renderer.destroy());
    }
  } finally {
    await rm(scratch, { recursive: true, force: true });
    for (const key of keys) {
      if (previousEnv[key] === undefined) delete process.env[key];
      else process.env[key] = previousEnv[key];
    }
  }
}
console.log(
  'PASS: native editing, visual history, search and external-edit undo',
);
