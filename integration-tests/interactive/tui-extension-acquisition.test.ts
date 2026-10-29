/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import {
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
import { E2E_MEMORY_SETTINGS_DEFAULTS } from '../e2e-memory-defaults.js';
import { startFakeOpenAIServer } from '../fake-openai-server.js';
import { pickE2eRenderer, resolveE2eCliCommand } from '../renderer-matrix.js';
import { InteractiveSession } from './interactive-session.js';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const renderer = pickE2eRenderer();
const runtime = resolveE2eCliCommand(renderer);
const json = (file: string, value: unknown) =>
  writeFileSync(file, JSON.stringify(value, null, 2) + '\n');
const sleep = (ms: number) => new Promise<void>((done) => setTimeout(done, ms));
async function until(check: () => boolean | Promise<boolean>, reason: string) {
  const deadline = Date.now() + 15_000;
  while (!(await check())) {
    if (Date.now() > deadline) throw new Error(reason);
    await sleep(100);
  }
}
type Policy = {
  name: string;
  defaultActivation: string;
  workspaceOverrides: object;
};

it(`acquires a real source through Discover and cold reload on ${runtime}+${renderer}`, async () => {
  const output =
    process.env['QWEN_TUI_ACCEPTANCE_OUT'] ??
    join(root, '.qwen/e2e-tests/tui-extension-acquisition');
  mkdirSync(output, { recursive: true });
  const evidence = mkdtempSync(
    join(output, `extensions-${runtime}-${renderer}-`),
  );
  const scratch = mkdtempSync(join(tmpdir(), 'qwen-ext-'));
  const home = join(scratch, 'home');
  const workspace = join(scratch, 'workspace');
  const runtimeDir = join(scratch, 'runtime');
  const market = join(scratch, 'market');
  const write = (relative: string, value: unknown) => {
    const file = join(market, relative);
    mkdirSync(dirname(file), { recursive: true });
    if (typeof value === 'string') writeFileSync(file, value);
    else json(file, value);
  };
  const command =
    '---\ndescription: Owned fixture command\n---\nReply OWNED_EXTENSION_COMMAND_OK\n';
  const trust = join(scratch, 'trusted-folders.json');
  const registry = join(home, 'extensions', 'marketplaces.json');
  const state = join(home, 'extension-store', 'state.json');
  const preferences = join(home, 'extensions', 'extension-preferences.json');
  const installed = join(home, 'extensions', 'owned-command');
  const frames: Record<string, string> = {};
  const exits: unknown[] = [];
  const sessions: InteractiveSession[] = [];
  const cleanupErrors: string[] = [];
  let session: InteractiveSession | undefined;
  let server: Awaited<ReturnType<typeof startFakeOpenAIServer>> | undefined;
  let failure: unknown;
  const policies = (): Policy[] =>
    existsSync(state)
      ? Object.values(
          (
            JSON.parse(readFileSync(state, 'utf8')) as {
              extensions: Record<string, Policy>;
            }
          ).extensions,
        ).filter((value) => value.name === 'owned-command')
      : [];
  const checkSource = () => {
    const entries = JSON.parse(readFileSync(registry, 'utf8')) as Array<{
      name: string;
      source: string;
      type: string;
      addedAt: string;
    }>;
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      name: 'owned-source-market',
      source: market,
      type: 'local',
    });
    expect(Number.isFinite(Date.parse(entries[0].addedAt))).toBe(true);
  };
  const checkInstalled = () => {
    expect(
      JSON.parse(readFileSync(join(installed, 'qwen-extension.json'), 'utf8')),
    ).toMatchObject({ name: 'owned-command', version: '1.0.0' });
    expect(
      readFileSync(join(installed, 'commands', 'owned-proof.md'), 'utf8'),
    ).toBe(command);
    expect(existsSync(join(home, 'extensions', 'owned-choice'))).toBe(false);
    expect(policies()).toHaveLength(1);
    expect(policies()[0].defaultActivation).toBe('enabled');
    expect(policies()[0].workspaceOverrides).toEqual({});
    expect(
      JSON.parse(readFileSync(preferences, 'utf8')).scopes['owned-command'],
    ).toBe('user');
  };
  const screen = async (label: string, text: string[]) => {
    await until(async () => {
      frames[label] = await session!.viewport();
      return text.every((part) => frames[label].includes(part));
    }, label);
    expect(server!.requests).toHaveLength(0);
  };
  const key = async (value: string) => {
    await session!.idle(150, 2000);
    session!.pressKey(value);
  };
  const submit = async (value: string) => {
    await session!.idle(150, 2000);
    await session!.send(value);
  };
  const quit = async (label: string) => {
    await key('\x1b');
    await screen(label + '-composer', ['Type your message']);
    await submit('/quit');
    await until(
      () => session!.exitResult() !== undefined,
      label + '-natural-exit',
    );
    expect(session!.exitResult()).toEqual({ exitCode: 0, signal: 0 });
    exits.push(session!.exitResult());
    await session!.close();
    session = undefined;
  };
  try {
    for (const directory of [home, workspace, runtimeDir, market])
      mkdirSync(directory, { recursive: true });
    write('.claude-plugin/marketplace.json', {
      name: 'owned-source-market',
      owner: { name: 'Owned Fixture' },
      plugins: [
        {
          name: 'owned-command',
          description: 'Owned command plugin',
          source: './plugins/owned-command',
          commands: ['./commands/owned-proof.md'],
        },
        {
          name: 'owned-choice',
          description: 'Owned second choice',
          source: './plugins/owned-choice',
        },
      ],
    });
    for (const name of ['owned-command', 'owned-choice'])
      write(`plugins/${name}/.claude-plugin/plugin.json`, {
        name,
        version: '1.0.0',
      });
    write('plugins/owned-command/commands/owned-proof.md', command);
    json(trust, { [realpathSync(workspace)]: 'TRUST_FOLDER' });
    json(join(home, 'settings.json'), {
      security: {
        auth: { selectedType: 'openai' },
        folderTrust: { enabled: true },
      },
      general: { enableAutoUpdate: false, showSessionRecap: false },
      ui: { enableFollowupSuggestions: false },
      memory: E2E_MEMORY_SETTINGS_DEFAULTS,
    });
    server = await startFakeOpenAIServer(() => ({
      content: 'UNEXPECTED_ACQUISITION_HTTP',
    }));
    const start = async () => {
      session = await InteractiveSession.start({
        cwd: workspace,
        cols: 120,
        rows: 42,
        inheritEnv: false,
        env: {
          PATH: process.env['PATH'],
          HOME: home,
          USERPROFILE: home,
          QWEN_HOME: home,
          QWEN_RUNTIME_DIR: runtimeDir,
          QWEN_CODE_TRUSTED_FOLDERS_PATH: trust,
          TERM: 'xterm-256color',
          LANG: 'en_US.UTF-8',
          QWEN_CODE_LANG: 'en',
          QWEN_SANDBOX: 'false',
          QWEN_CODE_DISABLE_CRON: '1',
          QWEN_CODE_SKIP_UPDATE_CHECK_ONCE: 'true',
          QWEN_CODE_MODELS_DEV_REFRESH: 'off',
          QWEN_USAGE_STATISTICS_ENABLED: 'false',
          QWEN_TELEMETRY_ENABLED: 'false',
          NO_PROXY: 'localhost,127.0.0.1',
          no_proxy: 'localhost,127.0.0.1',
        },
        args: [
          '--auth-type',
          'openai',
          '--openai-api-key',
          'fixture',
          '--openai-base-url',
          server!.baseUrl,
          '--model',
          'qwen-extension-e2e',
          '--approval-mode',
          'default',
        ],
      });
      sessions.push(session);
      await screen(`startup-${sessions.length}`, ['Type your message']);
    };
    await start();
    await submit('/extensions manage');
    await screen('installed-empty', ['Installed', 'Discover', 'Sources']);
    await key('\t');
    await screen('discover-empty', ['No extensions discovered.']);
    await key('\t');
    await screen('sources-empty', ['No marketplaces added yet.']);
    await key('\x1b[B');
    await key('\r');
    await screen('source-input', [
      'Add Marketplace',
      'Enter marketplace source (Claude format):',
    ]);
    await submit(market);
    await screen('source-added', ['Added marketplace "owned-source-market".']);
    checkSource();
    expect(existsSync(installed)).toBe(false);
    await key('\x1b[B');
    await key('\r');
    await screen('source-detail', [
      'owned-source-market',
      'Browse extensions (2)',
    ]);
    await key('\r');
    await screen('browse', ['owned-command', 'owned-choice']);
    await submit('owned-command');
    await screen('plugin-detail', ['Install for you (user scope)']);
    const consent = async (label: string) => {
      await key('\r');
      await screen(label, [
        'Installing extension "owned-command".',
        'owned-proof',
        'Do you want to continue?',
        'Yes',
        'No',
      ]);
    };
    await consent('deny');
    await key('\x1b[B');
    await key('\r');
    await screen('denied', [
      'Installation cancelled for "owned-command".',
      'Install for you (user scope)',
    ]);
    expect(existsSync(installed)).toBe(false);
    expect(policies()).toEqual([]);
    expect(existsSync(join(home, 'extensions', 'owned-choice'))).toBe(false);
    await consent('approve');
    await key('\r');
    await screen('installed', ['Installed 1 extension(s).']);
    checkInstalled();
    checkSource();
    const persistedSource = readFileSync(registry, 'utf8');
    await quit('first');
    await start();
    await submit('/extensions manage');
    await screen('cold-installed', ['Installed', 'owned-command']);
    checkInstalled();
    checkSource();
    expect(readFileSync(registry, 'utf8')).toBe(persistedSource);
    await key('\x1b');
    await screen('completion-composer', ['Type your message']);
    for (const char of '/owned-pr') {
      await key(char);
    }
    await screen('loaded-command-completion', [
      'owned-proof',
      'Owned fixture command',
    ]);
    await key('\x15');
    await screen('completion-cleared', ['Type your message']);
    await submit('/extensions manage');
    await screen('cold-manager', ['Installed', 'owned-command']);
    await key('\t');
    await screen('cold-discover', ['Discover extensions', 'owned-choice']);
    await key('\t');
    await screen('cold-sources', ['Marketplaces (1)', '(local)']);
    await quit('cold');
    expect(server.requests).toHaveLength(0);
    expect(exits).toHaveLength(2);
    expect(JSON.parse(readFileSync(trust, 'utf8'))).toEqual({
      [realpathSync(workspace)]: 'TRUST_FOLDER',
    });
  } catch (error) {
    failure = error;
  } finally {
    const preserve = async (action: () => unknown) => {
      try {
        await action();
      } catch (error) {
        cleanupErrors.push(String(error));
        failure ??= error;
      }
    };
    for (const [index, active] of sessions.entries())
      await preserve(() =>
        writeFileSync(
          join(evidence, `terminal-${index}.ansi`),
          active.output(),
        ),
      );
    await preserve(() =>
      json(join(evidence, 'requests.json'), server?.requests ?? []),
    );
    await preserve(() => json(join(evidence, 'frames.json'), frames));
    const exitBeforeClose = session?.exitResult();
    for (const active of sessions) await preserve(() => active.close());
    await preserve(() => server?.close());
    for (const [name, file] of Object.entries({
      'marketplace.json': join(market, '.claude-plugin', 'marketplace.json'),
      'trusted-folders.json': trust,
      'marketplaces.json': registry,
      'extension-state.json': state,
      'extension-preferences.json': preferences,
      'installed-manifest.json': join(installed, 'qwen-extension.json'),
      'installed-command.md': join(installed, 'commands', 'owned-proof.md'),
    }))
      if (existsSync(file))
        await preserve(() =>
          writeFileSync(join(evidence, name), readFileSync(file)),
        );
    await preserve(() => {
      rmSync(scratch, { recursive: true, force: true });
      expect(existsSync(scratch)).toBe(false);
    });
    await preserve(() =>
      json(join(evidence, 'result.json'), {
        result: failure ? 'FAIL' : 'PASS',
        failure:
          failure instanceof Error
            ? (failure.stack ?? failure.message)
            : failure && String(failure),
        cleanupErrors,
        naturalExits: exits,
        exitBeforeClose,
        scratch,
        scratchRemoved: !existsSync(scratch),
        trustPrecondition:
          'owned workspace TRUST_FOLDER; folder-trust UI not tested',
      }),
    );
  }
  if (failure) throw failure;
}, 120_000);
