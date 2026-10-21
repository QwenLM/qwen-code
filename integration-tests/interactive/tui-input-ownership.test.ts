/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { expect, it } from 'vitest';
import { E2E_MEMORY_SETTINGS_DEFAULTS } from '../e2e-memory-defaults.js';
import { startFakeOpenAIServer } from '../fake-openai-server.js';
import { pickE2eRenderer, resolveE2eCliCommand } from '../renderer-matrix.js';
import { InteractiveSession } from './interactive-session.js';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const renderer = pickE2eRenderer();
const runtime = resolveE2eCliCommand(renderer);
const sha = (bytes: Buffer | string) =>
  createHash('sha256').update(bytes).digest('hex');
const json = (file: string, value: unknown) =>
  writeFileSync(file, JSON.stringify(value, null, 2) + '\n');
const image = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGP4z8AAAAMBAQDJ/pLvAAAAAElFTkSuQmCC',
  'base64',
);
const sleep = (ms: number) =>
  new Promise<void>((resolve) => setTimeout(resolve, ms));

async function until(
  check: () => boolean | Promise<boolean>,
  description: string,
) {
  const deadline = Date.now() + 15_000;
  while (!(await check())) {
    if (Date.now() > deadline) throw new Error(description);
    await sleep(100);
  }
}

it(`preserves composer ownership through ${runtime}+${renderer} product requests`, async () => {
  const scratch = mkdtempSync(join(tmpdir(), 'qwen-input-ownership-'));
  const workspace = join(scratch, 'workspace');
  const home = join(scratch, 'home');
  const runtimeDir = join(scratch, 'runtime');
  const system = join(scratch, 'system.json');
  const defaults = join(scratch, 'defaults.json');
  const output =
    process.env['QWEN_TUI_ACCEPTANCE_OUT'] ??
    join(root, '.qwen/e2e-tests/tui-input-ownership');
  for (const directory of [workspace, home, runtimeDir, output])
    mkdirSync(directory, { recursive: true });
  const evidence = mkdtempSync(join(output, `input-${runtime}-${renderer}-`));
  const imagePath = join(workspace, 'image 甲.png');
  writeFileSync(imagePath, image);
  json(join(home, 'settings.json'), {
    security: {
      auth: { selectedType: 'openai' },
      folderTrust: { enabled: false },
    },
    general: { enableAutoUpdate: false, showSessionRecap: false },
    ui: { enableFollowupSuggestions: false },
    memory: E2E_MEMORY_SETTINGS_DEFAULTS,
  });
  let release!: () => void;
  let releaseImage!: () => void;
  const held = new Promise<void>((done) => {
    release = done;
  });
  const heldImage = new Promise<void>((done) => {
    releaseImage = done;
  });
  const server = await startFakeOpenAIServer(({ requestIndex }) =>
    requestIndex === 1 || requestIndex === 4
      ? {
          contentChunks: [`HELD_${requestIndex}`, '_END'],
          holdAfterChunks: 1,
          holdUntil: requestIndex === 1 ? held : heldImage,
        }
      : { content: `REPLY_${requestIndex}_DONE` },
  );
  let session: InteractiveSession | undefined;
  const frames: Record<string, string> = {};
  let failure: string | undefined;
  try {
    json(system, { $version: 4 });
    json(defaults, { $version: 4 });
    session = await InteractiveSession.start({
      cwd: workspace,
      cols: 100,
      rows: 30,
      inheritEnv: false,
      env: {
        PATH: process.env['PATH'],
        HOME: scratch,
        QWEN_HOME: home,
        QWEN_RUNTIME_DIR: runtimeDir,
        QWEN_CODE_SYSTEM_SETTINGS_PATH: system,
        QWEN_CODE_SYSTEM_DEFAULTS_PATH: defaults,
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
        'default',
      ],
    });
    const active = session;
    const visible = async (text: string) => {
      await until(
        async () => (await active.viewport()).includes(text),
        `missing visible text: ${text}`,
      );
      frames[text] = await active.viewport();
      await active.idle(250, 750);
    };
    const type = async (text: string) => {
      await active.idle(150, 500);
      for (const char of text) {
        active.pressKey(char);
        await sleep(8);
      }
      await active.idle(150, 500);
    };
    const pasteImage = async () => {
      await active.idle(150, 500);
      active.pressKey('\x1b[200~' + JSON.stringify(imagePath) + '\x1b[201~');
      await until(
        async () => /clipboard-/.test(await active.viewport()),
        'image path must become a chip',
      );
      await active.idle(250, 750);
    };
    await visible('Type your message');
    await until(
      async () => !(await active.viewport()).includes('Initializing...'),
      'initialization completes',
    );
    await type('IDLE_CTRL_Q_甲🙂');
    active.pressKey('\x11');
    await visible('REPLY_0_DONE');
    expect(server.requests).toHaveLength(1);
    await active.send('HOLD_TEXT');
    await visible('HELD_1');
    await type('DEFERRED_CTRL_Q');
    active.pressKey('\x11');
    await active.idle(500, 1_000);
    expect(server.requests).toHaveLength(2);
    release();
    await visible('REPLY_2_DONE');
    expect(server.requests).toHaveLength(3);

    await pasteImage();
    active.pressKey('\r');
    await active.idle(500, 1_000);
    expect(server.requests).toHaveLength(3);
    for (const [cols, rows] of [
      [80, 12],
      [40, 10],
      [100, 30],
    ]) {
      active.resize(cols, rows);
      await active.idle(250, 750);
      frames[`image-${cols}x${rows}`] = await active.viewport();
      expect(frames[`image-${cols}x${rows}`]).toMatch(/clipboard-/);
    }
    await type('FRESH_IMAGE_CAPTION');
    active.pressKey('\r');
    await visible('REPLY_3_DONE');
    await active.send('HOLD_IMAGE');
    await visible('HELD_4');
    await pasteImage();
    await type('QUEUED_IMAGE_CAPTION');
    active.pressKey('\r');
    await active.idle(500, 1_000);
    expect(server.requests).toHaveLength(5);
    releaseImage();
    await visible('REPLY_5_DONE');
    expect(server.requests).toHaveLength(6);

    for (const [index, caption] of [
      [0, 'IDLE_CTRL_Q_甲🙂'],
      [2, 'DEFERRED_CTRL_Q'],
      [3, 'FRESH_IMAGE_CAPTION'],
      [5, 'QUEUED_IMAGE_CAPTION'],
    ] as const) {
      const messages = server.requests[index].body['messages'] as Array<{
        role: string;
        content: unknown;
      }>;
      const last = messages.filter((message) => message.role === 'user').at(-1);
      expect(JSON.stringify(last)).toContain(caption);
      if (index === 3 || index === 5) {
        const parts = last?.content as Array<{ image_url?: { url?: string } }>;
        const images = parts.flatMap((part) =>
          part.image_url?.url ? [part.image_url.url] : [],
        );
        expect(images).toHaveLength(1);
        const [prefix, base64] = images[0].split(',');
        const bytes = Buffer.from(base64, 'base64');
        expect({ prefix, length: bytes.length, hash: sha(bytes) }).toEqual(
          renderer === 'opentui'
            ? {
                prefix: 'data:image/png;base64',
                length: image.length,
                hash: sha(image),
              }
            : {
                prefix: 'data:image/jpeg;base64',
                length: 268,
                hash: '262e7d0be78165df4afc3c94a821e1ade5d151808908ffa8cc984c2029894246',
              },
        );
      }
    }
  } catch (error) {
    failure =
      error instanceof Error ? (error.stack ?? error.message) : String(error);
  } finally {
    release();
    releaseImage();
    for (const cleanup of [
      async () => {
        if (session) frames['final'] = await session.viewport();
      },
      async () => session?.close(),
      () => server.close(),
      async () => rmSync(scratch, { recursive: true, force: true }),
    ]) {
      try {
        await cleanup();
      } catch (error) {
        failure = [failure, `cleanup: ${String(error)}`]
          .filter(Boolean)
          .join('\n');
      }
    }
    if (session)
      writeFileSync(join(evidence, 'terminal.ansi'), session.output());
    json(join(evidence, 'frames.json'), frames);
    json(join(evidence, 'requests.json'), server.requests);
    json(join(evidence, 'result.json'), {
      result: failure ? 'FAIL' : 'PASS',
      failure,
      runtime,
      renderer,
      strict: renderer === 'opentui',
      source: execFileSync('git', ['rev-parse', 'HEAD'], {
        cwd: root,
        encoding: 'utf8',
      }).trim(),
      diffSha256: sha(execFileSync('git', ['diff', 'HEAD'], { cwd: root })),
      bundleSha256: sha(readFileSync(join(root, 'dist/cli.js'))),
      fixtureSha256: sha(readFileSync(fileURLToPath(import.meta.url))),
      runtimeVersion: execFileSync(runtime, ['--version'], {
        encoding: 'utf8',
      }).trim(),
      imageSha256: sha(image),
      imageBytes: image.length,
      exit: session?.exitResult(),
      terminalUnicodeVersion: '11',
    });
  }
  if (failure) throw new Error(failure);
});
