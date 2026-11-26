/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * A Mod written for Claude Code 2.1.332 in a real terminal: the band above
 * the prompt draws its maxLines, clip, sideways-scroller and Progress
 * elements, and a command runs by its alias under its own name.
 */

import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
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

const MOD = `export function register(on) {
  on('session.stop', ($, e, next) => next(e));
  on('session.start', async ($, e, next) => {
    await $.command.register({ name: 'hello', description: 'Say hello', aliases: ['hi'] });
    return next(e);
  });
  on('command.run', { command: 'hello' }, ($, e) => ({ text: 'ran ' + e.command + ' ' + e.args }));
  on('ui.render', { component: 'AbovePrompt' }, ($, e) => {
    const { Box, Text, Progress } = $.ui.resolve(e);
    return Box({ flexDirection: 'column', children: [
      Text({ maxLines: 2, children: 'Band row one\\nBand row two\\nBand row three' }),
      Text({ maxLines: 1, children: 'One visible row\\nHidden extra row' }),
      Text({ wrap: 'clip', children: 'Clipped ' + 'x'.repeat(300) }),
      Box({ overflowX: 'scroll', mono: true, children: [Text({ children: 'Scrolled ' + 'y'.repeat(300) })] }),
      Progress({ label: 'Indexing', value: 3, max: 10, color: 'success' }),
    ] });
  });
}`;

describe(`A Claude Code 2.1.332 Mod in the ${renderer} terminal`, () => {
  let server: FakeOpenAIServer;
  let session: InteractiveSession;
  let scratch: string;

  beforeAll(async () => {
    scratch = mkdtempSync(join(tmpdir(), `qwen-mods-band-332-${renderer}-`));
    const workspace = join(scratch, 'workspace');
    const qwenHome = join(scratch, 'home');
    const plugin = join(scratch, 'band-332-mod');
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
      general: { enableAutoUpdate: false, showSessionRecap: false },
      ui: { enableFollowupSuggestions: false },
      memory: E2E_MEMORY_SETTINGS_DEFAULTS,
      security: {
        folderTrust: { enabled: false },
        auth: { selectedType: 'openai' },
      },
    });
    json(join(plugin, '.claude-plugin/plugin.json'), {
      name: 'band-332-mod',
      version: '1.0.0',
    });
    json(join(plugin, 'hooks/hooks.json'), { modules: ['./register.js'] });
    writeFileSync(join(plugin, 'hooks/register.js'), MOD);
    server = await startFakeOpenAIServer(() => ({ content: 'Answer' }));
    const cli = resolveE2eCliCommand(renderer);
    execFileSync(cli, [bundle, 'extensions', 'install', plugin, '--consent'], {
      cwd: workspace,
      env,
      timeout: 60_000,
      stdio: 'pipe',
    });
    session = await InteractiveSession.start({
      cols: 100,
      rows: 40,
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
  });

  afterAll(async () => {
    await session?.close();
    await server?.close();
    if (scratch) await removeScratchDir(scratch);
  });

  it('draws maxLines, clip, a sideways scroller and Progress in the band', async () => {
    await session.waitForScreen(
      (screen) => screen.includes('Indexing ███░░░░░░░ 30%'),
      'the band',
      30_000,
    );
    const lines = (await session.screen()).split('\n');
    const line = (start: string) =>
      lines.find((row) => row.trimStart().startsWith(start));
    expect(line('Band row one')).toBeDefined();
    expect(line('Band row two')).toBeDefined();
    expect(line('Band row three')).toBeUndefined();
    expect(line('One visible row')).toBeDefined();
    expect(lines.some((row) => row.includes('Hidden extra row'))).toBe(false);
    // Each cut Text keeps to one row within the band's columns.
    for (const start of ['Clipped', 'Scrolled']) {
      expect(line(start)).toBeDefined();
      expect(line(start)!.trimEnd().length).toBeLessThanOrEqual(100);
    }
    expect(lines.some((row) => row.trimStart().startsWith('xxxx'))).toBe(false);
    expect(lines.some((row) => row.trimStart().startsWith('yyyy'))).toBe(false);
  });

  it('runs a command by its alias under its own name', async () => {
    await session.send('/hi there');
    await session.waitFor('ran hello there', 30_000);
  });
});
