/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { createHash } from 'node:crypto';
import {
  existsSync,
  realpathSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import xtermHeadless from '@xterm/headless';
import unicode11 from '@xterm/addon-unicode11';
import { expect, it } from 'vitest';
import { Storage } from '@qwen-code/qwen-code-core/config/storage.js';
import { E2E_MEMORY_SETTINGS_DEFAULTS } from '../e2e-memory-defaults.js';
import { startFakeOpenAIServer } from '../fake-openai-server.js';
import { pickE2eRenderer, resolveE2eCliCommand } from '../renderer-matrix.js';
import {
  InteractiveSession,
  sendAboutUntilRendered,
} from './interactive-session.js';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const renderer = pickE2eRenderer();
const runtime = resolveE2eCliCommand(renderer);
const json = (file: string, value: unknown) =>
  writeFileSync(file, JSON.stringify(value, null, 2) + '\n');
const sha = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex');
const png = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGP4z8AAAAMBAQDJ/pLvAAAAAElFTkSuQmCC',
  'base64',
);
const sleep = (ms: number) => new Promise<void>((done) => setTimeout(done, ms));
async function until(check: () => boolean | Promise<boolean>, reason: string) {
  const deadline = Date.now() + 15_000;
  while (!(await check())) {
    if (Date.now() > deadline) throw new Error(reason);
    await sleep(100);
  }
}

type Part = { type: string; text?: string; image_url?: { url: string } };
type Message = { role: string; content: string | Part[] };
type Journal = {
  type: string;
  subtype?: string;
  sessionId: string;
  uuid: string;
  promptId: string;
  parentUuid: string | null;
  message: unknown;
  systemPayload?: { userText: string };
};
function files(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const file = join(directory, entry.name);
    return entry.isDirectory() ? files(file) : [file];
  });
}
function canonical(message: Message): Message {
  return {
    ...message,
    content: Array.isArray(message.content)
      ? message.content.filter(
          (part) =>
            !(
              part.type === 'text' &&
              /^<system-reminder>\n[\s\S]*\n<\/system-reminder>$/.test(
                part.text ?? '',
              )
            ),
        )
      : message.content,
  };
}
function text(message: Message) {
  const content = canonical(message).content;
  if (typeof content === 'string') return content;
  expect(content.every((part) => part.type === 'text')).toBe(true);
  return content.map((part) => part.text).join('');
}
function identity(record: Journal) {
  expect(record.sessionId).toMatch(
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
  );
  expect(record.uuid).toBeTruthy();
  expect(record.promptId).toBeTruthy();
  expect(Object.hasOwn(record, 'parentUuid')).toBe(true);
  return {
    sessionId: record.sessionId,
    uuid: record.uuid,
    promptId: record.promptId,
    parentUuid: record.parentUuid,
  };
}

async function scenario(
  name: string,
  action: (api: Awaited<ReturnType<typeof setup>>) => Promise<void>,
) {
  const api = await setup(name);
  let failure: unknown;
  try {
    await action(api);
  } catch (error) {
    failure = error;
  } finally {
    for (const cleanup of [
      ...api.sessions.map((session, index) => async () => {
        writeFileSync(join(api.evidence, `${index}.ansi`), session.output());
        expect(session.exitResult()?.exitCode).toBe(0);
        expect(session.exitResult()?.signal ?? 0).toBe(0);
      }),
      ...api.sessions.map((session) => () => session.close()),
      () => api.server.close(),
      () => {
        json(join(api.evidence, 'requests.json'), api.server.requests);
        json(join(api.evidence, 'journal.json'), api.journals());
        json(join(api.evidence, 'frames.json'), api.frames);
        expect(api.server.requests).toHaveLength(api.expectedRequests);
        for (const request of api.server.requests)
          expect(request.transport.writableEndedAtClose).toBe(true);
      },
      async () => rmSync(api.scratch, { recursive: true, force: true }),
    ]) {
      try {
        await cleanup();
      } catch (error) {
        failure = new AggregateError(
          [failure, error].filter(Boolean),
          'Session recovery or cleanup failed',
        );
      }
    }
    json(join(api.evidence, 'result.json'), {
      result: failure ? 'FAIL' : 'PASS',
      failure: failure && String(failure),
      renderer,
      runtime,
      exits: api.sessions.map((session) => session.exitResult()),
    });
  }
  if (failure) throw failure;
}

async function setup(name: string) {
  const scratch = mkdtempSync(join(tmpdir(), 'qwen-session-recovery-'));
  const workspace = join(scratch, 'workspace');
  const home = join(scratch, 'home');
  const runtimeDir = join(scratch, 'runtime');
  const output =
    process.env['QWEN_TUI_ACCEPTANCE_OUT'] ??
    join(root, '.qwen/e2e-tests/tui-session-recovery');
  for (const directory of [workspace, home, runtimeDir, output])
    mkdirSync(directory, { recursive: true });
  const evidence = mkdtempSync(join(output, `${name}-${runtime}-${renderer}-`));
  json(join(home, 'settings.json'), {
    $version: 4,
    security: {
      auth: { selectedType: 'openai' },
      folderTrust: { enabled: false },
    },
    general: { enableAutoUpdate: false, showSessionRecap: false },
    ui: { enableFollowupSuggestions: false },
    memory: E2E_MEMORY_SETTINGS_DEFAULTS,
    experimental: { mods: false },
  });
  for (const file of ['system.json', 'defaults.json'])
    json(join(scratch, file), { $version: 4 });
  const server = await startFakeOpenAIServer(({ requestIndex }) => ({
    content: `RECOVERY_${name}_${requestIndex}_DONE`,
    usage: { prompt_tokens: 11, completion_tokens: 7, total_tokens: 18 },
  }));
  const sessions: InteractiveSession[] = [];
  const frames: Record<string, string> = {};
  const journals = () =>
    files(runtimeDir)
      .filter((file) => file.endsWith('.jsonl'))
      .flatMap((file) =>
        readFileSync(file, 'utf8')
          .split('\n')
          .filter(Boolean)
          .map((line) => JSON.parse(line) as Journal),
      );
  const users = () => journals().filter((record) => record.type === 'user');
  const atRecords = () =>
    journals().filter(
      (record) => record.type === 'system' && record.subtype === 'at_command',
    );
  const api = {
    scratch,
    workspace,
    runtimeDir,
    evidence,
    server,
    sessions,
    frames,
    journals,
    users,
    atRecords,
    expectedRequests: 0,
    get session() {
      return sessions[sessions.length - 1];
    },
    async start(
      resume?: string,
      approvalMode: 'default' | 'yolo' = 'default',
    ): Promise<void> {
      if (resume)
        expect(resume).toMatch(
          /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
        );
      const session = await InteractiveSession.start({
        cwd: workspace,
        cols: 100,
        rows: 50,
        inheritEnv: false,
        env: {
          PATH: process.env['PATH'],
          HOME: scratch,
          QWEN_HOME: home,
          QWEN_RUNTIME_DIR: runtimeDir,
          QWEN_CODE_SYSTEM_SETTINGS_PATH: join(scratch, 'system.json'),
          QWEN_CODE_SYSTEM_DEFAULTS_PATH: join(scratch, 'defaults.json'),
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
        args: [
          '--auth-type',
          'openai',
          '--openai-api-key',
          'fixture',
          '--openai-base-url',
          server.baseUrl,
          '--model',
          'qwen-vl-baseline',
          '--approval-mode',
          approvalMode,
          ...(resume ? ['--resume', resume] : []),
        ],
      });
      sessions.push(session);
      await until(
        async () => !(await session.viewport()).includes('Initializing...'),
        'initialization completes',
      );
      await session.idle(200, 1_500);
    },
    async visible(value: string, label = value): Promise<string> {
      await until(
        async () => (await api.session.viewport()).includes(value),
        `missing visible text: ${value}`,
      );
      await api.session.idle(200, 1_500);
      frames[label] = await api.session.viewport();
      return frames[label];
    },
    async send(value: string): Promise<void> {
      await api.session.idle(150, 750);
      await api.session.send(value);
    },
    async prompt(value: string): Promise<Message[]> {
      const index = server.requests.length;
      await api.send(value);
      await api.visible(`RECOVERY_${name}_${index}_DONE`);
      await until(
        () => server.requests[index]?.transport.writableEndedAtClose === true,
        'model HTTP stream completes',
      );
      api.expectedRequests++;
      expect(server.requests).toHaveLength(api.expectedRequests);
      return server.requests[index].body['messages'] as Message[];
    },
    async quit(command = '/quit'): Promise<void> {
      await api.send(command);
      await until(
        () => api.session.exitResult() !== undefined,
        `${command} exits naturally`,
      );
      expect(api.session.exitResult()?.exitCode).toBe(0);
      expect(api.session.exitResult()?.signal ?? 0).toBe(0);
      await api.session.idle(200, 1_500);
    },
    logs() {
      return files(runtimeDir)
        .filter((file) => basename(file) === 'logs.json')
        .flatMap(
          (file) =>
            JSON.parse(readFileSync(file, 'utf8')) as Array<{
              type: string;
              message: string;
            }>,
        )
        .filter((entry) => entry.type === 'user')
        .map((entry) => entry.message);
    },
  };
  return api;
}

async function quitFrames(raw: string, quitOffset: number) {
  const terminal = new xtermHeadless.Terminal({
    cols: 100,
    rows: 50,
    scrollback: 1000,
    allowProposedApi: true,
  });
  terminal.loadAddon(new unicode11.Unicode11Addon());
  terminal.unicode.activeVersion = '11';
  const frames: Array<{ phase: string; buffer: string; viewport: string }> = [];
  let afterQuit = false;
  let leftAlternate = false;
  const capture = (phase: string) => {
    if (!afterQuit || leftAlternate) return;
    const buffer = terminal.buffer.active;
    frames.push({
      phase,
      buffer: buffer.type,
      viewport: Array.from(
        { length: terminal.rows },
        (_, row) =>
          buffer
            .getLine(buffer.viewportY + row)
            ?.translateToString(true, 0, terminal.cols) ?? '',
      ).join('\n'),
    });
  };
  const observers = [
    terminal.parser.registerCsiHandler({ final: 'J' }, () => {
      capture('before-erase-display');
      return false;
    }),
    terminal.parser.registerCsiHandler({ final: 'K' }, () => {
      capture('before-erase-line');
      return false;
    }),
    terminal.parser.registerCsiHandler(
      { prefix: '?', final: 'l' },
      (params) => {
        if (
          afterQuit &&
          params.some(
            (value) =>
              typeof value === 'number' && [47, 1047, 1049].includes(value),
          ) &&
          terminal.buffer.active.type === 'alternate'
        ) {
          capture('before-leave-alternate');
          leftAlternate = true;
        }
        return false;
      },
    ),
  ];
  const write = (value: string) =>
    new Promise<void>((done) => terminal.write(value, done));
  try {
    await write(raw.slice(0, quitOffset));
    afterQuit = true;
    // Preserve every byte while observing frames between destructive controls.
    await write(raw.slice(quitOffset));
    capture('final');
    return { frames, leftAlternate };
  } finally {
    for (const observer of observers) observer.dispose();
    terminal.dispose();
  }
}

for (const command of ['/quit', '/exit']) {
  it(`H15 ${command} displays summary before teardown (${runtime}+${renderer})`, () =>
    scenario(command.slice(1), async (api) => {
      await api.start();
      const prompt = 'RECOVERY_EXIT_CONTROL';
      const messages = await api.prompt(prompt);
      expect(messages.filter((m) => m.role === 'user').map(text)).toEqual([
        prompt,
      ]);
      expect(messages.some((m) => m.role === 'tool')).toBe(false);
      expect(await api.session.viewport()).not.toContain(
        'Agent powering down. Goodbye!',
      );
      const offset = api.session.output().length;
      await api.quit(command);
      const replay = await quitFrames(api.session.output(), offset);
      json(join(api.evidence, 'quit-frames.json'), replay);
      if (renderer === 'opentui') expect(replay.leftAlternate).toBe(true);
      expect(
        replay.frames.some(
          ({ viewport }) =>
            viewport.includes('Agent powering down. Goodbye!') &&
            viewport.includes('Interaction Summary') &&
            viewport.includes('Wall Time:') &&
            !viewport.includes('Type your message'),
        ),
      ).toBe(true);
      expect(api.server.requests).toHaveLength(1);
      expect(api.sessions).toHaveLength(1);
    }));
}

function assertImage(message: Message) {
  expect(Array.isArray(message.content)).toBe(true);
  const images = (message.content as Part[]).filter(
    (part) => part.type === 'image_url',
  );
  expect(images).toHaveLength(1);
  const match = /^data:([^;]+);base64,(.*)$/.exec(images[0].image_url!.url);
  expect(match).not.toBeNull();
  const bytes = Buffer.from(match![2], 'base64');
  expect({ mime: match![1], length: bytes.length, hash: sha(bytes) }).toEqual(
    renderer === 'opentui'
      ? { mime: 'image/png', length: png.length, hash: sha(png) }
      : {
          mime: 'image/jpeg',
          length: 268,
          hash: '262e7d0be78165df4afc3c94a821e1ade5d151808908ffa8cc984c2029894246',
        },
  );
}

it(`H02a image caption survives cold resume (${runtime}+${renderer})`, () =>
  scenario('image', async (api) => {
    const caption = 'RECOVERY_IMAGE_CAPTION';
    const followup = 'RECOVERY_IMAGE_FOLLOWUP';
    const imagePath = join(api.workspace, 'owned image 甲.png');
    writeFileSync(imagePath, png);
    await api.start();
    api.session.pressKey('\x1b[200~' + JSON.stringify(imagePath) + '\x1b[201~');
    await api.visible('clipboard-', 'image-chip');
    expect(api.server.requests).toHaveLength(0);
    const first = (await api.prompt(caption)).filter((m) => m.role === 'user');
    expect(first).toHaveLength(1);
    expect(JSON.stringify(first[0])).toContain(caption);
    assertImage(first[0]);
    await until(
      () =>
        api.users().length === 1 &&
        api.journals().some((r) => r.type === 'assistant'),
      'user and assistant persisted',
    );
    const original = identity(api.users()[0]);
    await api.quit();
    await api.start(original.sessionId);
    await api.visible('RECOVERY_image_0_DONE', 'cold-assistant-ready');
    const cold = await api.visible(caption, 'cold-caption');
    expect(cold).toContain('RECOVERY_image_0_DONE');
    expect(cold).not.toContain(png.toString('base64'));
    expect(api.server.requests).toHaveLength(1);
    expect(api.users()).toHaveLength(1);
    expect(identity(api.users()[0])).toEqual(original);
    const messages = await api.prompt(followup);
    const users = messages.filter((m) => m.role === 'user');
    expect(users).toHaveLength(2);
    expect(canonical(users[0])).toEqual(canonical(first[0]));
    assertImage(users[0]);
    expect(text(users[1])).toBe(followup);
    expect(messages.filter((m) => m.role === 'assistant').map(text)).toEqual([
      'RECOVERY_image_0_DONE',
    ]);
    expect(messages.some((m) => m.role === 'tool')).toBe(false);
    await until(() => api.users().length === 2, 'followup persisted');
    expect(identity(api.users()[0])).toEqual(original);
    const next = identity(api.users()[1]);
    expect(next.sessionId).toBe(original.sessionId);
    expect(next.uuid).not.toBe(original.uuid);
    expect(next.promptId).not.toBe(original.promptId);
    await api.quit();
    expect(api.logs()).toEqual([caption, followup]);
    expect(api.sessions).toHaveLength(2);
  }));

it(`H02b typed file survives mutation and cold resume (${runtime}+${renderer})`, () =>
  scenario('file', async (api) => {
    const submitted = '@owned.txt RECOVERY_INSPECT_FILE';
    const followup = 'RECOVERY_FILE_FOLLOWUP';
    const old = 'RECOVERY_FILE_OLD_CANARY\n';
    const changed = 'RECOVERY_FILE_NEW_CANARY\n';
    const file = join(api.workspace, 'owned.txt');
    writeFileSync(file, old);
    await api.start();
    const first = (await api.prompt(submitted)).filter(
      (m) => m.role === 'user',
    );
    expect(first).toHaveLength(1);
    expect(JSON.stringify(first[0])).toContain(old.trim());
    expect(JSON.stringify(first[0])).not.toContain(changed.trim());
    await until(
      () =>
        api.users().length === 1 &&
        api.atRecords().length === 1 &&
        api.journals().some((r) => r.type === 'assistant'),
      'user, at-command and assistant persisted',
    );
    const original = identity(api.users()[0]);
    const at = api.atRecords()[0];
    expect(at.systemPayload?.userText).toBe(submitted);
    expect(at.sessionId).toBe(original.sessionId);
    expect(JSON.stringify(api.users()[0].message)).toContain(old.trim());
    await api.visible(submitted, 'hot-typed-form');
    await api.quit();
    writeFileSync(file, changed);
    expect(readFileSync(file, 'utf8')).toBe(changed);
    await api.start(original.sessionId);
    await api.visible('RECOVERY_file_0_DONE', 'cold-assistant-ready');
    const cold = await api.visible(submitted, 'cold-typed-form');
    expect(cold).toContain('RECOVERY_file_0_DONE');
    expect(cold).not.toContain(changed.trim());
    expect(api.server.requests).toHaveLength(1);
    expect(api.users()).toHaveLength(1);
    expect(api.atRecords()).toEqual([at]);
    expect(identity(api.users()[0])).toEqual(original);
    await api.session.idle(150, 750);
    api.session.pressKey('\x1b[A');
    await until(
      async () =>
        (await api.session.viewport())
          .split('\n')
          .filter((line) => /^\s*>/.test(line))
          .at(-1)
          ?.trim() === `> ${submitted}`,
      'Up recalls the exact typed form into the composer',
    );
    api.frames['cold-Up'] = await api.session.viewport();
    await api.session.idle(150, 750);
    api.session.pressKey('\x01');
    await api.session.idle(150, 750);
    api.session.pressKey('\x0b');
    await api.session.idle(150, 750);
    expect(api.server.requests).toHaveLength(1);
    const messages = await api.prompt(followup);
    const users = messages.filter((m) => m.role === 'user');
    expect(users).toHaveLength(2);
    expect(canonical(users[0])).toEqual(canonical(first[0]));
    expect(JSON.stringify(users[0])).toContain(old.trim());
    expect(JSON.stringify(messages)).not.toContain(changed.trim());
    expect(text(users[1])).toBe(followup);
    expect(messages.filter((m) => m.role === 'assistant').map(text)).toEqual([
      'RECOVERY_file_0_DONE',
    ]);
    await until(() => api.users().length === 2, 'followup persisted');
    expect(identity(api.users()[0])).toEqual(original);
    const next = identity(api.users()[1]);
    expect(next.sessionId).toBe(original.sessionId);
    expect(next.uuid).not.toBe(original.uuid);
    expect(next.promptId).not.toBe(original.promptId);
    expect(api.atRecords()).toEqual([at]);
    expect(readFileSync(file, 'utf8')).toBe(changed);
    await api.quit();
    expect(api.logs()).toEqual([submitted, followup]);
    expect(api.sessions).toHaveLength(2);
    // Unknown humanInput provenance is covered by input-prompt.test.tsx's
    // fresh/known/unknown seam; the HTTP protocol does not expose that field.
  }));

it(`H11e tool-only restore completes locally and accepts one explicit followup (${runtime}+${renderer})`, () =>
  scenario('restore-tool-only', async (api) => {
    const settingsFile = join(api.scratch, 'home', 'settings.json');
    const settings = JSON.parse(readFileSync(settingsFile, 'utf8'));
    json(settingsFile, {
      ...settings,
      tools: { shell: { enableInteractiveShell: false } },
    });
    await api.start(undefined, 'yolo');
    await sendAboutUntilRendered(api.session);
    const checkpoint = join(
      new Storage(
        realpathSync(api.workspace),
        api.runtimeDir,
      ).getProjectTempCheckpointsDir(),
      'owned-h11e-checkpoint.json',
    );
    const counter = join(api.workspace, 'h11e-executions.txt');
    const value = {
      toolCall: {
        name: 'run_shell_command',
        args: {
          command:
            "printf 'H11E_EXECUTION\n' >> h11e-executions.txt; printf 'H11E_TOOL_STDOUT\n'",
        },
      },
    };
    try {
      mkdirSync(dirname(checkpoint), { recursive: true });
      json(checkpoint, value);
      json(join(api.evidence, 'checkpoint-seed.json'), { checkpoint, value });
      expect(JSON.parse(readFileSync(checkpoint, 'utf8'))).toEqual(value);
      expect(api.server.requests).toHaveLength(0);
      expect(existsSync(counter)).toBe(false);
      await api.send('/restore');
      const listing = await api.visible(
        'Available tool calls to restore:',
        'restore-list',
      );
      expect(listing).toContain('owned-h11e-checkpoint');
      expect(api.server.requests).toHaveLength(0);
      expect(existsSync(counter)).toBe(false);
      await api.send('/restore owned-h11e-checkpoint');
      // Completion consumes the first Enter; submit after that render settles.
      await api.session.idle(150, 750);
      api.session.pressKey('\r');
      await until(
        () =>
          existsSync(counter) &&
          readFileSync(counter, 'utf8') === 'H11E_EXECUTION\n',
        'owned checkpoint tool executes exactly once',
      );
      await api.visible('H11E_TOOL_STDOUT', 'restore-tool');
      expect(api.server.requests).toHaveLength(0);
      expect(readFileSync(counter, 'utf8')).toBe('H11E_EXECUTION\n');
      const messages = await api.prompt('H11E_HEALTHY_FOLLOWUP');
      expect(
        messages.some(
          (message) =>
            message.role === 'user' &&
            JSON.stringify(message.content).includes('H11E_HEALTHY_FOLLOWUP'),
        ),
      ).toBe(true);
      expect(api.server.requests).toHaveLength(1);
      expect(readFileSync(counter, 'utf8')).toBe('H11E_EXECUTION\n');
      expect(JSON.parse(readFileSync(checkpoint, 'utf8'))).toEqual(value);
      await api.quit();
      expect(api.server.requests).toHaveLength(1);
      expect(readFileSync(counter, 'utf8')).toBe('H11E_EXECUTION\n');
    } finally {
      json(join(api.evidence, 'checkpoint-final.json'), {
        value: existsSync(checkpoint)
          ? JSON.parse(readFileSync(checkpoint, 'utf8'))
          : null,
        executionCounter: existsSync(counter)
          ? readFileSync(counter, 'utf8')
          : null,
        naturalExit: api.session.exitResult(),
        scope:
          'tool-only scheduler/shell pipes; not file rewind, history load or inner PTY',
      });
    }
  }));

it(
  `H01 actual conversation rewind preserves the retained branch (${runtime}+${renderer})`,
  () =>
    scenario('rewind', async (api) => {
      const a = 'RECOVERY_REWIND_PROMPT_A';
      const b = 'RECOVERY_REWIND_PROMPT_B';
      const c = 'RECOVERY_REWIND_PROMPT_C';
      const answerA = 'RECOVERY_rewind_0_DONE';
      const answerB = 'RECOVERY_rewind_1_DONE';
      const recordText = (record: Journal) =>
        (record.message as { parts?: Array<{ text?: string }> })?.parts
          ?.map((part) => part.text ?? '')
          .join('');
      const frameWhere = async (
        predicate: (frame: string) => boolean,
        label: string,
      ) => {
        await until(async () => {
          api.frames[label] = await api.session.viewport();
          return predicate(api.frames[label]);
        }, label);
        await api.session.idle(150, 750);
        api.frames[label] = await api.session.viewport();
        return api.frames[label];
      };
      const composerValue = (frame: string): string | undefined => {
        const lines = frame.split('\n');
        const borders = lines.flatMap((line, index) =>
          /^\s*─{20,}\s*$/.test(line) ? [index] : [],
        );
        if (borders.length < 2) return;
        const [top, bottom] = borders.slice(-2);
        const body = lines.slice(top + 1, bottom);
        if (body.length !== 1) return;
        const match = /^\s*\* (.*)$/.exec(body[0].trimEnd());
        if (!match) return;
        return match[1] === '  Type your message or @path/to/file'
          ? ''
          : match[1];
      };
      const draftIs = (value: string, label: string) =>
        frameWhere((frame) => composerValue(frame) === value, label);
      const selectB = async (label: string) => {
        for (let step = 0; step < 4; step++) {
          const frame = await frameWhere(
            (value) =>
              value.includes('Rewind Conversation') &&
              /›\s*#\d+\s+/.test(value),
            `${label}-${step}`,
          );
          const rows = frame.split('\n');
          const target = rows.findIndex((line) =>
            /#2\s+RECOVERY_REWIND_PROMPT_B(?:\s|[│┃]|$)/.test(line),
          );
          const selected = rows.findIndex((line) => /›\s*#\d+\s+/.test(line));
          expect(target).toBeGreaterThanOrEqual(0);
          expect(selected).toBeGreaterThanOrEqual(0);
          if (target === selected) {
            expect(rows[selected]).toMatch(/›\s*#2\s+RECOVERY_REWIND_PROMPT_B/);
            return;
          }
          await api.session.idle(150, 750);
          api.session.pressKey(target > selected ? '\x1b[B' : '\x1b[A');
          await api.session.idle(150, 750);
        }
        throw new Error('Visible B selection did not converge');
      };

      try {
        await api.start(undefined, 'yolo');
        const first = await api.prompt(a);
        expect(
          first.filter((message) => message.role === 'user').map(text),
        ).toEqual([a]);
        const second = await api.prompt(b);
        expect(
          second.filter((message) => message.role === 'user').map(text),
        ).toEqual([a, b]);
        expect(
          second.filter((message) => message.role === 'assistant').map(text),
        ).toEqual([answerA]);
        await until(
          () =>
            api.users().length === 2 &&
            api
              .journals()
              .some(
                (record) =>
                  record.type === 'assistant' && recordText(record) === answerB,
              ),
          'two real prompts and B answer recorded',
        );
        const before = api.journals();
        const [originalA, originalB] = before.filter(
          (record) => record.type === 'user',
        );
        const aIdentity = identity(originalA);
        const bIdentity = identity(originalB);
        const originalAnswerA = before.find(
          (record) =>
            record.type === 'assistant' && recordText(record) === answerA,
        )!;
        const originalAnswerB = before.find(
          (record) =>
            record.type === 'assistant' && recordText(record) === answerB,
        )!;
        expect(originalAnswerA?.uuid).toBeTruthy();
        expect(originalAnswerB?.uuid).toBeTruthy();
        expect(bIdentity.sessionId).toBe(aIdentity.sessionId);
        expect(bIdentity.promptId).not.toBe(aIdentity.promptId);
        json(join(api.evidence, 'rewind-before-journal.json'), before);

        await api.send('/rollback');
        await selectB('alias-selected-B');
        expect(api.server.requests).toHaveLength(2);
        await api.session.idle(150, 750);
        api.session.pressKey('\x1b');
        await frameWhere(
          (frame) => !frame.includes('Rewind Conversation'),
          'alias-cancelled',
        );
        await draftIs('', 'empty-after-alias-cancel');
        expect(api.server.requests).toHaveLength(2);
        const afterAlias = api.journals();
        expect(
          afterAlias.filter((record) =>
            before.some((original) => original.uuid === record.uuid),
          ),
        ).toEqual(before);
        expect(
          afterAlias.filter(
            (record) => record.type === 'user' || record.type === 'assistant',
          ),
        ).toEqual(
          before.filter(
            (record) => record.type === 'user' || record.type === 'assistant',
          ),
        );
        json(join(api.evidence, 'rewind-alias-journal.json'), afterAlias);

        await api.send('/rewind');
        await selectB('rewind-selected-B');
        expect(api.server.requests).toHaveLength(2);
        await api.session.idle(150, 750);
        api.session.pressKey('\r');
        const confirmation = await frameWhere(
          (frame) =>
            frame.includes('Restore conversation only') &&
            frame.includes(b) &&
            !frame.includes('Computing file changes...'),
          'confirm-real-B',
        );
        expect(confirmation).toMatch(/›\s*Restore conversation only/);
        expect(confirmation).not.toContain('Restore code and conversation');
        await api.session.idle(150, 750);
        api.session.pressKey('\r');
        await api.visible(
          'Conversation rewound. Edit your prompt and press Enter to continue.',
          'rewind-committed',
        );
        const draft = await draftIs(b, 'exact-restored-B-draft');
        expect(draft).not.toContain(answerB);
        expect(draft).toContain(answerA);
        expect(draft.split(b)).toHaveLength(2);
        expect(api.server.requests).toHaveLength(2);
        await until(
          () =>
            api
              .journals()
              .some(
                (record) =>
                  record.type === 'system' && record.subtype === 'rewind',
              ),
          'rewind recorded',
        );

        await api.session.idle(150, 750);
        api.session.pressKey('\x01');
        await api.session.idle(150, 750);
        api.session.pressKey('\x0b');
        await api.session.idle(150, 750);
        await draftIs('', 'explicitly-cleared-B');
        const next = await api.prompt(c);
        const users = next.filter((message) => message.role === 'user');
        expect(users.map(text)).toEqual([a, c]);
        expect(canonical(users[0])).toEqual(
          canonical(first.find((message) => message.role === 'user')!),
        );
        expect(
          next.filter((message) => message.role === 'assistant').map(text),
        ).toEqual([answerA]);
        expect(next.filter((message) => message.role === 'tool')).toHaveLength(
          0,
        );
        for (const discarded of [b, answerB, '/rewind', '/rollback'])
          expect(JSON.stringify(next)).not.toContain(discarded);
        await until(
          () => api.users().some((record) => recordText(record) === c),
          'explicit C recorded',
        );
        const after = api.journals();
        expect(after.find((record) => record.uuid === originalA.uuid)).toEqual(
          originalA,
        );
        expect(after.find((record) => record.uuid === originalB.uuid)).toEqual(
          originalB,
        );
        const currentC = after.find(
          (record) => record.type === 'user' && recordText(record) === c,
        )!;
        const cIdentity = identity(currentC);
        expect(cIdentity.sessionId).toBe(aIdentity.sessionId);
        expect(cIdentity.promptId).not.toBe(bIdentity.promptId);
        const byUUID = new Map(after.map((record) => [record.uuid, record]));
        const seen = new Set<string>();
        const ancestors: Journal[] = [];
        let current: Journal | undefined = currentC;
        while (current) {
          expect(seen.has(current.uuid)).toBe(false);
          seen.add(current.uuid);
          ancestors.push(current);
          if (current.parentUuid === null) break;
          expect(byUUID.has(current.parentUuid)).toBe(true);
          current = byUUID.get(current.parentUuid);
        }
        expect(seen.has(originalA.uuid)).toBe(true);
        expect(seen.has(originalAnswerA.uuid)).toBe(true);
        expect(seen.has(originalB.uuid)).toBe(false);
        expect(seen.has(originalAnswerB.uuid)).toBe(false);
        expect(
          ancestors.filter(
            (record) => record.type === 'system' && record.subtype === 'rewind',
          ),
        ).toHaveLength(1);
        json(join(api.evidence, 'rewind-facts.json'), {
          aIdentity,
          bIdentity,
          cIdentity,
          activeAncestorUUIDs: [...seen],
          nextWire: next,
        });
        await api.quit();
      } catch (error) {
        json(join(api.evidence, 'rewind-primary-failure.json'), {
          name: error instanceof Error ? error.name : typeof error,
          message: error instanceof Error ? error.message : String(error),
          stack: error instanceof Error ? error.stack : undefined,
        });
        throw error;
      }
    }),
  120_000,
);
