/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * A Mod on the built CLI reads the environment and the settings, which keep
 * their credentials back, and logs telemetry that goes nowhere.
 */

import { execFile } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { dirname, resolve } from 'node:path';
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
  on('session.start', async ($, e, next) => {
    await $.command.register({ name: 'reads', description: 'Read the host' });
    return next(e);
  });
  on('command.run', { command: 'reads' }, async ($) => {
    await $.telemetry.log({ event: 'reads_ran', props: { count: 1 } });
    await $.telemetry.mark({ feature: 'reads', kind: 'ok' });
    return { text: JSON.stringify({
      home: await $.env.get('HOME'),
      key: (await $.env.get('OPENAI_API_KEY')) ?? null,
      authValue: (await $.env.get('PROBE_AUTH_VALUE')) ?? null,
      authAlias: (await $.env.get('PROBE_AUTH_ALIAS')) ?? null,
      alias: (await $.env.get('PROBE_ALIAS')) ?? null,
      priorAlias: (await $.env.get('PROBE_PRIOR_ALIAS')) ?? null,
      workspaceEnv: await $.env.get('PROBE_WORKSPACE_ACTIVE'),
      general: await $.settings.read({ key: 'general' }),
      auth: await $.settings.read({ key: 'security' }),
      env: await $.settings.read({ key: 'env' }),
      userEnv: await $.settings.read({ source: 'user', key: 'env' }),
      user: Object.keys(await $.settings.read({ source: 'user' })).sort(),
      local: await $.settings.read({ source: 'local' }),
    }) };
  });
}`;

describe('a Mod reading the environment and settings in headless runs', () => {
  let server: FakeOpenAIServer;
  let scratch: string;
  let workspace: string;
  let home: string;
  let env: NodeJS.ProcessEnv;

  beforeAll(async () => {
    scratch = mkdtempSync(join(tmpdir(), 'qwen-mods-reads-'));
    workspace = join(scratch, 'workspace');
    home = join(scratch, 'home');
    const qwenHome = join(home, '.qwen');
    const plugin = join(scratch, 'reads-mod');
    for (const directory of [
      workspace,
      join(workspace, '.qwen'),
      qwenHome,
      join(plugin, '.claude-plugin'),
      join(plugin, 'hooks'),
    ])
      mkdirSync(directory, { recursive: true });
    writeFileSync(
      join(qwenHome, '.env'),
      'PROBE_SOURCE_TOKEN=fixture-home-value\n',
    );
    writeFileSync(
      join(workspace, '.qwen', '.env'),
      'PROBE_SOURCE_TOKEN=fixture-workspace-value\nPROBE_WORKSPACE_ACTIVE=loaded\n',
    );
    json(join(qwenHome, 'settings.json'), {
      experimental: { mods: true },
      general: { enableAutoUpdate: false, vimMode: true },
      memory: E2E_MEMORY_SETTINGS_DEFAULTS,
      env: {
        EDITOR: 'vim',
        PROBE_TOKEN: 'settings-secret',
        PROBE_ALIAS: '${OPENAI_API_KEY}',
        PROBE_AUTH_ALIAS: 'prefix ${PROBE_AUTH_VALUE}',
        PROBE_PRIOR_ALIAS: '${PROBE_SOURCE_TOKEN}',
      },
      security: {
        folderTrust: { enabled: false },
        auth: { selectedType: 'openai', apiKey: '${PROBE_AUTH_VALUE}' },
      },
    });
    json(join(plugin, '.claude-plugin/plugin.json'), {
      name: 'reads-mod',
      version: '1.0.0',
    });
    json(join(plugin, 'hooks/hooks.json'), { modules: ['./register.js'] });
    writeFileSync(join(plugin, 'hooks/register.js'), MOD);
    server = await startFakeOpenAIServer(() => ({ content: 'Answer' }));
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
      QWEN_CODE_NO_RELAUNCH: '1',
      OPENAI_API_KEY: 'env-api-key',
      PROBE_AUTH_VALUE: 'settings-api-key',
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

  it('answers without credentials and sends no model request', async () => {
    const before = server.requests.length;
    const { stdout } = await run(
      process.execPath,
      [
        bundle,
        '-p',
        '/reads',
        '--auth-type',
        'openai',
        '--model',
        'fixture',
        '--openai-base-url',
        server.baseUrl,
        '--output-format',
        'json',
      ],
      { cwd: workspace, env, timeout: 120_000, maxBuffer: 16 * 1024 * 1024 },
    );
    const messages = JSON.parse(stdout) as Array<Record<string, unknown>>;
    const result = messages.at(-1)!;
    expect(result).toMatchObject({ is_error: false });
    expect(JSON.parse(String(result['result']))).toEqual({
      home,
      key: null,
      authValue: null,
      authAlias: null,
      alias: null,
      priorAlias: null,
      workspaceEnv: 'loaded',
      general: { enableAutoUpdate: false, vimMode: true },
      auth: {
        folderTrust: { enabled: false },
        auth: { selectedType: 'openai' },
      },
      env: { EDITOR: 'vim' },
      userEnv: { EDITOR: 'vim' },
      user: expect.arrayContaining(['env', 'general', 'security']),
      local: {},
    });
    for (const secret of [
      'env-api-key',
      'settings-api-key',
      'settings-secret',
      'fixture-home-value',
      'fixture-workspace-value',
    ])
      expect(stdout).not.toContain(secret);
    expect(
      server.requests
        .slice(before)
        .filter((request) => request.body['stream'] === true),
    ).toHaveLength(0);
  });
});
