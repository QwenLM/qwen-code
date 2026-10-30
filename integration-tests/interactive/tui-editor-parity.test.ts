/**
 * @license
 * Copyright 2026 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';
import { InteractiveSession } from './interactive-session.js';
import {
  startFakeOpenAIServer,
  fakeToolCall,
  type FakeOpenAIServer,
} from '../fake-openai-server.js';
import { pickE2eRenderer, resolveE2eCliCommand } from '../renderer-matrix.js';
import { E2E_MEMORY_SETTINGS_DEFAULTS } from '../e2e-memory-defaults.js';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '../..');
const renderer = pickE2eRenderer();
const runtime = resolveE2eCliCommand(renderer);
const sleep = (ms: number) => new Promise<void>((done) => setTimeout(done, ms));
const sha = (bytes: string | Buffer) =>
  createHash('sha256').update(bytes).digest('hex');
const json = (file: string, value: unknown) =>
  writeFileSync(file, JSON.stringify(value, null, 2) + '\n');
const keys = {
  left: '\x1b[D',
  right: '\x1b[C',
  up: '\x1b[A',
  down: '\x1b[B',
  home: '\x1b[H',
  end: '\x1b[F',
  undo: '\x1a',
  // modifyOtherKeys is decoded by both renderers without Kitty negotiation.
  redo: '\x1b[27;6;122~',
  editor: '\x18',
};

async function until(check: () => boolean | Promise<boolean>, label: string) {
  const deadline = Date.now() + 12_000;
  while (!(await check())) {
    if (Date.now() > deadline) throw new Error(label);
    await sleep(100);
  }
}

function lastUser(server: FakeOpenAIServer): string {
  const messages = server.requests.at(-1)?.body['messages'];
  if (!Array.isArray(messages)) throw new Error('missing wire messages');
  const message = messages.findLast(
    (value: unknown) =>
      typeof value === 'object' &&
      value !== null &&
      'role' in value &&
      value.role === 'user',
  );
  if (!message || typeof message !== 'object' || !('content' in message))
    throw new Error('missing user content');
  if (typeof message.content === 'string') return message.content;
  if (!Array.isArray(message.content)) throw new Error('unknown user content');
  return message.content
    .filter((part: { type?: string }) => part.type === 'text')
    .map((part: { text?: string }) => part.text ?? '')
    .filter(
      (text: string) =>
        !/^<system-reminder>[\s\S]*<\/system-reminder>$/.test(text.trim()),
    )
    .join('');
}

type Context = {
  session: InteractiveSession;
  server: FakeOpenAIServer;
  editorLog: string;
  workspace: string;
  ownedTemp: string;
  sentinel: string;
  release: () => void;
  restart: () => Promise<InteractiveSession>;
  control: (value: Record<string, unknown>) => void;
  frame: (name: string) => Promise<string>;
  press: (sequence: string, settle?: boolean) => Promise<void>;
  type: (value: string) => Promise<void>;
  paste: (value: string) => Promise<void>;
  submit: (expected: string, sequence?: string) => Promise<void>;
};

async function scenario(
  name: string,
  run: (context: Context) => Promise<void>,
  cols = 100,
  responseMode: 'normal' | 'held' | 'confirmation' = 'normal',
) {
  const expectedHead = process.env['QWEN_TEST_EXPECTED_HEAD'];
  const head = execFileSync('git', ['rev-parse', 'HEAD'], {
    cwd: root,
    encoding: 'utf8',
  }).trim();
  if (expectedHead) expect(head).toBe(expectedHead);
  const out =
    process.env['QWEN_TUI_ACCEPTANCE_OUT'] ??
    join(root, '.qwen/e2e-tests/tui-editor-parity');
  mkdirSync(out, { recursive: true });
  const evidence = mkdtempSync(
    join(out, `editor-${runtime}-${renderer}-${name}-`),
  );
  const scratch = mkdtempSync(join(tmpdir(), 'qwen-editor-parity-'));
  const workspace = join(scratch, 'workspace');
  const home = join(scratch, 'qwen-home');
  const runtimeDir = join(scratch, 'runtime');
  const system = join(scratch, 'system.json');
  const defaults = join(scratch, 'defaults.json');
  const temp = join(scratch, 'temp');
  for (const dir of [workspace, home, runtimeDir, temp]) mkdirSync(dir);
  const editor = join(scratch, 'owned-editor.mjs');
  copyFileSync(join(here, 'fixtures/owned-editor.mjs'), editor);
  chmodSync(editor, 0o700);
  const controlFile = join(scratch, 'editor-control.json');
  const editorLog = join(scratch, 'editor.jsonl');
  const sentinel = join(scratch, 'must-not-execute');
  let release!: () => void;
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  json(controlFile, { behavior: 'changed' });
  json(join(home, 'settings.json'), {
    security: {
      auth: { selectedType: 'openai' },
      folderTrust: { enabled: false },
    },
    general: { enableAutoUpdate: false, showSessionRecap: false },
    ui: { enableFollowupSuggestions: false },
    memory: E2E_MEMORY_SETTINGS_DEFAULTS,
  });
  const frames: Record<string, string> = {};
  const inputs: Array<{ kind: string; value: string; atMs: number }> = [];
  let session: InteractiveSession | undefined;
  let server: FakeOpenAIServer | undefined;
  let failure: string | undefined;
  let submittedCount = 0;
  const closedSessions: Array<
    { exitCode: number; signal?: number } | undefined
  > = [];
  const cleanupErrors: string[] = [];
  const frame = async (label: string) => {
    const value = await session!.viewport();
    frames[label] = value;
    return value;
  };
  const press = async (value: string, settle = true) => {
    if (settle) await session!.idle(150, 500);
    inputs.push({ kind: 'key', value, atMs: Date.now() });
    session!.pressKey(value);
    if (settle) await session!.idle(150, 500);
  };
  const type = async (value: string) => {
    await session!.idle(150, 500);
    inputs.push({ kind: 'typed', value, atMs: Date.now() });
    for (const char of value) {
      session!.pressKey(char);
      await sleep(8);
    }
    await session!.idle(150, 500);
  };
  const paste = (value: string) => press('\x1b[200~' + value + '\x1b[201~');
  const submit = async (expected: string, sequence = '\r') => {
    const before = submittedCount;
    expect(server!.requests).toHaveLength(before);
    await frame(`before-submit-${before}`);
    await press(sequence);
    await until(
      () => server!.requests.length > before,
      'Enter must produce a request',
    );
    await until(
      async () =>
        (await frame(`reply-${before}`)).includes(`U2B_REPLY_${before}`),
      'response must be visible',
    );
    await session!.idle(300, 800);
    expect(server!.requests).toHaveLength(before + 1);
    expect(lastUser(server!)).toBe(expected);
    submittedCount++;
  };
  try {
    json(system, { $version: 4 });
    json(defaults, { $version: 4 });
    server = await startFakeOpenAIServer(({ requestIndex }) => {
      if (requestIndex === 0 && responseMode === 'held')
        return {
          contentChunks: ['HELD_HEAD', 'HELD_TAIL'],
          holdAfterChunks: 1,
          holdUntil: held,
        };
      if (requestIndex === 0 && responseMode === 'confirmation')
        return {
          toolCalls: [
            fakeToolCall(
              'run_shell_command',
              {
                command: `echo UNEXPECTED > '${sentinel}'`,
                description: 'Owned negative side-effect sentinel',
              },
              'editor-confirmation',
            ),
          ],
        };
      return { content: `U2B_REPLY_${requestIndex}` };
    });
    const args = [
      '--auth-type',
      'openai',
      '--openai-api-key',
      'fixture',
      '--openai-base-url',
      server.baseUrl,
      '--model',
      'qwen-vl-baseline',
      '--approval-mode',
      'default',
    ];
    const launch = () =>
      InteractiveSession.start({
        cwd: workspace,
        cols,
        rows: 30,
        inheritEnv: false,
        args,
        env: {
          PATH: process.env['PATH'],
          HOME: scratch,
          QWEN_HOME: home,
          QWEN_RUNTIME_DIR: runtimeDir,
          QWEN_CODE_SYSTEM_SETTINGS_PATH: system,
          QWEN_CODE_SYSTEM_DEFAULTS_PATH: defaults,
          TMPDIR: temp,
          TMP: temp,
          TEMP: temp,
          VISUAL: editor,
          EDITOR: join(scratch, 'must-not-win'),
          QWEN_U2B_EDITOR_CONTROL: controlFile,
          QWEN_U2B_EDITOR_LOG: editorLog,
          TERM: 'xterm-256color',
          LANG: 'en_US.UTF-8',
          QWEN_CODE_LANG: 'en',
          QWEN_SANDBOX: 'false',
          QWEN_CODE_DISABLE_CRON: '1',
          QWEN_CODE_SKIP_UPDATE_CHECK_ONCE: 'true',
          QWEN_CODE_MODELS_DEV_REFRESH: 'off',
          NO_PROXY: 'localhost,127.0.0.1',
          no_proxy: 'localhost,127.0.0.1',
        },
      });
    const ready = async () => {
      await until(
        async () => !(await session!.viewport()).includes('Initializing...'),
        'initialization must finish',
      );
      await session!.idle(300, 1_000);
    };
    session = await launch();
    await ready();
    await frame('ready');
    await run({
      session,
      server,
      editorLog,
      workspace,
      ownedTemp: realpathSync(temp),
      sentinel,
      release,
      restart: async () => {
        await frame('before-restart');
        await session!.close();
        writeFileSync(join(evidence, 'before-restart.ansi'), session!.output());
        closedSessions.push(session!.exitResult());
        session = await launch();
        await ready();
        return session;
      },
      control: (value) => json(controlFile, value),
      frame,
      press,
      type,
      paste,
      submit,
    });
  } catch (error) {
    failure =
      error instanceof Error ? (error.stack ?? error.message) : String(error);
  } finally {
    release();
    const steps: Array<[string, () => void | Promise<unknown>]> = [
      [
        'capture frame',
        async () => {
          if (session) await frame('final');
        },
      ],
      ['close PTY', async () => session?.close()],
      ['close server', async () => server?.close()],
      [
        'copy editor log',
        () => {
          if (existsSync(editorLog))
            copyFileSync(editorLog, join(evidence, 'editor.jsonl'));
        },
      ],
      [
        'copy project settings',
        () => {
          const file = join(workspace, '.qwen', 'settings.json');
          if (existsSync(file))
            copyFileSync(file, join(evidence, 'project-settings.json'));
        },
      ],
      [
        'remove scratch',
        () => rmSync(scratch, { recursive: true, force: true }),
      ],
    ];
    for (const [label, cleanup] of steps) {
      try {
        await cleanup();
      } catch (error) {
        cleanupErrors.push(`${label}: ${String(error)}`);
      }
    }
    if (cleanupErrors.length)
      failure = [failure, ...cleanupErrors].filter(Boolean).join('\n');
    if (session)
      writeFileSync(join(evidence, 'terminal.ansi'), session.output());
    json(join(evidence, 'frames.json'), frames);
    json(join(evidence, 'inputs.json'), inputs);
    json(join(evidence, 'requests.json'), server?.requests ?? []);
    json(join(evidence, 'result.json'), {
      result: failure ? 'FAIL' : 'PASS',
      failure,
      cleanup: cleanupErrors.length ? 'FAIL' : 'PASS',
      source: head,
      workingDiffSha256: sha(
        execFileSync('git', ['diff', 'HEAD'], { cwd: root }),
      ),
      bundleSha256: existsSync(join(root, 'dist/cli.js'))
        ? sha(readFileSync(join(root, 'dist/cli.js')))
        : null,
      fixtureSha256: sha(readFileSync(fileURLToPath(import.meta.url))),
      editorFixtureSha256: sha(
        readFileSync(join(here, 'fixtures/owned-editor.mjs')),
      ),
      runtime,
      runtimeVersion: execFileSync(runtime, ['--version'], {
        encoding: 'utf8',
      }).trim(),
      renderer,
      strict: renderer === 'opentui',
      cols,
      terminalUnicodeVersion: '11',
      exitAfterCleanup: session?.exitResult(),
      closedSessions,
    });
  }
  if (failure) throw new Error(failure);
}

for (const test of [
  {
    name: 'home-multiline',
    text: 'first\nsecond',
    sequence: keys.home,
    expected: 'first\nXsecond',
  },
  {
    name: 'ctrl-a-idempotent',
    text: 'first\nsecond',
    sequence: '\x01\x01',
    expected: 'first\nXsecond',
  },
  {
    name: 'ctrl-k-joins-newline',
    text: 'first\nsecond',
    sequence: keys.left.repeat(7) + '\x0b',
    expected: 'firstXsecond',
  },
  {
    name: 'ctrl-u-joins-newline',
    text: 'first\nsecond',
    sequence: keys.left.repeat(6) + '\x15',
    expected: 'firstXsecond',
  },
  {
    name: 'unicode-caret',
    text: '甲🙂e\u0301尾',
    sequence: keys.left,
    expected: '甲🙂e\u0301X尾',
  },
]) {
  it(test.name, () =>
    scenario(test.name, async ({ paste, press, type, submit }) => {
      await paste(test.text);
      await press(test.sequence);
      await type('X');
      await submit(test.expected);
    }),
  );
}

it('word-movement-cjk-punctuation-newline', () =>
  scenario(
    'word-movement-cjk-punctuation-newline',
    async ({ paste, press, type, submit }) => {
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
        await paste(mixed);
        if (fromStart) await press(keys.left.repeat([...mixed].length));
        await press(sequence);
        await type('WORD_MARK');
        const points = [...mixed];
        await submit(
          points.slice(0, index).join('') +
            'WORD_MARK' +
            points.slice(index).join(''),
        );
      }
    },
  ));

for (const redo of [false, true]) {
  const name = redo ? 'redo-edit' : 'undo-edit';
  it(name, () =>
    scenario(name, async ({ type, press, submit }) => {
      await type('base');
      await press(keys.left);
      await press('\x7f');
      await press(keys.undo);
      if (redo) await press(keys.redo);
      await submit(redo ? 'bae' : 'base');
    }),
  );
}

it('ordinary-history-restores-draft', () =>
  scenario(
    'ordinary-history-restores-draft',
    async ({ type, press, submit }) => {
      await type('HISTORY_ALPHA');
      await submit('HISTORY_ALPHA');
      await type('HISTORY_BETA');
      await submit('HISTORY_BETA');
      await type('DRAFT');
      await press('\x01');
      await press('\x10');
      await submit('HISTORY_BETA');
      await type('SUCCESSOR');
      await press('\x01');
      await press('\x10');
      await press('\x05');
      await press('\x0e');
      await submit('SUCCESSOR');
    },
  ));

it('search-tab-enter-and-escape', () =>
  scenario(
    'search-tab-enter-and-escape',
    async ({ type, press, submit, server, frame }) => {
      await type('SEARCH_ALPHA');
      await submit('SEARCH_ALPHA');
      await type('SEARCH_BETA');
      await submit('SEARCH_BETA');
      for (const sequence of ['\x10', '\x0e', '\x1b[1;2A', '\x1b[1;2B']) {
        await press('\x12');
        await until(
          async () =>
            (await frame('search-live-history'))
              .split('(r:)')
              .at(-1)!
              .includes('SEARCH_BETA'),
          'live prompt history must reach search',
        );
        await press(sequence);
        await submit('SEARCH_BETA');
      }
      await type('ALPHA');
      await press('\x12');
      await sleep(300);
      await frame('search-match');
      await press('\t');
      await type('_TAB_MARKER');
      expect(server.requests).toHaveLength(6);
      await submit('SEARCH_ALPHA_TAB_MARKER');
      await type('BETA');
      await press('\x12');
      await sleep(300);
      await press('\x1b[Z');
      await type('_SHIFT_TAB');
      expect(server.requests).toHaveLength(7);
      await submit('SEARCH_BETA_SHIFT_TAB');
      await type('SEARCH_ALPHA_TAB_MARKER');
      await press('\x12');
      await sleep(300);
      await submit('SEARCH_ALPHA_TAB_MARKER', '\x1b\r');
      await type('ORIGINAL');
      await press(keys.left.repeat(4));
      await press('\x12');
      await type('no-match');
      await press('\x1b');
      await sleep(250);
      await type('X');
      await submit('ORIGXINAL');
      const long = 'LONG_' + 'abcdef'.repeat(24) + '_TAIL_SENTINEL';
      await type(long);
      await submit(long);
      for (const modifier of [5, 3]) {
        await press('\x12');
        const candidate = async (name: string) =>
          (await frame(`search-${modifier}-${name}`)).split('(r:)').at(-1)!;
        await until(
          async () => (await candidate('ready')).includes('→'),
          'long search candidate must expose expand arrow',
        );
        const label = (body: string) => {
          const rows = body.split('\n').map((line) => line.trim());
          const start = rows.findIndex((line) => line.startsWith('> LONG_'));
          expect(start).toBeGreaterThanOrEqual(0);
          return rows
            .slice(start, start + 2)
            .join('')
            .replace(/^> /, '')
            .replace(/ [←→]/, '');
        };
        let body = await candidate('collapsed');
        expect(body).not.toContain('TAIL_SENTINEL');
        expect(label(body)).toBe(long.slice(0, 150) + '...');
        const requestCount = server.requests.length;
        await press(`\x1b[1;${modifier}C`);
        body = await candidate('expanded');
        expect(body).toContain('←');
        expect(label(body)).toBe(long);
        await press(`\x1b[1;${modifier}D`);
        body = await candidate('recollapsed');
        expect(body).toContain('→');
        expect(body).not.toContain('TAIL_SENTINEL');
        expect(label(body)).toBe(long.slice(0, 150) + '...');
        expect(server.requests).toHaveLength(requestCount);
        await submit(long);
      }
    },
  ));

for (const behavior of ['changed', 'unchanged', 'nonzero', 'signal', 'delay']) {
  it(`external-editor-${behavior}`, () =>
    scenario(
      `external-editor-${behavior}`,
      async ({
        type,
        press,
        submit,
        editorLog,
        ownedTemp,
        control,
        session,
        frame,
      }) => {
        control({ behavior });
        await type('ORIGINAL');
        await press(keys.editor);
        await until(() => existsSync(editorLog), 'editor must be invoked');
        if (behavior === 'changed' || behavior === 'delay')
          await until(
            () =>
              readFileSync(editorLog, 'utf8').includes('"phase":"finished"'),
            'editor must finish',
          );
        await session.idle(300, 1_500);
        const log = readFileSync(editorLog, 'utf8')
          .trim()
          .split('\n')
          .map((line) => JSON.parse(line));
        expect(session.output()).toContain('OWNED_EDITOR_TERMINAL');
        expect(log[0].mode).toBe(0o600);
        expect(log[0].before).toBe('ORIGINAL');
        const editorTemp = dirname(log[0].realFile);
        expect(dirname(editorTemp)).toBe(ownedTemp);
        await until(
          () => !existsSync(editorTemp),
          'editor temp directory must be removed',
        );
        session.resize(80, 12);
        await session.idle(200, 800);
        await frame('after-resume-resize');
        session.resize(100, 30);
        await session.idle(200, 800);
        await type('_AFTER');
        await submit(
          behavior === 'changed' || behavior === 'delay'
            ? 'EDITOR_RESULT_甲🙂\nNEXT_AFTER'
            : 'ORIGINAL_AFTER',
        );
      },
    ));
}

it('shell-history-domain-and-persistence', () =>
  scenario(
    'shell-history-domain-and-persistence',
    async ({ type, press, server, workspace, restart, frame }) => {
      const output = join(workspace, 'shell-history-owned.txt');
      const first = `printf a >> '${output}'`;
      const second = `printf b >> '${output}'`;
      const contents = () =>
        existsSync(output) ? readFileSync(output, 'utf8') : '';
      await type('!');
      await type(first);
      await press('\r');
      await until(() => contents() === 'a', 'first shell command executes');
      await type(second);
      await press('\r');
      await until(() => contents() === 'ab', 'second shell command executes');
      await press(keys.up);
      await frame('shell-recalled');
      await press('\r');
      await until(
        () => contents() === 'abb',
        'Up recalls newest shell command',
      );
      await restart();
      await type('!');
      await press(keys.up);
      await press(keys.up);
      await frame('shell-persisted-oldest');
      await press('\r');
      await until(
        () => contents() === 'abba',
        'shell history survives restart and deduplicates',
      );
      expect(server.requests).toHaveLength(0);
    },
  ));

it('ctrl-d-nonempty-does-not-exit', () =>
  scenario(
    'ctrl-d-nonempty-does-not-exit',
    async ({ type, press, submit, session, frame }) => {
      await type('ABCD');
      await press(keys.left.repeat(2));
      await press('\x04');
      await frame('after-first-ctrl-d');
      expect(session.exitResult()).toBeUndefined();
      await press('\x04');
      await frame('after-second-ctrl-d');
      expect(session.exitResult()).toBeUndefined();
      await submit('AB');
    },
  ));

it('ctrl-c-clear-then-exit', () =>
  scenario(
    'ctrl-c-clear-then-exit',
    async ({ type, press, frame, session, server }) => {
      await type('DRAFT');
      expect(await frame('before-clear')).toContain('DRAFT');
      const firstKeyAt = Date.now();
      await press('\x03', false);
      let cleared = false;
      while (Date.now() - firstKeyAt < 700) {
        expect(session.exitResult()).toBeUndefined();
        const screen = await frame('after-clear');
        if (!screen.includes('DRAFT') && screen.includes('Type your message')) {
          cleared = true;
          break;
        }
        await sleep(20);
      }
      expect(cleared, 'clear must render within the bounded 700ms sample').toBe(
        true,
      );
      expect(
        Date.now() - firstKeyAt,
        'second key must stay inside Ink’s 1000ms window',
      ).toBeLessThan(850);
      await press('\x03', false);
      await until(
        () => session.exitResult() !== undefined,
        'second Ctrl+C must exit',
      );
      expect(session.exitResult()?.exitCode).toBe(0);
      expect(server.requests).toHaveLength(0);
    },
  ));

for (const key of ['c', 'd'] as const) {
  it(`streaming-cancel-${key}`, () =>
    scenario(
      `streaming-cancel-${key}`,
      async ({ type, press, frame, session, server, release }) => {
        await type('CANCEL_ORIGINAL');
        await press('\r');
        await until(
          async () => (await frame('held')).includes('HELD_HEAD'),
          'held model output',
        );
        expect(server.requests).toHaveLength(1);
        expect(lastUser(server)).toBe('CANCEL_ORIGINAL');
        const first = Date.now();
        await press(key === 'c' ? '\x03' : '\x04', false);
        if (key === 'c') {
          await sleep(180);
          expect(session.exitResult()).toBeUndefined();
          await frame('cancelled');
          expect(Date.now() - first).toBeLessThan(850);
          await press('\x03', false);
        } else {
          await until(
            async () => /^> CANCEL_ORIGINAL\s*$/m.test(await frame('restored')),
            'cancelled prompt returns to composer',
          );
          release();
          await press('\x04');
          expect(session.exitResult()).toBeUndefined();
          expect(await frame('restored-d-noop')).toMatch(
            /^> CANCEL_ORIGINAL\s*$/m,
          );
          await press('\x7f'.repeat('CANCEL_ORIGINAL'.length));
          await until(
            async () => /^>\s+Type your message/m.test(await frame('empty')),
            'explicitly clear restored prompt',
          );
          const armed = Date.now();
          await press('\x04', false);
          await sleep(100);
          expect(Date.now() - armed).toBeLessThan(850);
          await press('\x04', false);
        }
        await until(
          () => session.exitResult() !== undefined,
          'second exit key must exit',
        );
        expect(session.exitResult()?.exitCode).toBe(0);
        expect(server.requests).toHaveLength(1);
      },
      100,
      'held',
    ));
}

for (const key of ['c', 'd'] as const) {
  it(`confirmation-d-then-${key}`, () =>
    scenario(
      `confirmation-d-then-${key}`,
      async ({ type, press, frame, session, server, sentinel }) => {
        await type('CONFIRMATION_REQUEST');
        await press('\r');
        const pending = /Yes, allow once|Allow once/;
        await until(
          async () => pending.test(await frame('pending')),
          'owned tool approval must be visible',
        );
        const firstD = Date.now();
        await press('\x04', false);
        await sleep(150);
        expect(session.exitResult()).toBeUndefined();
        expect(await frame('d-keeps-confirmation')).toMatch(pending);
        expect(server.requests).toHaveLength(1);
        expect(existsSync(sentinel)).toBe(false);
        if (key === 'c') {
          const firstC = Date.now();
          await press('\x03', false);
          while (
            Date.now() - firstC < 650 &&
            pending.test(await frame('c-cancels'))
          )
            await sleep(20);
          expect(await frame('after-c')).not.toMatch(pending);
          expect(Date.now() - firstC).toBeLessThan(850);
          await press('\x03', false);
        } else {
          expect(Date.now() - firstD).toBeLessThan(850);
          await press('\x04', false);
        }
        await until(
          () => session.exitResult() !== undefined,
          'confirmation second key must exit',
        );
        expect(session.exitResult()?.exitCode).toBe(0);
        expect(existsSync(sentinel)).toBe(false);
      },
      100,
      'confirmation',
    ));
}

async function enableVim(context: Context) {
  await context.type('/vim');
  await context.press('\r');
  await context.session.waitFor('Entered Vim mode.', 12_000);
  await context.session.waitForScreen(
    (screen) => screen.includes('-- NORMAL --'),
    '-- NORMAL --',
    12_000,
  );
  await context.frame('vim-enabled');
  expect(context.server.requests).toHaveLength(0);
}

for (const paced of [false, true]) {
  const name = `vim-counted-delete-${paced ? 'paced' : 'single-write'}`;
  it(name, () =>
    scenario(name, async (context) => {
      await enableVim(context);
      await context.press('i');
      await context.session.waitForScreen(
        (screen) => screen.includes('-- INSERT --'),
        '-- INSERT --',
        12_000,
      );
      await context.type('one two three');
      await context.press('\x1b');
      await context.session.waitForScreen(
        (screen) => screen.includes('-- NORMAL --'),
        '-- NORMAL --',
        12_000,
      );
      await context.press('0');
      if (paced) for (const key of '2dw') await context.press(key);
      else await context.press('2dw');
      expect(await context.frame('after-counted-delete')).toMatch(/>\s*three/);
      await context.submit('three');
      expect(context.server.requests).toHaveLength(1);
    }),
  );
}

it('vim-pending-character-keeps-enter-and-draft', () =>
  scenario('vim-pending-character-keeps-enter-and-draft', async (context) => {
    await enableVim(context);
    await context.press('i');
    await context.type('pending draft');
    await context.press('\x1b');
    await context.session.waitForScreen(
      (screen) => screen.includes('-- NORMAL --'),
      '-- NORMAL --',
      12_000,
    );
    for (const command of ['r', 'f', 'F', 't', 'T']) {
      await context.press(command + '\r');
      expect(await context.frame(`pending-${command}`)).toContain(
        'pending draft',
      );
      expect(context.server.requests).toHaveLength(0);
      await context.press('\x1b');
    }
    await context.submit('pending draft');
    expect(context.server.requests).toHaveLength(1);
  }));

it('vim-insert-controls-and-disable', () =>
  scenario('vim-insert-controls-and-disable', async (context) => {
    await enableVim(context);
    await context.press('i');
    await context.type('甲🙂tail');
    // Ink's Vim INSERT dispatcher consumes these without readline kill/editor actions.
    await context.press('\x0b\x15\x18');
    expect(await context.frame('insert-controls')).toContain('甲🙂tail');
    expect(existsSync(context.editorLog)).toBe(false);
    await context.submit('甲🙂tail');
    await context.type('/vim');
    await context.press('\r');
    await context.session.waitFor('Exited Vim mode.', 12_000);
    await context.type('ordinary again');
    await context.submit('ordinary again');
    expect(context.server.requests).toHaveLength(2);
  }));

it(
  'permissions-edits-and-completes-without-model',
  () =>
    scenario(
      'permissions-edits-and-completes-without-model',
      async ({
        session,
        server,
        workspace,
        ownedTemp,
        type,
        press,
        paste,
        frame,
      }) => {
        const settingsFile = join(workspace, '.qwen', 'settings.json');
        const settings = () =>
          JSON.parse(readFileSync(settingsFile, 'utf8')) as {
            permissions?: { allow?: string[] };
            context?: { includeDirectories?: string[] };
          };
        const parent = join(ownedTemp, 'permission-parent');
        mkdirSync(parent);
        mkdirSync(join(parent, 'alpha'));
        mkdirSync(join(parent, '.hidden'));
        writeFileSync(join(parent, 'ordinary.txt'), 'fixture');
        await until(
          async () =>
            (await frame('permissions-ready')).includes('Type your message'),
          'composer ready',
        );
        await type('/permissions');
        await press('\r');
        await until(
          async () =>
            (await frame('permissions-list')).includes('Add a new rule'),
          'permission list',
        );
        await press('\r');
        await until(
          async () =>
            (await frame('rule-input')).includes('Enter permission rule'),
          'rule input',
        );
        await paste('Bash(lx)');
        await press(keys.left);
        await press('\x7f');
        await type('s');
        await press('\r');
        await until(
          async () =>
            (await frame('scope')).includes('Where should this rule be saved?'),
          'scope',
        );
        await press('\r');
        await until(
          () =>
            existsSync(settingsFile) &&
            settings().permissions?.allow?.includes('Bash(ls)') === true,
          'exact persisted rule',
        );
        expect(settings().permissions?.allow).toEqual(['Bash(ls)']);
        expect(settings().permissions?.allow).not.toContain('Bash(lx)');
        expect(settings().permissions?.allow).not.toContain('Bash(lxs)');
        for (let i = 0; i < 3; i++) await press('\t');
        await until(
          async () => (await frame('workspace-list')).includes('Add directory'),
          'workspace list',
        );
        await press('\r');
        await until(
          async () =>
            (await frame('directory-input')).includes(
              'Enter the path to the directory:',
            ),
          'directory input',
        );
        await paste(parent + '/');
        await until(
          async () => /alpha\/\s+directory/.test(await frame('candidate')),
          'real visible alpha candidate',
        );
        const candidates = await frame('candidate-qualified');
        expect(candidates).not.toMatch(/\.hidden\/\s+directory/);
        expect(candidates).not.toMatch(/ordinary\.txt\/\s+directory/);
        await press('\t');
        await press('\r');
        const selected = realpathSync(join(parent, 'alpha'));
        await until(
          () =>
            settings().context?.includeDirectories?.includes(selected) === true,
          'exact selected directory committed',
        );
        expect(settings().context?.includeDirectories).toEqual([selected]);
        expect(settings().context?.includeDirectories).not.toContain(
          realpathSync(parent),
        );
        const beforeCancel = readFileSync(settingsFile, 'utf8');
        await press('\r');
        await until(
          async () =>
            (await frame('cancel-input')).includes(
              'Enter the path to the directory:',
            ),
          'new directory form',
        );
        await paste(join(parent, 'missing'));
        await press('\x1b');
        await until(
          async () => (await frame('cancelled')).includes('Add directory'),
          'cancelled directory form',
        );
        expect(readFileSync(settingsFile, 'utf8')).toBe(beforeCancel);
        await press('\x1b');
        await until(
          async () => (await frame('composer')).includes('Type your message'),
          'composer',
        );
        await type('/quit');
        await press('\r');
        await until(() => session.exitResult() !== undefined, 'natural quit');
        expect(session.exitResult()?.exitCode).toBe(0);
        expect(session.exitResult()?.signal ?? 0).toBe(0);
        expect(server.requests).toHaveLength(0);
      },
    ),
  90_000,
);

it(
  'permissions-clear-undo-replace-without-model',
  () =>
    scenario(
      'permissions-clear-undo-replace-without-model',
      async ({ session, server, workspace, type, press, paste, frame }) => {
        const settingsFile = join(workspace, '.qwen', 'settings.json');
        const settings = () =>
          JSON.parse(readFileSync(settingsFile, 'utf8')) as {
            permissions?: { allow?: string[] };
          };
        const exitHint = 'Press Ctrl+C again to exit.';
        const originalRuleRow =
          renderer === 'ink'
            ? /^[ \t]*│[ \t]*│ > WebFetch[ \t]*│[ \t]*│[ \t]*$/m
            : /^[ \t]*│[ \t]*│ WebFetch[ \t]*│[ \t]*│[ \t]*$/m;
        await until(
          async () =>
            (await frame('clear-ready')).includes('Type your message'),
          'composer ready',
        );
        await type('/permissions');
        await press('\r');
        await until(
          async () => (await frame('clear-list')).includes('Add a new rule'),
          'permission list',
        );
        await press('\r');
        await until(
          async () =>
            (await frame('clear-input')).includes('Enter permission rule…'),
          'rule field',
        );
        await paste('WebFetch');
        await until(
          async () => originalRuleRow.test(await frame('clear-before')),
          'exact original rule',
        );
        await press('\x03');
        await until(async () => {
          const screen = await frame('clear-empty');
          return (
            screen.includes('Enter permission rule…') &&
            screen.includes(exitHint)
          );
        }, 'first C clears the field while global exit remains armed');
        expect(session.exitResult()).toBeUndefined();
        await press(keys.undo);
        await until(
          async () => originalRuleRow.test(await frame('clear-undo')),
          'Undo restores the whole original rule',
        );
        // Observe the existing guard expiry before another deliberate clear.
        // Otherwise its second C would correctly confirm process exit.
        await until(
          async () => !(await frame('clear-expired')).includes(exitHint),
          'first C guard expires before the separate replacement edit',
        );
        await press('\x03');
        await until(
          async () =>
            (await frame('replacement-empty')).includes(
              'Enter permission rule…',
            ),
          'second independent clear',
        );
        expect(session.exitResult()).toBeUndefined();
        await paste('Read');
        await press('\r');
        await until(
          async () =>
            (await frame('clear-scope')).includes(
              'Where should this rule be saved?',
            ),
          'replacement rule scope',
        );
        await press('\r');
        await until(
          () =>
            existsSync(settingsFile) &&
            settings().permissions?.allow?.includes('Read') === true,
          'replacement rule persisted',
        );
        expect(settings().permissions?.allow).toEqual(['Read']);
        await press('\x1b');
        await until(
          async () =>
            (await frame('clear-composer')).includes('Type your message'),
          'composer after Permissions',
        );
        await type('/quit');
        await press('\r');
        await until(() => session.exitResult() !== undefined, 'natural quit');
        expect(session.exitResult()?.exitCode).toBe(0);
        expect(session.exitResult()?.signal ?? 0).toBe(0);
        expect(server.requests).toHaveLength(0);
      },
    ),
  90_000,
);
