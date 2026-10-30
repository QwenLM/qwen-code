/** @jsxImportSource @opentui/react */
/** Native textarea/input regression; clipboard and command catalog are injected. */
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
// @ts-expect-error The Bun-only native runner has no types in the Node build.
import { mock } from 'bun:test';
import { act } from 'react';
import { TextareaRenderable, type Renderable } from '@opentui/core';
import { testRender } from '@opentui/react/test-utils';
import type { InputPromptProps } from '../src/ui/opentui/input-prompt.js';

const scratch = await mkdtemp(join(tmpdir(), 'qwen-native-input-'));
const scriptDir = dirname(fileURLToPath(import.meta.url));
const envKeys = ['HOME', 'QWEN_HOME', 'QWEN_RUNTIME_DIR'] as const;
const originalEnv = Object.fromEntries(
  envKeys.map((key) => [key, process.env[key]]),
);
const a = join(scratch, 'a.png');
const b = join(scratch, 'b.png');
let saveImage = async (): Promise<string | null> => a;
let accepted = false;
const submissions: Array<Parameters<InputPromptProps['onSubmit']>> = [];
const notices: string[] = [];
let setup: Awaited<ReturnType<typeof testRender>> | undefined;
const nodes = (node: Renderable): Renderable[] => [
  node,
  ...node.getChildren().flatMap(nodes),
];
function pending() {
  let resolve!: (path: string) => void;
  const promise = new Promise<string>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
try {
  for (const key of envKeys) {
    process.env[key] = join(scratch, key.toLowerCase());
    await mkdir(process.env[key]!, { recursive: true });
  }
  const png = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGP4z8AAAAMBAQDJ/pLvAAAAAElFTkSuQmCC',
    'base64',
  );
  await writeFile(a, png);
  await writeFile(b, png);
  const clipboard = await import('../src/ui/utils/clipboardUtils.js');
  mock.module(resolve(scriptDir, '../src/ui/utils/clipboardUtils.js'), () => ({
    ...clipboard,
    clipboardHasImage: async () => true,
    saveClipboardImage: () => saveImage(),
    cleanupOldClipboardImages: async () => {},
  }));
  mock.module(
    resolve(scriptDir, '../src/ui/opentui/slash-dispatch.js'),
    () => ({ loadInteractiveCommands: async () => [] }),
  );
  const { OpenTuiInputPrompt } = await import(
    '../src/ui/opentui/input-prompt.js'
  );
  await act(async () => {
    setup = await testRender(
      <OpenTuiInputPrompt
        userMessages={[]}
        onNotice={(message) => notices.push(message)}
        onSubmit={(...args) => {
          submissions.push(args);
          return accepted;
        }}
      />,
      { width: 80, height: 12, exitOnCtrlC: false },
    );
  });
  assert(setup);
  const ui = setup;
  ui.renderer.start();
  const idle = async () => {
    await act(async () => ui.waitForVisualIdle());
  };
  const input = async (action: () => void | Promise<void>) => {
    await act(async () => {
      await action();
    });
    await idle();
  };
  const key = (name: string, ctrl = false) =>
    input(() => ui.mockInput.pressKey(name, { ctrl }));
  const type = (text: string) => input(() => ui.mockInput.typeText(text));
  const editor = nodes(ui.renderer.root).find(
    (node): node is TextareaRenderable => node instanceof TextareaRenderable,
  );
  assert(editor, 'The native textarea must be mounted');
  await input(() => ui.mockInput.pasteBracketedText(JSON.stringify(a)));
  // A single act around the wait defers the async attachment update we need.
  const attachmentDeadline = Date.now() + 5_000;
  while (
    !/📎 clipboard-/.test(ui.captureCharFrame()) &&
    Date.now() < attachmentDeadline
  ) {
    await new Promise((done) => setTimeout(done, 10));
    await idle();
  }
  assert.match(ui.captureCharFrame(), /📎 clipboard-/);
  await key('RETURN');
  assert.equal(
    submissions.length,
    0,
    'Image-only Enter retains Ink no-op semantics',
  );
  await input(() => {
    ui.renderer.stdin.emit('data', Buffer.from('甲乙🙂尾\r'));
  });
  assert.equal(submissions.length, 1);
  assert.equal(submissions[0][0], '甲乙🙂尾');
  assert.deepEqual(await readFile(submissions[0][1]![0]), png);
  assert.equal(
    editor.plainText,
    '甲乙🙂尾',
    'Rejected native input is restored',
  );
  for (const [width, height] of [
    [40, 10],
    [80, 12],
  ]) {
    await input(() => ui.resize(width, height));
    assert(ui.captureCharFrame().includes('甲乙🙂尾'));
    assert(ui.captureCharFrame().includes('📎 clipboard-'));
  }
  await key('ARROW_UP');
  await key('DELETE');
  accepted = true;
  await key('q', true);
  assert.equal(submissions.length, 2);
  assert.equal(
    submissions[1][1],
    undefined,
    'Deleted chip is absent from the payload',
  );
  assert.equal(submissions[1][2]?.deferUntilIdle, true);

  const old = pending();
  saveImage = () => old.promise;
  await type('old');
  await key('v', true);
  await key('RETURN');
  await type('successor');
  assert.equal(submissions.length, 2);
  await input(() => old.resolve(a));
  assert.deepEqual(submissions[2].slice(0, 2), ['old', [a]]);
  assert.equal(editor.plainText, 'successor');
  await key('RETURN');
  assert.deepEqual(submissions[3].slice(0, 2), ['successor', undefined]);

  const first = pending();
  const second = pending();
  const saves = [first.promise, second.promise];
  saveImage = () => saves.shift()!;
  await type('ordered');
  await key('v', true);
  await key('v', true);
  await key('RETURN');
  await input(() => second.resolve(b));
  assert.equal(submissions.length, 4);
  await input(() => first.resolve(a));
  assert.deepEqual(submissions[4].slice(0, 2), ['ordered', [a, b]]);
  assert.equal(editor.plainText, '');

  saveImage = async () => a;
  await type('edit');
  await key('v', true);
  await key('ARROW_UP');
  await type('a');
  assert(ui.captureCharFrame().includes('📎 a.png'));
  await key('RETURN');
  assert.deepEqual(submissions[5].slice(0, 2), ['edita', [a]]);
  await type('queue selected');
  await key('v', true);
  await key('ARROW_UP');
  await key('q', true);
  assert.deepEqual(submissions[6].slice(0, 2), ['queue selected', [a]]);
  assert.equal(submissions[6][2]?.deferUntilIdle, true);
} finally {
  try {
    if (setup) await act(async () => setup!.renderer.destroy());
  } finally {
    for (const key of envKeys) {
      if (originalEnv[key] === undefined) delete process.env[key];
      else process.env[key] = originalEnv[key];
    }
    await rm(scratch, { recursive: true, force: true });
  }
}

console.log(
  JSON.stringify({
    nativeInput: 'PASS',
    submissions: submissions.length,
    widths: [40, 80],
    clipboard: 'injected',
    renderer: 'real',
  }),
);
