/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * A Mod's `$.prompt.submit` in the terminal, Ink or OpenTUI, on the built CLI
 * in a real terminal: the prompt a hook submits once a turn ends runs as a
 * turn of its own once the session is idle, under a line naming the Mod, and
 * the Mods' prompts stop at their limit.
 */

import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterEach, describe, expect, it } from 'vitest';
import { InteractiveSession } from './interactive-session.js';
import {
  startFakeOpenAIServer,
  type FakeOpenAIServer,
} from '../fake-openai-server.js';
import { E2E_MEMORY_SETTINGS_DEFAULTS } from '../e2e-memory-defaults.js';
import { pickE2eRenderer, resolveE2eCliCommand } from '../renderer-matrix.js';
import { removeScratchDir } from '../scratch-dir.js';

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const bundle = join(repo, 'dist/cli.js');
const renderer = pickE2eRenderer();
const json = (file: string, value: unknown) =>
  writeFileSync(file, JSON.stringify(value, null, 2) + '\n');

function files(root: string): string[] {
  if (!existsSync(root)) return [];
  return readdirSync(root, { withFileTypes: true }).flatMap((entry) =>
    entry.isDirectory()
      ? files(join(root, entry.name))
      : [join(root, entry.name)],
  );
}

type Message = { role: string; content?: unknown };
const text = (content: unknown): string =>
  typeof content === 'string'
    ? content
    : Array.isArray(content)
      ? content.map((part) => (part as { text?: string }).text ?? '').join('\n')
      : '';

describe(`$.prompt.submit in the ${renderer} terminal`, () => {
  let server: FakeOpenAIServer | undefined;
  let session: InteractiveSession | undefined;
  let scratch: string | undefined;

  afterEach(async () => {
    await session?.close();
    session = undefined;
    await server?.close();
    server = undefined;
    if (scratch) await removeScratchDir(scratch);
    scratch = undefined;
  });

  async function start(hooks: string) {
    scratch = mkdtempSync(
      join(tmpdir(), `qwen-mods-prompt-submit-${renderer}-`),
    );
    const workspace = join(scratch, 'workspace');
    const qwenHome = join(scratch, 'home');
    const plugin = join(scratch, 'followup-mod');
    const env = {
      PATH: process.env['PATH'],
      TERM: 'xterm-256color',
      LANG: 'en_US.UTF-8',
      HOME: join(scratch, 'os-home'),
      QWEN_HOME: qwenHome,
      QWEN_RUNTIME_DIR: join(scratch, 'runtime'),
      NO_PROXY: 'localhost,127.0.0.1',
      no_proxy: 'localhost,127.0.0.1',
      QWEN_CODE_DISABLE_CRON: '1',
      QWEN_CODE_DISABLE_UPDATE_CHECK: '1',
      QWEN_SANDBOX: 'false',
    };
    for (const directory of [
      workspace,
      qwenHome,
      env.HOME,
      join(plugin, '.claude-plugin'),
      join(plugin, 'hooks'),
    ])
      mkdirSync(directory, { recursive: true });
    json(join(qwenHome, 'settings.json'), {
      experimental: { mods: true },
      general: {
        enableAutoUpdate: false,
        chatRecording: true,
        showSessionRecap: false,
      },
      ui: { enableFollowupSuggestions: false },
      memory: E2E_MEMORY_SETTINGS_DEFAULTS,
      security: {
        folderTrust: { enabled: true },
        auth: { selectedType: 'openai' },
      },
    });
    json(join(qwenHome, 'trustedFolders.json'), {
      [workspace]: 'TRUST_FOLDER',
    });
    json(join(plugin, '.claude-plugin/plugin.json'), {
      name: 'followup-mod',
      version: '1.0.0',
    });
    json(join(plugin, 'hooks/hooks.json'), { modules: ['./register.js'] });
    writeFileSync(
      join(plugin, 'hooks/register.js'),
      `export function register(on) { ${hooks} }`,
    );

    let answered = 0;
    server = await startFakeOpenAIServer(({ body }) =>
      body['stream'] === true
        ? { content: `Answer ${++answered}` }
        : { content: '{}' },
    );
    const cli = resolveE2eCliCommand(renderer);
    execFileSync(cli, [bundle, 'extensions', 'install', plugin, '--consent'], {
      cwd: workspace,
      env,
      timeout: 60_000,
      stdio: 'pipe',
    });
    session = await InteractiveSession.start({
      cols: 160,
      rows: 50,
      cwd: workspace,
      env,
      inheritEnv: false,
      command: {
        bin: cli,
        args: [
          bundle,
          '--auth-type',
          'openai',
          '--model',
          'fixture',
          '--openai-base-url',
          server.baseUrl,
          '--openai-api-key',
          'fixture',
        ],
      },
    });
    await session.idle(1000, 20_000);
    return session;
  }

  /** The last user message of each main-conversation model request. */
  const prompts = () =>
    server!.requests
      .filter((request) => request.body['stream'] === true)
      .map((request) =>
        text(
          ((request.body['messages'] ?? []) as Message[])
            .filter((message) => message.role === 'user')
            .at(-1)?.content,
        ),
      );

  const records = () =>
    files(scratch!)
      .filter((file) => file.endsWith('.jsonl'))
      .flatMap((file) =>
        readFileSync(file, 'utf8')
          .split('\n')
          .filter(Boolean)
          .map((line) => JSON.parse(line) as Record<string, unknown>),
      )
      .filter(
        (record) =>
          record['type'] === 'user' && record['subtype'] === undefined,
      );

  it('runs the prompt a hook submits once idle, under a line naming the Mod', async () => {
    const nonce = randomUUID().slice(0, 8);
    const terminal = await start(`
      let asked = false;
      on('turn.complete', ($, e, next) => {
        if (!asked) {
          asked = true;
          void $.prompt.submit({ text: 'Follow up ${nonce}' });
        }
        return next(e);
      });`);

    await terminal.send(`Look ${nonce}`);
    await terminal.waitForScreen(
      (screen) => screen.includes('Answer 2'),
      "the Mod prompt's answer",
      60_000,
    );

    expect(await terminal.screen()).toContain(
      `Mod followup-mod: Follow up ${nonce}`,
    );
    expect(prompts()).toHaveLength(2);
    expect(prompts()[1]).toContain(
      `<qwen:mod-prompt mod="followup-mod">\nFollow up ${nonce}\n</qwen:mod-prompt>`,
    );
    expect(
      records().map((record) => [
        record['provenance'],
        (record['systemPayload'] as { mod?: string } | undefined)?.mod,
      ]),
    ).toEqual([
      ['real_user', undefined],
      ['mod_prompt', 'followup-mod'],
    ]);
  });

  it('stops a hook that submits at every turn at the limit', async () => {
    const terminal = await start(`
      let n = 0;
      on('turn.complete', ($, e, next) => {
        void $.prompt.submit({ text: 'again ' + ++n });
        return next(e);
      });`);

    await terminal.send('Start');
    await terminal.waitForScreen(
      (screen) => screen.includes('$.prompt.submit refused'),
      'the limit line',
      120_000,
    );
    await terminal.idle(2000, 30_000);

    // The person's turn and eight of the Mod's.
    expect(prompts()).toHaveLength(9);
    expect(await terminal.screen()).toContain(
      'the Mods have started 8 turns since the last prompt from the person',
    );
  });
});
