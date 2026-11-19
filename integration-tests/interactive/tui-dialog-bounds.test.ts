/**
 * @license
 * Copyright 2026 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { expect, it } from 'vitest';
import {
  InteractiveSession,
  sendAboutUntilRendered,
} from './interactive-session.js';
import { pickE2eRenderer, resolveE2eCliCommand } from '../renderer-matrix.js';
import { startFakeOpenAIServer } from '../fake-openai-server.js';
import { E2E_MEMORY_SETTINGS_DEFAULTS } from '../e2e-memory-defaults.js';
import { createUntil } from './wait.js';

const renderer = pickE2eRenderer();
const runtime = resolveE2eCliCommand(renderer);
const json = (file: string, value: unknown) =>
  writeFileSync(file, JSON.stringify(value, null, 2) + '\n');

it(`keeps a short model dialog title, multiple choices and footer visible (${runtime}+${renderer})`, async () => {
  const output =
    process.env['QWEN_TUI_ACCEPTANCE_OUT'] ??
    resolve('.qwen/e2e-tests/tui-dialog-bounds');
  mkdirSync(output, { recursive: true });
  const evidence = mkdtempSync(
    join(output, `compact-model-${runtime}-${renderer}-`),
  );
  const workspace = join(evidence, 'workspace');
  const home = join(evidence, 'home');
  const runtimeDir = join(evidence, 'runtime');
  for (const directory of [workspace, home, runtimeDir]) mkdirSync(directory);
  const system = join(evidence, 'system.json');
  const defaults = join(evidence, 'defaults.json');
  json(system, { $version: 4 });
  json(defaults, { $version: 4 });
  json(join(home, 'settings.json'), {
    $version: 4,
    security: {
      auth: { selectedType: 'openai' },
      folderTrust: { enabled: false },
    },
    general: { enableAutoUpdate: false, showSessionRecap: false },
    ui: { theme: 'Qwen Dark', enableFollowupSuggestions: false },
    memory: E2E_MEMORY_SETTINGS_DEFAULTS,
    modelProviders: {
      openai: Array.from({ length: 12 }, (_, index) => ({
        id: `boundary-${String(index).padStart(2, '0')}`,
        name: `Boundary ${index}`,
        envKey: 'BOUNDARY_API_KEY',
      })),
    },
  });
  const server = await startFakeOpenAIServer(() => ({
    content: 'UNEXPECTED_MODEL_REQUEST',
  }));
  const frames: Record<string, string> = {};
  let session: InteractiveSession | undefined;
  let failure: unknown;
  try {
    session = await InteractiveSession.start({
      cwd: workspace,
      cols: 70,
      rows: 40,
      inheritEnv: false,
      args: [
        '--auth-type',
        'openai',
        '--openai-api-key',
        'fixture',
        '--openai-base-url',
        server.baseUrl,
        '--model',
        'boundary-00',
      ],
      env: {
        PATH: process.env['PATH'],
        HOME: evidence,
        QWEN_HOME: home,
        QWEN_RUNTIME_DIR: runtimeDir,
        QWEN_CODE_SYSTEM_SETTINGS_PATH: system,
        QWEN_CODE_SYSTEM_DEFAULTS_PATH: defaults,
        QWEN_CODE_SKIP_UPDATE_CHECK_ONCE: 'true',
        QWEN_CODE_MODELS_DEV_REFRESH: 'off',
        QWEN_CODE_DISABLE_CRON: '1',
        BOUNDARY_API_KEY: 'fixture',
        TERM: 'xterm-256color',
        LANG: 'en_US.UTF-8',
        QWEN_CODE_LANG: 'en',
        QWEN_SANDBOX: 'false',
        NO_PROXY: 'localhost,127.0.0.1',
      },
      onStartupFailure: (raw) =>
        writeFileSync(join(evidence, 'startup.ansi'), raw),
    });
    await sendAboutUntilRendered(session);
    session.resize(70, 18);
    await session.idle(300, 1500);
    await session.send('/model');
    frames['compact'] = await session.waitForScreen(
      (screen) =>
        screen.includes('Select Model') && screen.includes('Enter to select'),
      'short model dialog must retain its title and keyboard footer',
      12_000,
    );
    const lines = frames['compact'].split('\n');
    const title = lines.findIndex((line) => line.includes('Select Model'));
    const top = lines
      .slice(0, title)
      .findLastIndex((line) => /╭─+╮/.test(line));
    const bottom =
      title + lines.slice(title).findIndex((line) => /╰─+╯/.test(line));
    expect(top).toBeGreaterThanOrEqual(0);
    expect(bottom).toBeGreaterThan(title);
    frames['model-panel'] = lines.slice(top, bottom + 1).join('\n');
    expect(frames['model-panel']).toContain('Enter to select');
    expect(frames['model-panel']).not.toContain('Context Window');
    expect(frames['model-panel']).not.toContain('Base URL');
    expect(
      new Set(frames['model-panel'].match(/boundary-\d+/g)).size,
    ).toBeGreaterThanOrEqual(2);
    expect(server.requests).toHaveLength(0);
    session.pressKey('\x1b');
    await session.idle(150, 750);
    frames['dismissed'] = await session.viewport();
    expect(frames['dismissed']).not.toContain('Select Model');
    session.pressKey('\x03');
    await session.idle(150, 750);
    session.pressKey('\x03');
    await createUntil(5000)(
      () => session!.exitResult() !== undefined,
      'clean exit',
    );
    expect(session.exitResult()?.exitCode).toBe(0);
  } catch (error) {
    failure = error;
    throw error;
  } finally {
    if (session) {
      frames['final'] = await session.viewport();
      writeFileSync(join(evidence, 'terminal.ansi'), session.output());
      await session.close();
    }
    await server.close();
    json(join(evidence, 'frames.json'), frames);
    json(join(evidence, 'requests.json'), server.requests);
    json(join(evidence, 'result.json'), {
      result: failure ? 'FAIL' : 'PASS',
      failure: failure && String(failure),
      renderer,
      runtime,
      exit: session?.exitResult(),
    });
  }
});
