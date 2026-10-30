/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';
import { E2E_MEMORY_SETTINGS_DEFAULTS } from '../e2e-memory-defaults.js';
import {
  fakeToolCall,
  startFakeOpenAIServer,
  type FakeOpenAIServer,
} from '../fake-openai-server.js';
import { pickE2eRenderer, resolveE2eCliCommand } from '../renderer-matrix.js';
import { InteractiveSession } from './interactive-session.js';

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, '../..');
const renderer = pickE2eRenderer();
const runtime = resolveE2eCliCommand(renderer);
const child = join(here, 'fixtures/owned-shell-child.mjs');
const firstInput = '494e4e45525f411b5b440d';
const resumedInput = '494e4e45525f411b5b440d494e4e45525f42';
const shiftedInput = '494e4e45525f411b5b440d494e4e45525f4209';
const pastedInput = '494e4e45525f411b5b440d494e4e45525f420950415354455fe794b2';
const sleep = (ms: number) => new Promise<void>((done) => setTimeout(done, ms));
const compact = (text: string) => text.replace(/\s/gu, '');
const quote = (text: string) => "'" + text.replaceAll("'", "'\\''") + "'";
const json = (file: string, value: unknown) =>
  writeFileSync(file, JSON.stringify(value, null, 2) + '\n');
const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};
async function until(
  check: () => boolean | Promise<boolean>,
  label: string,
  budget = 8000,
) {
  const end = Date.now() + budget;
  while (!(await check())) {
    if (Date.now() >= end) throw new Error(label);
    await sleep(50);
  }
}
type ChildEvent = {
  kind: string;
  token: string;
  pid: number;
  at: number;
  hex?: string;
  reason?: string;
  code?: number;
  stdinTTY?: boolean;
  stdoutTTY?: boolean;
  columns?: number;
  rows?: number;
};
type ShellContext = {
  session: InteractiveSession;
  server: FakeOpenAIServer;
  pid: number;
  command: string;
  reply: string;
  events: () => ChildEvent[];
  bytes: () => string;
  toolMessage: () => unknown;
  stage: (name: string) => void;
  key: (text: string, guardKey?: boolean) => Promise<void>;
  type: (text: string) => Promise<void>;
  send: (text: string) => Promise<void>;
  frame: (name: string) => Promise<string>;
  taskText: (name: string) => Promise<string>;
  release: () => Promise<void>;
  releaseExists: () => boolean;
};

async function withForegroundShell(
  name: string,
  check: (context: ShellContext) => Promise<void>,
) {
  const scratch = mkdtempSync(join(tmpdir(), 'qwen-foreground-shell-'));
  const workspace = join(scratch, 'workspace');
  const home = join(scratch, 'home');
  const runtimeDir = join(scratch, 'runtime');
  const temp = join(scratch, 'temp');
  const childDir = join(temp, 'fixture');
  const output =
    process.env['QWEN_TUI_ACCEPTANCE_OUT'] ??
    join(root, '.qwen/e2e-tests/tui-foreground-shell');
  for (const dir of [workspace, home, runtimeDir, temp, childDir, output])
    mkdirSync(dir, { recursive: true });
  const evidence = mkdtempSync(
    join(output, `shell-${name}-${runtime}-${renderer}-`),
  );
  json(join(home, 'settings.json'), {
    security: {
      auth: { selectedType: 'openai' },
      folderTrust: { enabled: false },
    },
    general: { enableAutoUpdate: false, showSessionRecap: false },
    ui: { enableFollowupSuggestions: false },
    tools: { shell: { enableInteractiveShell: true } },
    memory: E2E_MEMORY_SETTINGS_DEFAULTS,
  });
  const token = 'S_' + randomUUID().replaceAll('-', '').slice(0, 10);
  const callId = 'owned_foreground_' + token;
  const reply = 'FOREGROUND_REPLY_' + token;
  const command = `exec ${[process.execPath, child, childDir, token].map(quote).join(' ')}`;
  const log = join(childDir, 'child-events.jsonl');
  const releaseFile = join(childDir, 'RELEASE');
  const events = (): ChildEvent[] =>
    existsSync(log)
      ? readFileSync(log, 'utf8')
          .trim()
          .split('\n')
          .filter(Boolean)
          .map((line) => JSON.parse(line))
      : [];
  const bytes = () =>
    events()
      .filter((event) => event.kind === 'input')
      .map((event) => event.hex ?? '')
      .join('');
  const frames: Record<string, string> = {};
  const cells: Record<string, unknown> = {};
  const gutterMasks: Array<{ frame: string; row: number; column: number }> = [];
  const keys: Array<{ kind: string; text: string; at: number }> = [];
  let session: InteractiveSession | undefined;
  let pid: number | undefined;
  let phase = 'SETUP';
  let failure: unknown;
  let forcedClose = false;
  let childGoneBeforeCleanupRelease = false;
  const cleanupErrors: string[] = [];
  const server = await startFakeOpenAIServer(({ requestIndex }) =>
    requestIndex === 0
      ? {
          toolCalls: [
            fakeToolCall(
              'run_shell_command',
              {
                command,
                is_background: false,
                timeout: 60000,
                description: 'Owned foreground shell ' + token,
              },
              callId,
            ),
          ],
        }
      : { content: reply },
  );
  const toolMessage = () =>
    server.requests
      .slice(1)
      .flatMap((request) => {
        const messages = request.body['messages'];
        return Array.isArray(messages) ? messages : [];
      })
      .find(
        (message) =>
          message &&
          typeof message === 'object' &&
          message.role === 'tool' &&
          message.tool_call_id === callId,
      );
  try {
    const sha = (file: string) =>
      createHash('sha256').update(readFileSync(file)).digest('hex');
    json(join(evidence, 'INPUTS.json'), {
      name,
      renderer,
      runtime,
      head: execFileSync('git', ['rev-parse', 'HEAD'], {
        cwd: root,
        encoding: 'utf8',
      }).trim(),
      bundleSHA: sha(join(root, 'dist/cli.js')),
      fixtureSHA: sha(child),
      testSHA: sha(fileURLToPath(import.meta.url)),
      fixtureNode: process.execPath,
      runtimeVersion: execFileSync(runtime, ['--version'], {
        encoding: 'utf8',
      }).trim(),
      token,
      callId,
      command,
      scratch,
      byteOracles: {
        firstInput,
        resumedInput,
        shiftedInput,
        pastedInput,
        cancel: '464f4355535f43',
      },
      scope:
        'POSIX real scheduled foreground PTY and loopback model; not installed products, Windows or full VT acceptance.',
    });
    session = await InteractiveSession.start({
      cwd: workspace,
      cols: 100,
      rows: 40,
      inheritEnv: false,
      command: {
        bin: runtime,
        args: [
          join(root, 'dist/cli.js'),
          '--auth-type',
          'openai',
          '--openai-api-key',
          'fixture',
          '--openai-base-url',
          server.baseUrl,
          '--model',
          'qwen-vl-baseline',
          '--approval-mode',
          'yolo',
        ],
      },
      env: {
        PATH: process.env['PATH'],
        HOME: scratch,
        QWEN_HOME: home,
        QWEN_RUNTIME_DIR: runtimeDir,
        TMPDIR: temp,
        TMP: temp,
        TEMP: temp,
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
    const current = session;
    const frame = async (label: string) => {
      const text = await current.viewport();
      frames[label] = text;
      return text;
    };
    const key = async (text: string, guardKey = false) => {
      await current.idle(guardKey ? 20 : 150, guardKey ? 40 : 500);
      keys.push({ kind: 'key', text, at: Date.now() });
      current.pressKey(text);
      await current.idle(guardKey ? 20 : 150, guardKey ? 40 : 500);
    };
    const type = async (text: string) => {
      await current.idle(150, 500);
      keys.push({ kind: 'typed', text, at: Date.now() });
      for (const char of text) {
        current.pressKey(char);
        await sleep(8);
      }
      await current.idle(150, 500);
    };
    const send = async (text: string) => {
      await current.idle(150, 500);
      keys.push({ kind: 'command', text, at: Date.now() });
      await current.send(text);
      await current.idle(150, 500);
    };
    phase = 'FOREGROUND_PRECONDITION';
    await current.idle(300, 1000);
    await send('START_FOREGROUND_' + token);
    await until(
      () =>
        events().some(
          (event) => event.kind === 'ready' && event.token === token,
        ),
      'Actual foreground child did not report ready',
      10000,
    );
    const ready = events().find((event) => event.kind === 'ready')!;
    pid = ready.pid;
    assert(ready.stdinTTY && ready.stdoutTTY && alive(pid));
    expect(new Set(events().map((event) => event.pid)).size).toBe(1);
    expect(server.requests).toHaveLength(1);
    expect(bytes()).toBe('');
    const release = async () => {
      if (!existsSync(releaseFile))
        writeFileSync(releaseFile, token, { flag: 'wx' });
      await until(
        () => events().some((event) => event.kind === 'exit'),
        'Child did not naturally finish after RELEASE',
      );
      const ended = events().find((event) => event.kind === 'exit')!;
      expect(ended).toMatchObject({
        pid,
        reason: 'owned-release-file',
        code: 0,
      });
      await until(() => !alive(pid!), 'Released child PID remains');
    };
    await check({
      session: current,
      server,
      pid,
      command,
      reply,
      events,
      bytes,
      toolMessage,
      stage: (label) => {
        phase = label;
      },
      key,
      type,
      send,
      frame,
      release,
      releaseExists: () => existsSync(releaseFile),
      taskText: async (label) => {
        const rows = await current.viewportCells();
        frames[label] = rows.map((row) => row.text).join('\n');
        cells[label] = rows;
        return rows
          .map((row, y) => {
            expect(row.cells).toHaveLength(100);
            return row.cells
              .map((cell, x) => {
                if (renderer === 'opentui' && x === 99 && cell?.text === '█') {
                  gutterMasks.push({ frame: label, row: y, column: x });
                  return '';
                }
                return cell?.text ?? '';
              })
              .join('');
          })
          .join('\n');
      },
    });
    phase = 'COMPLETE';
  } catch (error) {
    failure = error;
  } finally {
    childGoneBeforeCleanupRelease = pid !== undefined && !alive(pid);
    if (!existsSync(releaseFile))
      writeFileSync(releaseFile, token, { flag: 'wx' });
    try {
      if (pid)
        await until(
          () => !alive(pid!),
          'Owned child remained during cleanup',
          10000,
        );
    } catch (error) {
      cleanupErrors.push(String(error));
    }
    if (session && !session.exitResult()) {
      try {
        await session.idle(500, 1500);
        keys.push({ kind: 'cleanup', text: '\x01', at: Date.now() });
        session.pressKey('\x01');
        await session.idle(150, 500);
        keys.push({ kind: 'cleanup', text: '\x0b', at: Date.now() });
        session.pressKey('\x0b');
        await session.idle(150, 500);
        keys.push({ kind: 'cleanup', text: '/quit', at: Date.now() });
        await session.send('/quit');
        await session.idle(150, 500);
        await until(
          () => Boolean(session!.exitResult()),
          'Cleanup /quit did not naturally exit',
          12000,
        );
      } catch (error) {
        cleanupErrors.push(String(error));
      }
    }
    try {
      await until(
        () =>
          events()
            .filter((event) => event.token === token)
            .every((event) => !alive(event.pid)),
        'A fixture child observed during cleanup remains alive',
        10000,
      );
    } catch (error) {
      cleanupErrors.push(String(error));
    }
    if (session) {
      writeFileSync(join(evidence, 'terminal.ansi'), session.output());
      forcedClose = !session.exitResult();
      try {
        await session.close();
      } catch (error) {
        cleanupErrors.push(String(error));
      }
    }
    try {
      await server.close();
    } catch (error) {
      cleanupErrors.push(String(error));
    }
    const naturalExit = session?.exitResult();
    if (session && (naturalExit?.exitCode !== 0 || naturalExit?.signal))
      cleanupErrors.push(`Unexpected CLI exit: ${JSON.stringify(naturalExit)}`);
    const result = {
      status:
        !failure && !cleanupErrors.length && !forcedClose ? 'PASS' : 'FAIL',
      phase,
      failure:
        failure instanceof Error
          ? { message: failure.message, stack: failure.stack }
          : failure,
      cleanupErrors,
      forcedClose,
      childGoneBeforeCleanupRelease,
      naturalCliExit: session?.exitResult(),
    };
    json(join(evidence, 'RESULT.json'), result);
    json(join(evidence, 'FRAMES.json'), frames);
    json(join(evidence, 'TASK-CELLS.json'), cells);
    json(join(evidence, 'GUTTER-MASKS.json'), gutterMasks);
    json(join(evidence, 'KEYS.json'), keys);
    json(join(evidence, 'CHILD-EVENTS.json'), events());
    json(join(evidence, 'HTTP-REQUESTS.json'), server.requests);
  }
  if (failure) throw failure;
  expect(cleanupErrors).toEqual([]);
  expect(forcedClose).toBe(false);
  expect(session?.exitResult()?.exitCode).toBe(0);
  expect(session?.exitResult()?.signal).toBeFalsy();
}

// The fixture uses POSIX exec. Windows delivery remains a separate acceptance gate.
const shellTest = it.skipIf(process.platform === 'win32');
shellTest(
  'promotes a live foreground shell and exposes its real task lifetime',
  { retry: 0, timeout: 90000 },
  async () => {
    await withForegroundShell('promotion', async (c) => {
      c.stage('CTRL_B_HANDOFF');
      const pressed = Date.now();
      await c.key('\x02');
      await until(
        () => Boolean(c.toolMessage()),
        'Ctrl+B did not produce its actual tool result',
      );
      const response = JSON.stringify(c.toolMessage());
      expect(response).toMatch(/promot(?:ed|ion)/i);
      const id = response.match(/\bbg_[0-9a-f]{8}\b/u)?.[0];
      assert(id);
      expect(alive(c.pid)).toBe(true);
      await until(
        () =>
          c
            .events()
            .some(
              (event) =>
                event.kind === 'alive' &&
                event.pid === c.pid &&
                event.at > pressed,
            ),
        'Same child did not keep running after promotion',
        2500,
      );
      expect(c.events().some((event) => event.kind === 'exit')).toBe(false);
      await until(
        async () => (await c.frame('agent-unblocked')).includes(c.reply),
        'Agent did not continue after promotion',
      );
      const shows = (text: string, status: string) => {
        const value = compact(text),
          marker = `[${id}]`,
          start = value.lastIndexOf(marker);
        if (start < 0) return false;
        const row = value
          .slice(start + marker.length)
          .split(/\[bg_[0-9a-f]{8}\]/u)[0]!;
        return (
          row.startsWith(status) &&
          row.includes(`pid=${c.pid}`) &&
          row.includes(compact(c.command))
        );
      };
      c.stage('TASK_RUNNING');
      await c.send('/tasks');
      await until(
        async () => shows(await c.taskText('tasks-running'), 'running'),
        'Tasks did not show the same running ID/PID/full command',
      );
      c.stage('TASK_COMPLETED');
      await c.release();
      await c.send('/tasks');
      await until(
        async () =>
          shows(await c.taskText('tasks-completed'), 'completed(exit0)'),
        'Tasks did not show the same completed ID/PID/full command',
      );
    });
  },
);

shellTest(
  'keeps PTY bytes and composer drafts with their actual input owner',
  { retry: 0, timeout: 90000 },
  async () => {
    await withForegroundShell('focus', async (c) => {
      c.stage('PTY_FOCUS_BYTES');
      await c.key('\x06');
      await c.type('INNER_A');
      await c.key('\x1b[D');
      await c.key('\r');
      await until(
        () => c.bytes().length >= firstInput.length,
        'Focused PTY did not receive INNER_A/Left/Return',
      );
      expect(c.bytes()).toBe(firstInput);
      expect(c.server.requests).toHaveLength(1);
      c.stage('COMPOSER_DRAFT');
      await c.key('\x06');
      await c.type('DRAFT_OWNED');
      expect(compact(await c.frame('draft-held'))).toContain('DRAFT_OWNED');
      expect(c.bytes()).toBe(firstInput);
      expect(c.server.requests).toHaveLength(1);
      c.stage('PTY_FOCUS_RETURN');
      await c.key('\x06');
      await c.type('INNER_B');
      await until(
        () => c.bytes().length >= resumedInput.length,
        'Second focus did not restore PTY ownership',
      );
      expect(c.bytes()).toBe(resumedInput);
      c.stage('FOCUSED_APPROVAL_MODE');
      expect(compact(await c.frame('mode-before'))).toContain('YOLOmode');
      await c.key('\x1b[Z');
      await until(
        async () =>
          compact(await c.frame('mode-after'))
            .toLowerCase()
            .includes('planmode'),
        'Focused Shift+Tab did not cycle the actual approval footer',
      );
      await until(
        () => c.bytes().length >= shiftedInput.length,
        'Focused Shift+Tab did not reach the PTY',
      );
      expect(c.bytes()).toBe(shiftedInput);
      expect(c.server.requests).toHaveLength(1);
      c.stage('PTY_PASTE');
      await c.key('\x1b[200~PASTE_甲\x1b[201~');
      await until(
        () => c.bytes().length >= pastedInput.length,
        'Focused paste did not reach the PTY',
      );
      expect(c.bytes()).toBe(pastedInput);
      expect(c.server.requests).toHaveLength(1);
      c.stage('NATURAL_FOCUS_RELEASE');
      await c.release();
      await until(
        async () =>
          Boolean(c.toolMessage()) &&
          (await c.frame('released')).includes(c.reply),
        'Normal result/reply did not release shell focus',
      );
      expect(c.server.requests).toHaveLength(2);
      await c.key('\r');
      await until(
        () => c.server.requests.length >= 3,
        'Retained composer draft did not submit',
      );
      await c.session.idle(300, 1000);
      expect(c.server.requests).toHaveLength(3);
      const messages = c.server.requests[2]!.body['messages'];
      assert(Array.isArray(messages));
      const user = messages.findLast(
        (message) =>
          message && typeof message === 'object' && message.role === 'user',
      );
      assert(user);
      const text =
        typeof user.content === 'string'
          ? user.content
          : user.content
              .filter((part: { type?: string }) => part.type === 'text')
              .map((part: { text?: string }) => part.text ?? '')
              .filter(
                (part: string) =>
                  !/^<system-reminder>[\s\S]*<\/system-reminder>$/u.test(
                    part.trim(),
                  ),
              )
              .join('');
      expect(text).toBe('DRAFT_OWNED');
    });
  },
);

shellTest(
  'cancels a focused shell through the global first-Ctrl+C guard before writing03',
  { retry: 0, timeout: 90000 },
  async () => {
    await withForegroundShell('cancel', async (c) => {
      c.stage('FOCUSED_PRECONDITION');
      await c.key('\x06');
      await c.type('FOCUS_C');
      await until(
        () => c.bytes().length >= 14,
        'Real shell focus did not forward FOCUS_C',
      );
      expect(c.bytes()).toBe('464f4355535f43');
      c.stage('GLOBAL_CANCEL');
      await c.key('\x03', true);
      await until(
        async () =>
          (await c.frame('cancel-hint')).includes(
            'Press Ctrl+C again to exit.',
          ),
        'Focused Ctrl+C did not reach the actual global guard',
        650,
      );
      expect(c.session.exitResult()).toBeUndefined();
      await until(
        () => !alive(c.pid),
        'First Ctrl+C did not cancel the foreground child',
        5000,
      );
      expect(c.releaseExists()).toBe(false);
      expect(c.bytes()).toBe('464f4355535f43');
      expect(
        c
          .events()
          .some(
            (event) =>
              event.kind === 'exit' &&
              ['owned-release-file', 'bounded-fixture-deadline'].includes(
                event.reason ?? '',
              ),
          ),
      ).toBe(false);
      await sleep(1100);
      expect(c.session.exitResult()).toBeUndefined();
      expect(c.server.requests).toHaveLength(1);
    });
  },
);

// Ink's current resize failure is retained in the comparison matrix, not called a pass here.
it.skipIf(process.platform === 'win32' || renderer !== 'opentui')(
  'resizes the actual current native shell after the outer viewport changes',
  { retry: 0, timeout: 90000 },
  async () => {
    await withForegroundShell('resize', async (c) => {
      c.stage('ACTUAL_RESIZE');
      await c.session.idle(150, 500);
      const eventBoundary = c.events().length;
      c.session.resize(72, 28);
      await c.session.idle(150, 500);
      await until(
        () =>
          c
            .events()
            .slice(eventBoundary)
            .some(
              (event) =>
                event.kind === 'resize' &&
                event.pid === c.pid &&
                event.columns === 64 &&
                (event.rows ?? 0) > 0,
            ),
        'No new same-PID SIGWINCH at64 columns after outer72-column resize',
      );
      expect(c.server.requests).toHaveLength(1);
      expect(alive(c.pid)).toBe(true);
      await c.frame('resized');
      await c.release();
      await until(
        async () =>
          Boolean(c.toolMessage()) &&
          (await c.frame('completed')).includes(c.reply),
        'Resized foreground shell did not normally complete',
      );
    });
  },
);
