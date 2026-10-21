/** @jsxImportSource @opentui/react */
/** Real native buffer/undo + shared parser, compared with the real Ink buffer. */
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as childProcess from 'node:child_process';
import { act, useMemo, useRef, useState } from 'react';
import type { OpenTuiComposerHandle } from '../src/ui/opentui/input-submission.js';
// @ts-expect-error Bun-only native runner.
import { mock } from 'bun:test';
import { TextareaRenderable, type Renderable } from '@opentui/core';
import { useKeyboard } from '@opentui/react';
import { testRender } from '@opentui/react/test-utils';
import type { LoadedSettings } from '../src/config/settings.js';
import type { TextBuffer } from '../src/ui/components/shared/text-buffer.js';
import type { VimBuffer } from '../src/ui/hooks/vim.js';

const scratch = await mkdtemp(join(tmpdir(), 'qwen-native-vim-'));
const here = dirname(fileURLToPath(import.meta.url));
const dirKeys = [
  'HOME',
  'QWEN_HOME',
  'QWEN_RUNTIME_DIR',
  'XDG_CONFIG_HOME',
  'XDG_CACHE_HOME',
  'TMPDIR',
] as const;
const fileKeys = [
  'QWEN_CODE_SYSTEM_SETTINGS_PATH',
  'QWEN_CODE_SYSTEM_DEFAULTS_PATH',
] as const;
const envKeys = [...dirKeys, ...fileKeys];
const savedEnv = Object.fromEntries(
  envKeys.map((key) => [key, process.env[key]]),
);
const clipboardCalls: unknown[][] = [];
let ui: Awaited<ReturnType<typeof testRender>> | undefined;
let ink!: TextBuffer;
let native!: TextareaRenderable;
let adapter!: VimBuffer;
let modes: string[] = [];
let submissions: string[][] = [[], []];
let decoded = 0;
let failure: unknown;
const nodes = (node: Renderable): Renderable[] => [
  node,
  ...node.getChildren().flatMap(nodes),
];
try {
  for (const key of dirKeys) {
    process.env[key] = join(scratch, key.toLowerCase());
    await mkdir(process.env[key]!, { recursive: true });
  }
  for (const key of fileKeys) {
    process.env[key] = join(scratch, key.toLowerCase() + '.json');
    await writeFile(process.env[key]!, '{}');
  }
  mock.module('child_process', () => ({
    ...childProcess,
    execFile: (...args: unknown[]) => {
      clipboardCalls.push(args.slice(0, 2));
      throw new Error('Fixture blocks OS clipboard writes');
    },
    execFileSync: (...args: unknown[]) => {
      clipboardCalls.push(args.slice(0, 2));
      throw new Error('Fixture blocks OS clipboard reads');
    },
  }));
  const clipboard = await import('../src/ui/utils/clipboardUtils.js');
  mock.module(resolve(here, '../src/ui/utils/clipboardUtils.js'), () => ({
    ...clipboard,
    writeOsc52: (text: string) => {
      clipboardCalls.push(['OSC52', text]);
      return false;
    },
  }));
  mock.module(resolve(here, '../src/ui/opentui/slash-dispatch.js'), () => ({
    loadInteractiveCommands: async () => [],
  }));
  const { useTextBuffer } = await import(
    '../src/ui/components/shared/text-buffer.js'
  );
  const { useVim } = await import('../src/ui/hooks/vim.js');
  const { VimModeProvider } = await import(
    '../src/ui/contexts/VimModeContext.js'
  );
  const { createVimBuffer } = await import('../src/ui/opentui/vim-buffer.js');
  const { toOriginalKey } = await import('../src/ui/opentui/key-map.js');
  const { codePointIndexToDisplayCol } = await import(
    '../src/ui/opentui/input-prompt-model.js'
  );
  const settings = { merged: { general: { vimMode: true } } } as LoadedSettings;
  function Harness({ text }: { text: string }) {
    ink = useTextBuffer({
      initialText: text,
      initialCursorOffset: 0,
      viewport: { width: 40, height: 12 },
      isValidPath: () => false,
    });
    adapter = createVimBuffer(() => native ?? null);
    const left = useVim(ink, (value) => submissions[0].push(value));
    const right = useVim(adapter, (value) => submissions[1].push(value));
    modes = [left.mode, right.mode];
    useKeyboard((event) => {
      if (event.eventType === 'release') return;
      const key = toOriginalKey(event);
      assert.equal(
        right.handleInput(key),
        left.handleInput(key),
        `key owner: ${JSON.stringify(key)}`,
      );
      decoded++;
      event.preventDefault();
    });
    return (
      // eslint-disable-next-line react/no-unknown-property -- OpenTUI textarea props are not DOM attributes.
      <textarea initialValue={text} focused={false} width={40} height={8} />
    );
  }
  const idle = async () => act(async () => ui!.waitForVisualIdle());
  const change = async (run: () => void) => {
    await act(async () => run());
    await idle();
  };
  const same = (label: string) => {
    assert.equal(adapter.text, ink.text, `${label}: text`);
    assert.deepEqual(adapter.cursor, ink.cursor, `${label}: code-point caret`);
    assert.equal(modes[0], modes[1], `${label}: mode`);
  };
  const mount = async (text: string) => {
    if (ui) await act(async () => ui!.renderer.destroy());
    decoded = 0;
    submissions = [[], []];
    clipboardCalls.length = 0;
    await act(async () => {
      ui = await testRender(
        <VimModeProvider settings={settings}>
          <Harness text={text} />
        </VimModeProvider>,
        { width: 40, height: 12, exitOnCtrlC: false },
      );
    });
    ui!.renderer.start();
    native = nodes(ui!.renderer.root).find(
      (node): node is TextareaRenderable => node instanceof TextareaRenderable,
    )!;
    assert(native);
    await change(() => native.setCursor(0, 0));
  };
  const send = async (bytes: string, count?: number) => {
    const before = decoded;
    await change(() => ui!.renderer.stdin.emit('data', Buffer.from(bytes)));
    if (count !== undefined) {
      const deadline = Date.now() + 1_000;
      while (decoded < before + count && Date.now() < deadline) {
        await new Promise((done) => setTimeout(done, 10));
        await idle();
      }
      assert.equal(decoded, before + count, 'positive decoded-event count');
    }
    same(JSON.stringify(bytes));
  };

  // Every production Vim adapter method is exercised, including no-op and line boundaries.
  const actions: Array<[string, (buffer: VimBuffer) => void]> = [
    ['dw', (b) => b.vimDeleteWordForward(2)],
    ['db', (b) => b.vimDeleteWordBackward(2)],
    ['de', (b) => b.vimDeleteWordEnd(2)],
    ['cw', (b) => b.vimChangeWordForward(2)],
    ['cb', (b) => b.vimChangeWordBackward(2)],
    ['ce', (b) => b.vimChangeWordEnd(2)],
    ['dd', (b) => b.vimDeleteLine(2)],
    ['cc', (b) => b.vimChangeLine(2)],
    ['D', (b) => b.vimDeleteToEndOfLine()],
    ['C', (b) => b.vimChangeToEndOfLine()],
    ['ch', (b) => b.vimChangeMovement('h', 2)],
    ['dj', (b) => b.vimDeleteMovement('j', 2)],
    ['h', (b) => b.vimMoveLeft(2)],
    ['l', (b) => b.vimMoveRight(2)],
    ['j', (b) => b.vimMoveDown(2)],
    ['k', (b) => b.vimMoveUp(2)],
    ['w', (b) => b.vimMoveWordForward(2)],
    ['b', (b) => b.vimMoveWordBackward(2)],
    ['e', (b) => b.vimMoveWordEnd(2)],
    ['x', (b) => b.vimDeleteChar(2)],
    ['i', (b) => b.vimInsertAtCursor()],
    ['a', (b) => b.vimAppendAtCursor()],
    ['o', (b) => b.vimOpenLineBelow()],
    ['O', (b) => b.vimOpenLineAbove()],
    ['A', (b) => b.vimAppendAtLineEnd()],
    ['I', (b) => b.vimInsertAtLineStart()],
    ['0', (b) => b.vimMoveToLineStart()],
    ['$', (b) => b.vimMoveToLineEnd()],
    ['^', (b) => b.vimMoveToFirstNonWhitespace()],
    ['gg', (b) => b.vimMoveToFirstLine()],
    ['G', (b) => b.vimMoveToLastLine()],
    ['2G', (b) => b.vimMoveToLine(2)],
    ['Esc', (b) => b.vimEscapeInsertMode()],
  ];
  for (const [label, apply] of actions) {
    await mount('alpha beta\n  甲乙🙂tail\nlast word');
    await change(() => {
      ink.moveToOffset('alpha beta\n  甲'.length);
      native.setCursor(1, codePointIndexToDisplayCol(ink.lines[1], 3));
      apply(ink);
      apply(adapter);
    });
    same(label);
    await change(() => {
      ink.undo();
      adapter.undo();
    });
    same(`${label} undo`);
    await change(() => {
      ink.redo();
      native.redo();
    });
    same(`${label} redo`);
  }
  for (const [seed, bytes, text, col] of [
    ['one two three', '2dw', 'three', 0],
    ['one two three four five', '2dw.', 'five', 0],
    ['a x b x c', 'fx;', 'a x b x c', 6],
    ['ZZ', 'iabc\x1b', 'abcZZ', 2],
  ] as const) {
    for (const paced of [false, true]) {
      await mount(seed);
      if (paced) for (const char of bytes) await send(char, 1);
      else await send(bytes, [...bytes].length);
      assert.equal(adapter.text, text);
      assert.deepEqual(adapter.cursor, [0, col]);
      assert.deepEqual(modes, ['NORMAL', 'NORMAL']);
      assert.deepEqual(submissions, [[], []]);
      assert.deepEqual(
        clipboardCalls,
        [],
        'non-clipboard corpus must have no clipboard effects',
      );
    }
  }
  for (const command of ['r', 'f', 'F', 't', 'T']) {
    await mount('pending');
    await send(command + '\r', 2);
    assert.deepEqual(submissions, [[], []]);
    assert.equal(adapter.text, 'pending');
    await send('\x1b', 1);
    await send('\r', 1);
    assert.deepEqual(submissions, [['pending'], ['pending']]);
    assert.equal(
      adapter.text,
      'pending',
      'admission owner alone clears the draft',
    );
  }
  await mount('base');
  await change(() => {
    ink.setText('');
    native.replaceText('');
    ink.vimDeleteLine(1);
    adapter.vimDeleteLine(1);
  });
  for (const expected of ['', 'base']) {
    await change(() => {
      ink.undo();
      adapter.undo();
    });
    same('empty dd undo');
    assert.equal(adapter.text, expected);
  }
  await mount('base');
  await send('iX', 2);
  assert.equal(
    adapter.text,
    'Xbase',
    'positive edit before boundary Backspace',
  );
  await send('\x01', 1);
  assert.deepEqual(adapter.cursor, [0, 0]);
  await send('\x7f', 1);
  assert.equal(adapter.text, 'Xbase');
  await change(() => {
    ink.undo();
    adapter.undo();
  });
  same('origin Backspace does not occupy an undo step');
  assert.equal(adapter.text, 'base');
  for (const [bytes, count] of [
    ['i甲🙂e\u0301\x1b', 6],
    ['i\x01\x05\x1b', 4],
    ['i\x0b\x15\x18\x1b', 5],
    ['i\x7f\x1b', 3],
    ['i\x17\x1b', 3],
    ['i\x1bd\x1b', 3],
    ['i\x1b[1;5D\x1b', 3],
  ] as const) {
    await mount('alpha,甲乙🙂 beta\nnext');
    await send(bytes, count);
    // Native receives the real decoded event once; unrecognized controls are consumed.
    await change(() => {
      ink.undo();
      adapter.undo();
    });
    same('INSERT undo');
  }
  // Real composer owner: the native default handler must not insert/delete twice.
  await act(async () => ui!.renderer.destroy());
  const { OpenTuiInputPrompt } = await import(
    '../src/ui/opentui/input-prompt.js'
  );
  const accepted: string[] = [];
  let admit = false;
  let setModal!: (value: boolean) => void;
  let getComposerEditor!: () => TextareaRenderable | null;
  function Composer() {
    const [modal, updateModal] = useState(false);
    setModal = updateModal;
    const editor = useRef<TextareaRenderable | null>(null);
    const composer = useRef<OpenTuiComposerHandle | null>(null);
    const buffer = useMemo(() => createVimBuffer(() => editor.current), []);
    const { handleInput, vimModeEnabled } = useVim(buffer, (text) => {
      void composer.current?.submitDraft?.(text);
    });
    getComposerEditor = () => editor.current;
    useKeyboard(() => {
      decoded++;
    });
    return modal ? (
      <text>Owned modal</text>
    ) : (
      <OpenTuiInputPrompt
        composerHandle={composer}
        vim={{ editor, handleInput, enabled: vimModeEnabled }}
        userMessages={[]}
        onSubmit={(text) => {
          accepted.push(text);
          return admit;
        }}
      />
    );
  }
  await act(async () => {
    ui = await testRender(
      <VimModeProvider settings={settings}>
        <Composer />
      </VimModeProvider>,
      { width: 40, height: 12, exitOnCtrlC: false },
    );
  });
  ui!.renderer.start();
  native = nodes(ui!.renderer.root).find(
    (node): node is TextareaRenderable => node instanceof TextareaRenderable,
  )!;
  assert(native);
  const composerInput = async (bytes: string) => {
    const target = decoded + [...bytes].length;
    await change(() => ui!.renderer.stdin.emit('data', Buffer.from(bytes)));
    const deadline = Date.now() + 1_000;
    while (decoded < target && Date.now() < deadline) {
      await new Promise((done) => setTimeout(done, 10));
      await idle();
    }
    assert.equal(decoded, target, 'real composer decoded input');
  };
  await composerInput('ione two three');
  await composerInput('\x1b');
  await composerInput('02dw\r');
  assert.deepEqual(accepted, ['three']);
  assert.equal(
    native.plainText,
    'three',
    'rejected draft survives NORMAL Enter',
  );
  await composerInput('\x7f');
  assert.equal(
    native.plainText,
    'three',
    'raw Backspace belongs to NORMAL parser',
  );
  await composerInput('r\r');
  assert.deepEqual(
    accepted,
    ['three'],
    'pending character read must not submit',
  );
  await composerInput('\x1b');
  await composerInput('ixx');
  await composerInput('\x7f');
  assert.equal(native.plainText, 'threex', 'INSERT Backspace edits once');
  await composerInput('\x1b');
  admit = true;
  await composerInput('\r');
  assert.deepEqual(accepted, ['three', 'threex']);
  assert.equal(native.plainText, '', 'only successful admission clears');
  await composerInput('ione two three');
  await composerInput('\x1b');
  await composerInput('0yw');
  const writes = clipboardCalls.length;
  assert(writes > 0, 'real yank attempted only the blocked clipboard backend');
  await composerInput('2dw');
  assert.equal(native.plainText, 'three');
  await composerInput('2');
  await change(() => setModal(true));
  assert.equal(getComposerEditor(), null, 'unmounted textarea is not retained');
  assert.match(ui!.captureCharFrame(), /Owned modal/);
  await composerInput('dwp.');
  assert.equal(clipboardCalls.length, writes, 'modal keys never reach Vim');
  await change(() => setModal(false));
  native = getComposerEditor()!;
  assert(native);
  await change(() => {
    native.setText('a b c d');
    native.setCursor(0, 0);
  });
  await composerInput('w');
  assert.deepEqual(
    native.logicalCursor,
    { row: 0, col: 4 },
    'count survives modal',
  );
  await composerInput('0.');
  assert.equal(native.plainText, 'c d', 'dot register survives modal');
  await composerInput('P');
  assert.equal(
    native.plainText,
    'one c d',
    'internal yank register survives modal',
  );
  assert.equal(
    clipboardCalls.length,
    writes,
    'paste uses retained register, not OS',
  );
} catch (error) {
  if (ui) console.error(ui.captureCharFrame());
  failure = error;
} finally {
  for (const cleanup of [
    async () => {
      if (ui) await act(async () => ui!.renderer.destroy());
    },
    async () => rm(scratch, { recursive: true, force: true }),
  ]) {
    try {
      await cleanup();
    } catch (error) {
      failure = new Error(
        `${String(failure ?? '')}\ncleanup: ${String(error)}`,
      );
    }
  }
  for (const key of envKeys) {
    if (savedEnv[key] === undefined) delete process.env[key];
    else process.env[key] = savedEnv[key];
  }
}

if (failure) throw failure;
console.log(
  'PASS: 33 Vim actions, native undo/redo, batched parser, pending Enter, INSERT ownership; cleanup complete',
);
