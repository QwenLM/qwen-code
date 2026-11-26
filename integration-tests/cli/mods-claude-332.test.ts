/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * A Mod written for Claude Code 2.1.332 on the built CLI in headless runs: it
 * hooks events Qwen Code does not run, registers a command with an alias and
 * one for the terminal alone, and answers turn.complete with `by`.
 */

import { execFile } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
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

const MOD = `export function register(on) {
  on('session.stop', ($, e, next) => next(e));
  on('vcs.*', ($, e, next) => next(e));
  on('session.start', async ($, e, next) => {
    $.ui.invalidate('tool.offer');
    await $.command.register({
      name: 'hello', description: 'Say hello', aliases: ['hi'],
      immediate: true, isHidden: true, isWorkspaceFree: true,
    });
    await $.command.register({ name: 'pane', description: 'Open a pane', isTerminalOnly: true });
    return next(e);
  });
  on('command.run', { command: 'hello' }, ($, e) =>
    ({ text: 'ran ' + e.command + ' ' + e.args, isTextDisplayOnly: true }));
  on('command.run', { command: 'pane' }, () => ({ text: 'pane opened' }));
  on('turn.complete', async ($, e, next) =>
    ({ ...(await next(e)), text: 'note', by: ['claude-332-mod'] }));
}`;

type Message = Record<string, unknown>;

describe('a Mod written for Claude Code 2.1.332 in headless runs', () => {
  let server: FakeOpenAIServer;
  let scratch: string;
  let workspace: string;
  let env: NodeJS.ProcessEnv;

  beforeAll(async () => {
    scratch = mkdtempSync(join(tmpdir(), 'qwen-mods-claude-332-'));
    workspace = join(scratch, 'workspace');
    const home = join(scratch, 'home');
    const qwenHome = join(home, '.qwen');
    const plugin = join(scratch, 'claude-332-mod');
    for (const directory of [
      workspace,
      qwenHome,
      join(plugin, '.claude-plugin'),
      join(plugin, 'hooks'),
    ])
      mkdirSync(directory, { recursive: true });
    json(join(qwenHome, 'settings.json'), {
      experimental: { mods: true },
      general: { enableAutoUpdate: false },
      memory: E2E_MEMORY_SETTINGS_DEFAULTS,
      security: {
        folderTrust: { enabled: false },
        auth: { selectedType: 'openai' },
      },
    });
    json(join(plugin, '.claude-plugin/plugin.json'), {
      name: 'claude-332-mod',
      version: '1.0.0',
    });
    json(join(plugin, 'hooks/hooks.json'), { modules: ['./register.js'] });
    writeFileSync(join(plugin, 'hooks/register.js'), MOD);
    server = await startFakeOpenAIServer(({ body }) =>
      body['stream'] === true ? { content: 'Answer' } : { content: '{}' },
    );
    env = {
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
    await run(
      process.execPath,
      [bundle, 'extensions', 'install', plugin, '--consent'],
      { cwd: workspace, env, timeout: 120_000 },
    );
  });

  afterAll(async () => {
    await server?.close();
    if (scratch) await removeScratchDir(scratch);
  });

  async function headless(prompt: string): Promise<{
    messages: Message[];
    logs: string[];
    result: Message;
    modelCalls: number;
  }> {
    const before = server.requests.length;
    let stdout: string;
    try {
      ({ stdout } = await run(
        process.execPath,
        [
          bundle,
          '-p',
          prompt,
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
        ],
        {
          cwd: workspace,
          env,
          timeout: 120_000,
          maxBuffer: 16 * 1024 * 1024,
        },
      ));
    } catch (error) {
      // A refused command exits 1 and still prints its result.
      stdout = (error as { stdout: string }).stdout;
    }
    const messages = JSON.parse(stdout) as Message[];
    return {
      messages,
      logs: messages
        .filter(
          (message) =>
            message['type'] === 'system' && message['subtype'] === 'ui_log',
        )
        .map(
          (message) =>
            (message['data'] as { text?: string } | undefined)?.text ?? '',
        ),
      result: messages.at(-1)!,
      modelCalls: server.requests
        .slice(before)
        .filter((request) => request.body['stream'] === true).length,
    };
  }

  it('loads, skips the hooks it cannot run, and shows the note it answers with `by`', async () => {
    const { logs, result } = await headless('Say hi');
    expect(logs).toEqual([
      'Hooks for unsupported events will not run: session.stop, vcs.*',
      'note',
    ]);
    expect(result).toMatchObject({ is_error: false, result: 'Answer' });
  });

  it('runs a command by its alias under its own name, with no model request', async () => {
    const { result, modelCalls } = await headless('/hi there');
    expect(result).toMatchObject({
      is_error: false,
      result: 'ran hello there',
    });
    expect(modelCalls).toBe(0);
  });

  it('refuses a terminal-only command instead of sending it to the model', async () => {
    const { result, modelCalls } = await headless('/pane');
    expect(result).toMatchObject({
      is_error: true,
      error: { message: 'The command "/pane" is not supported in this mode.' },
    });
    expect(modelCalls).toBe(0);
  });
});
