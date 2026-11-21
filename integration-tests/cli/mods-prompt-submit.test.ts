/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * A Mod's `$.prompt.submit` on the built CLI in a headless run, through the
 * whole chain: the worker raises `prompt.submit` through the other hooks, the
 * session queues what arrives, the run starts a turn for it once idle, and the
 * model request, the transcript and the Mods' turn events all see it.
 */

import { execFile } from 'node:child_process';
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
import { promisify } from 'node:util';
import { afterEach, describe, expect, it } from 'vitest';
import {
  startFakeOpenAIServer,
  type FakeOpenAIServer,
} from '../fake-openai-server.js';
import { E2E_MEMORY_SETTINGS_DEFAULTS } from '../e2e-memory-defaults.js';
import { removeScratchDir } from '../scratch-dir.js';

const repo = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const bundle = join(repo, 'dist/cli.js');
const run = promisify(execFile);
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
type Result = {
  messages: Array<Record<string, unknown>>;
  /** The last user message of each main-conversation model request. */
  prompts: string[];
  records: Array<Record<string, unknown>>;
};

const text = (content: unknown): string =>
  typeof content === 'string'
    ? content
    : Array.isArray(content)
      ? content.map((part) => (part as { text?: string }).text ?? '').join('\n')
      : '';

describe('$.prompt.submit in a headless run', () => {
  let server: FakeOpenAIServer | undefined;
  let scratch: string | undefined;

  afterEach(async () => {
    await server?.close();
    server = undefined;
    if (scratch) await removeScratchDir(scratch);
    scratch = undefined;
  });

  async function headless(hooks: string): Promise<Result> {
    scratch = mkdtempSync(join(tmpdir(), 'qwen-mods-prompt-submit-'));
    const workspace = join(scratch, 'workspace');
    const home = join(scratch, 'home');
    const qwenHome = join(home, '.qwen');
    const plugin = join(scratch, 'followup-mod');
    for (const directory of [
      workspace,
      qwenHome,
      join(plugin, '.claude-plugin'),
      join(plugin, 'hooks'),
    ])
      mkdirSync(directory, { recursive: true });
    json(join(qwenHome, 'settings.json'), {
      experimental: { mods: true },
      general: { enableAutoUpdate: false, chatRecording: true },
      memory: E2E_MEMORY_SETTINGS_DEFAULTS,
      security: {
        folderTrust: { enabled: false },
        auth: { selectedType: 'openai' },
      },
    });
    json(join(plugin, '.claude-plugin/plugin.json'), {
      name: 'followup-mod',
      version: '1.0.0',
    });
    json(join(plugin, 'hooks/hooks.json'), { modules: ['./register.js'] });
    writeFileSync(
      join(plugin, 'hooks/register.js'),
      `export function register(on) {
        on('session.start', async ($, e, next) => {
          const { methods } = (await $.session.version()).qwen;
          $.ui.log('lists prompt.submit: ' + methods.includes('prompt.submit'));
          return next(e);
        });
        on('turn.start', ($, e, next) => { $.ui.log('turn.start: ' + e.text); return next(e); });
        ${hooks}
      }`,
    );

    let answered = 0;
    server = await startFakeOpenAIServer(({ body }) =>
      body['stream'] === true
        ? { content: `Answer ${++answered}` }
        : { content: '{}' },
    );
    const env = {
      PATH: process.env['PATH'],
      HOME: home,
      USERPROFILE: home,
      QWEN_HOME: qwenHome,
      QWEN_RUNTIME_DIR: join(scratch, 'runtime'),
      NO_PROXY: 'localhost,127.0.0.1',
      no_proxy: 'localhost,127.0.0.1',
      QWEN_SANDBOX: 'false',
      QWEN_CODE_DISABLE_CRON: '1',
      QWEN_CODE_DISABLE_UPDATE_CHECK: '1',
    };
    const cli = (args: string[]) =>
      run(process.execPath, [bundle, ...args], {
        cwd: workspace,
        env,
        timeout: 120_000,
        maxBuffer: 16 * 1024 * 1024,
      });
    await cli(['extensions', 'install', plugin, '--consent']);
    const { stdout } = await cli([
      '-p',
      'Look for TODOs',
      '--auth-type',
      'openai',
      '--model',
      'fixture',
      '--openai-base-url',
      server.baseUrl,
      '--openai-api-key',
      'fixture',
      '--output-format',
      'json',
    ]);
    const prompts = server.requests
      .filter((request) => request.body['stream'] === true)
      .map((request) =>
        text(
          ((request.body['messages'] ?? []) as Message[])
            .filter((message) => message.role === 'user')
            .at(-1)?.content,
        ),
      );
    // The transcript is under the runtime dir.
    const records = files(scratch)
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
    return { messages: JSON.parse(stdout), prompts, records };
  }

  const logs = (result: Result) =>
    result.messages
      .filter(
        (message) =>
          message['type'] === 'system' && message['subtype'] === 'ui_log',
      )
      .map(
        (message) =>
          (message['data'] as { text?: string } | undefined)?.text ?? '',
      );

  it('runs the prompt as a turn of its own, framed, with the hooks context', async () => {
    const result = await headless(`
      let asked = false;
      on('turn.complete', async ($, e, next) => {
        if (!asked) {
          asked = true;
          const r = await $.prompt.submit({ text: 'List the TODOs you just mentioned.' });
          $.ui.log('submitted: ' + JSON.stringify(r));
        }
        return next(e);
      });
      on('prompt.submit', ($, e, next) =>
        next({ ...e, context: [...(e.context ?? []), 'Mod context: from ' + e.origin.kind] }));`);

    expect(logs(result)).toEqual([
      'lists prompt.submit: true',
      'turn.start: Look for TODOs',
      expect.stringContaining(
        '"origin":{"kind":"plugin","name":"followup-mod"}',
      ),
      'turn.start: List the TODOs you just mentioned.',
    ]);
    expect(result.prompts).toHaveLength(2);
    expect(result.prompts[1]).toContain(
      '<qwen:mod-prompt mod="followup-mod">\nList the TODOs you just mentioned.\n</qwen:mod-prompt>',
    );
    expect(result.prompts[1]).toContain('the user did not type it');
    expect(result.prompts[1]).toContain('Mod context: from plugin');
    // The record is the Mod's; the person's prompt stays theirs.
    expect(
      result.records.map((record) => [
        record['provenance'],
        (record['systemPayload'] as { mod?: string } | undefined)?.mod,
      ]),
    ).toEqual([
      ['real_user', undefined],
      ['mod_prompt', 'followup-mod'],
    ]);
    expect(result.messages.at(-1)).toMatchObject({
      type: 'result',
      is_error: false,
      num_turns: 2,
      result: 'Answer 2',
    });
  });

  it('sends a prompt submitted as the person own words bare', async () => {
    const result = await headless(`
      let asked = false;
      on('turn.complete', async ($, e, next) => {
        if (!asked) { asked = true; await $.prompt.submit({ text: 'Say done', asUser: true }); }
        return next(e);
      });`);

    expect(result.prompts).toHaveLength(2);
    expect(result.prompts[1]).toMatch(/Say done$/);
    expect(result.prompts[1]).not.toContain('qwen:mod-prompt');
  });

  it('stops a hook that submits at every turn at the limit', async () => {
    const result = await headless(`
      let n = 0;
      on('turn.complete', async ($, e, next) => {
        const r = await $.prompt.submit({ text: 'again ' + ++n });
        if ('drop' in r) $.ui.log('dropped: ' + r.drop);
        return next(e);
      });`);

    // The person's turn and eight of the Mod's.
    expect(result.prompts).toHaveLength(9);
    expect(logs(result)).toContain(
      '$.prompt.submit refused: the Mods have started 8 turns since the last prompt from the person',
    );
    expect(logs(result)).toContain(
      'dropped: the Mods have started 8 turns since the last prompt from the person',
    );
    expect(result.messages.at(-1)).toMatchObject({
      type: 'result',
      is_error: false,
      num_turns: 9,
    });
  });
});
