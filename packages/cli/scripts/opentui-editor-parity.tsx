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
        userMessages={[]}
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
      editor.setText(text);
      editor.gotoBufferEnd();
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
        editor.gotoBufferHome();
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
      editor.setCursor(direction === 'k' ? 0 : 1, direction === 'k' ? 5 : 0),
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

  await reset('original');
  await key('x', true);
  assert.equal(editor.plainText, editorOutput);
  await input(() => setup.resize(80, 20));
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
  assert.deepEqual(submissions, []);
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
console.log('PASS: native editing, word movement and external-edit undo');
