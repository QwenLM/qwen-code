/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { it } from 'vitest';
import { E2E_MEMORY_SETTINGS_DEFAULTS } from '../e2e-memory-defaults.js';
import { startFakeOpenAIServer } from '../fake-openai-server.js';
import { pickE2eRenderer, resolveE2eCliCommand } from '../renderer-matrix.js';
import { InteractiveSession } from './interactive-session.js';
import { createUntil, scaledWait } from './wait.js';
import {
  inventory,
  startExtensionGitFixture,
} from './extension-http-git-fixture.js';

const root = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../..',
);
const renderer = pickE2eRenderer();
const runtime = resolveE2eCliCommand(renderer);
const override = process.env['QWEN_EXTENSION_PARTIAL_COMMAND_JSON'];
const command = override
  ? (JSON.parse(override) as { bin: string; args: string[] })
  : { bin: runtime, args: [path.join(root, 'dist/cli.js')] };
assert(typeof command.bin === 'string' && Array.isArray(command.args));
assert(command.args.every((value) => typeof value === 'string'));
if (override) assert(path.isAbsolute(command.bin));
const until = createUntil(15_000);
const json = (file: string, value: unknown) =>
  fs.writeFileSync(file, JSON.stringify(value, null, 2) + '\n');

it(`partially acquires two HTTP catalog Git plugins with fresh consent and cold reload on ${runtime}+${renderer}`, async () => {
  assert.notEqual(
    process.platform,
    'win32',
    'SETUP_NQ: owned Git HTTP fixture not yet qualified on Windows',
  );
  const outputRoot = process.env['QWEN_TUI_ACCEPTANCE_OUT'];
  assert(outputRoot && path.isAbsolute(outputRoot));
  fs.mkdirSync(outputRoot, { recursive: true });
  const output = fs.realpathSync(
    fs.mkdtempSync(path.join(outputRoot, 'partial-')),
  );
  const home = path.join(output, 'home');
  const workspace = path.join(output, 'workspace');
  const runtimeDir = path.join(output, 'runtime');
  const tmp = path.join(output, 'tmp');
  const bin = path.join(output, 'bin');
  for (const directory of [home, workspace, runtimeDir, tmp, bin])
    fs.mkdirSync(directory);
  const trust = path.join(output, 'trusted-folders.json');
  const settings = path.join(home, 'settings.json');
  json(trust, { [workspace]: 'TRUST_FOLDER' });
  json(path.join(output, 'system.json'), { $version: 4 });
  json(path.join(output, 'defaults.json'), { $version: 4 });
  json(settings, {
    $version: 4,
    security: {
      auth: { selectedType: 'openai' },
      folderTrust: { enabled: true },
    },
    general: { enableAutoUpdate: false, showSessionRecap: false },
    ui: { hideTips: true, enableFollowupSuggestions: false },
    memory: E2E_MEMORY_SETTINGS_DEFAULTS,
  });
  fs.writeFileSync(path.join(workspace, 'unrelated.txt'), 'OWNED_READ_ONLY\n');
  const protectedWorkspace = inventory(workspace);
  const fixed = [
    trust,
    settings,
    path.join(output, 'system.json'),
    path.join(output, 'defaults.json'),
  ].map((file) => ({ file, raw: fs.readFileSync(file, 'base64') }));
  const frames: Record<string, string> = {};
  const phases: Array<Record<string, unknown>> = [];
  const inputs: string[] = [];
  const exits: Array<{ exitCode: number; signal?: number }> = [];
  const cleanupErrors: string[] = [];
  let session: InteractiveSession | undefined;
  let fixture: Awaited<ReturnType<typeof startExtensionGitFixture>> | undefined;
  let model: Awaited<ReturnType<typeof startFakeOpenAIServer>> | undefined;
  let failure: unknown;
  const gitLog = path.join(output, 'git-client.jsonl');
  const registry = path.join(home, 'extensions/marketplaces.json');
  const state = path.join(home, 'extension-store/state.json');
  const preferences = path.join(home, 'extensions/extension-preferences.json');
  const stores = () => ({
    extensions: inventory(path.join(home, 'extensions')),
    authority: fs.existsSync(state)
      ? JSON.parse(fs.readFileSync(state, 'utf8'))
      : null,
    preferences: fs.existsSync(preferences)
      ? JSON.parse(fs.readFileSync(preferences, 'utf8'))
      : null,
  });
  const guard = (label: string) => {
    fixture!.guard();
    assert.deepEqual(inventory(workspace), protectedWorkspace);
    for (const row of fixed)
      assert.equal(fs.readFileSync(row.file, 'base64'), row.raw);
    assert.equal(model!.requests.length, 0);
    phases.push({
      label,
      stores: stores(),
      publisher: inventory(fixture!.publisher),
    });
  };
  const key = async (value: string) => {
    await session!.idle(150, 2000);
    inputs.push(value);
    session!.pressKey(value);
  };
  const type = async (value: string) => {
    for (const char of value) await key(char);
  };
  const submit = async (value: string) => {
    await session!.idle(150, 2000);
    inputs.push(value, '\r');
    await session!.send(value);
  };
  const screen = async (label: string, expected: string[]) => {
    await until(async () => {
      frames[label] = await session!.viewport();
      return expected.every((text) => frames[label].includes(text));
    }, label);
    guard(label);
  };
  const installed = (indices: number[]) => {
    const authority = stores().authority;
    const prefs = stores().preferences;
    const expectedIds = indices.map((index) =>
      createHash('sha256')
        .update(`${fixture!.repository}:${fixture!.names[index]}`)
        .digest('hex'),
    );
    assert.deepEqual(
      Object.keys(authority.extensions).sort(),
      [...expectedIds].sort(),
    );
    fixture!.names.forEach((name, index) => {
      const directory = path.join(home, 'extensions', name);
      if (!indices.includes(index)) {
        assert(!fs.existsSync(directory));
        return;
      }
      assert.equal(
        JSON.parse(
          fs.readFileSync(path.join(directory, 'qwen-extension.json'), 'utf8'),
        ).name,
        name,
      );
      assert.equal(
        fs.readFileSync(
          path.join(
            directory,
            'commands',
            `owned-${index ? 'b' : 'a'}-proof.md`,
          ),
          'utf8',
        ),
        fixture!.commands[index],
      );
      const metadata = JSON.parse(
        fs.readFileSync(
          path.join(directory, '.qwen-extension-install.json'),
          'utf8',
        ),
      );
      assert.equal(metadata.type, 'git');
      assert.equal(metadata.source, fixture!.repository);
      assert.equal(metadata.pluginName, name);
      assert.equal(metadata.gitCommit, fixture!.head);
      const policy = authority.extensions[expectedIds[indices.indexOf(index)]];
      assert.equal(policy.name, name);
      assert.equal(policy.defaultActivation, 'enabled');
      assert.deepEqual(policy.workspaceOverrides, {});
      assert.equal(prefs.scopes[name], 'user');
    });
  };
  const quit = async (label: string) => {
    await key('\x1b');
    await screen(label + '-composer', ['Type your message']);
    await submit('/quit');
    await until(
      () => session!.exitResult() !== undefined,
      label + '-natural-exit',
    );
    assert.deepEqual(session!.exitResult(), { exitCode: 0, signal: 0 });
    exits.push(session!.exitResult()!);
    fs.writeFileSync(
      path.join(output, `terminal-${exits.length}.ansi`),
      session!.output(),
    );
    await session!.close();
    session = undefined;
    guard(label + '-exit');
  };
  const composerHasPrefix = (frame: string, prefix: string) => {
    const rows = frame.split('\n');
    const rules = rows.flatMap((row, index) =>
      /^[ \t]*─{20,}[ \t]*$/.test(row) ? [index] : [],
    );
    const top = rules.at(-2);
    const bottom = rules.at(-1);
    if (top === undefined || bottom !== top + 2) return false;
    const input = /^[ \t]*>[ \t]*(.*)$/.exec(rows[top + 1] ?? '');
    return input?.[1].trimEnd() === prefix;
  };
  const checkCommands = async (label: string) => {
    for (const name of ['owned-a-proof', 'owned-b-proof']) {
      await key('\x1b');
      await screen(label + name + '-composer', ['Type your message']);
      const prefix = '/' + name.slice(0, -1);
      await type(prefix);
      const completion = label + name + '-completion';
      await until(async () => {
        const frame = await session!.viewport();
        frames[completion] = frame;
        return frame.includes(name) && composerHasPrefix(frame, prefix);
      }, completion);
      guard(completion);
      await key('\x15');
      await screen(label + name + '-clear', ['Type your message']);
      await submit('/extensions manage');
      await screen(label + name + '-manager', fixture!.names);
    }
  };
  try {
    fixture = await startExtensionGitFixture(path.join(output, 'source'));
    const wrapper = `#!${process.execPath}\nconst fs=require('node:fs'),cp=require('node:child_process');const args=process.argv.slice(2);fs.appendFileSync(${JSON.stringify(gitLog)},JSON.stringify({phase:'start',argv:args,cwd:process.cwd(),canonicalCwd:fs.realpathSync(process.cwd()),pid:process.pid,ppid:process.ppid})+'\\n');const r=cp.spawnSync(${JSON.stringify(fixture.git)},args,{stdio:'inherit',env:process.env});fs.appendFileSync(${JSON.stringify(gitLog)},JSON.stringify({phase:'end',pid:process.pid,child:r.pid,status:r.status,signal:r.signal,error:r.error?.message})+'\\n');if(r.error||r.signal)process.exit(90);process.exit(r.status??90);\n`;
    json(path.join(bin, 'package.json'), { type: 'commonjs' });
    fs.writeFileSync(path.join(bin, 'git'), wrapper, { mode: 0o755 });
    model = await startFakeOpenAIServer(() => ({
      content: 'UNEXPECTED_PARTIAL_MODEL_REQUEST',
    }));
    json(path.join(output, 'FIXTURE.json'), {
      runtime,
      renderer,
      command,
      git: fixture.git,
      head: fixture.head,
      repository: fixture.repository,
      catalogURL: fixture.catalogURL,
      names: fixture.names,
      commands: fixture.commands,
      publisher: fixture.baseline,
      budgets: {
        case: 120,
        conditionLocal: 15,
        conditionCI: 45,
        effectiveCondition: scaledWait(15_000) / 1000,
        outer: 180,
        retry: 0,
      },
    });
    const start = async () => {
      const startupIndex = exits.length;
      session = await InteractiveSession.start({
        cwd: workspace,
        cols: 120,
        rows: 42,
        inheritEnv: false,
        onStartupFailure: (raw) => {
          fs.writeFileSync(
            path.join(output, `startup-${startupIndex}-failed.ansi`),
            raw,
          );
        },
        onLifecycle: (event) => {
          if (event.type === 'output') {
            fs.appendFileSync(
              path.join(output, `session-${startupIndex}.ansi`),
              event.data,
            );
          } else {
            fs.appendFileSync(
              path.join(output, `startup-${startupIndex}-lifecycle.jsonl`),
              JSON.stringify(event) + '\n',
            );
            if (event.type === 'spawn') {
              fs.writeFileSync(
                path.join(output, `startup-${startupIndex}-spawn.json`),
                JSON.stringify(event, null, 2) + '\n',
              );
            }
          }
        },
        env: {
          PATH: bin + ':' + process.env['PATH'],
          HOME: home,
          USERPROFILE: home,
          QWEN_HOME: home,
          GIT_CONFIG_NOSYSTEM: '1',
          GIT_CONFIG_GLOBAL: '/dev/null',
          GIT_TERMINAL_PROMPT: '0',
          QWEN_RUNTIME_DIR: runtimeDir,
          TMPDIR: tmp,
          TMP: tmp,
          TEMP: tmp,
          QWEN_CODE_TRUSTED_FOLDERS_PATH: trust,
          QWEN_CODE_SYSTEM_SETTINGS_PATH: path.join(output, 'system.json'),
          QWEN_CODE_SYSTEM_DEFAULTS_PATH: path.join(output, 'defaults.json'),
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
        command: {
          bin: command.bin,
          args: [
            ...command.args,
            '--auth-type',
            'openai',
            '--openai-api-key',
            'fixture',
            '--openai-base-url',
            model!.baseUrl,
            '--model',
            'qwen-extension-e2e',
            '--approval-mode',
            'default',
          ],
        },
      });
      await screen('startup-' + exits.length, ['Type your message']);
    };
    await start();
    await submit('/extensions manage');
    await screen('manager', ['Installed', 'Discover', 'Sources']);
    await key('\t');
    await screen('discover-empty', ['No extensions discovered.']);
    await key('\t');
    await screen('sources-empty', ['No marketplaces added yet.']);
    await key('\x1b[B');
    await key('\r');
    await screen('source-input', [
      'Add Marketplace',
      'Enter marketplace source',
    ]);
    await submit(fixture.catalogURL);
    await until(async () => {
      const frame = await session!.viewport();
      frames['source-added'] = frame;
      const rows = frame.split('\n');
      return (
        frame.includes('Added marketplace "owned-partial-market".') &&
        frame.includes('Marketplaces (1)') &&
        rows.some((row) =>
          /^[ \t│]*[›●][\uFE0E\uFE0F]?[ \t]+\+[ \t]+Add new marketplace(?:[ \t]|$)/.test(
            row,
          ),
        ) &&
        rows.some(
          (row) =>
            row.includes('owned-partial-market') &&
            row.includes(fixture!.catalogURL),
        ) &&
        !frame.includes('Adding...')
      );
    }, 'source-added');
    guard('source-added');
    const registered = JSON.parse(fs.readFileSync(registry, 'utf8'));
    assert.equal(registered.length, 1);
    assert.equal(registered[0].type, 'http');
    assert.equal(registered[0].source, fixture.catalogURL);
    const sourceBytes = fs.readFileSync(registry, 'utf8');
    await key('\x1b[B');
    await key('\r');
    await screen('source-detail', ['Browse extensions (2)']);
    await key('\r');
    await screen('browse', fixture.names);
    await key(' ');
    await key('\x1b[B');
    await key(' ');
    await key('\r');
    await screen('scope', [
      'Install 2 extension(s) to which scope?',
      'Global (User Scope)',
    ]);
    await key('\r');
    await screen('approve-a', [
      'Installing extension "owned-partial-a".',
      'Do you want to continue?',
    ]);
    await key('\r');
    await screen('deny-b', [
      'Installing extension "owned-partial-b".',
      'Do you want to continue?',
    ]);
    await key('\x1b[B');
    await key('\r');
    await screen('partial', [
      'Installed 1, failed 1',
      'owned-partial-a',
      'owned-partial-b',
    ]);
    installed([0]);
    assert(
      frames['partial']
        .split('\n')
        .some((line) => /○.*owned-partial-b/.test(line)),
    );
    assert(
      !frames['partial']
        .split('\n')
        .some((line) => /●.*owned-partial-[ab]/.test(line)),
    );
    guard('partial-exact');
    await type('owned-partial-b');
    await until(async () => {
      frames['only-b-query'] = await session!.viewport();
      const rows = frames['only-b-query'].split('\n');
      return (
        rows.some((row) => /^[ \t│]*⌕ owned-partial-b[ \t│]*$/.test(row)) &&
        rows.some((row) => /[○●].*owned-partial-b/.test(row)) &&
        !rows.some((row) => /[○●✓].*owned-partial-a/.test(row))
      );
    }, 'only-b-query');
    guard('only-b-query');
    assert(
      !frames['only-b-query']
        .split('\n')
        .some((line) => /[○●✓].*owned-partial-a/.test(line)),
    );
    await key(' ');
    await key('\r');
    await screen('retry-b-scope', [
      'Install 1 extension(s) to which scope?',
      'Global (User Scope)',
    ]);
    await key('\r');
    await screen('explicit-b-approve', [
      'Installing extension "owned-partial-b".',
      'Do you want to continue?',
    ]);
    await key('\r');
    await screen('both-installed', ['Installed 1 extension(s).']);
    installed([0, 1]);
    guard('both-hot');
    await checkCommands('hot-');
    await quit('hot');
    await start();
    await submit('/extensions manage');
    await screen('cold-installed', fixture.names);
    installed([0, 1]);
    assert.equal(fs.readFileSync(registry, 'utf8'), sourceBytes);
    await checkCommands('cold-');
    installed([0, 1]);
    await quit('cold');
    assert.equal(exits.length, 2);
    assert.equal(fixture.errors.length, 0);
    assert(fixture.requests.some((row) => row['url'] === '/catalog.json'));
    assert(fixture.requests.some((row) => row['method'] === 'POST'));
    const gitEvents = fs
      .readFileSync(gitLog, 'utf8')
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line));
    const clones = gitEvents.filter(
      (row) => row.phase === 'start' && row.argv.includes('clone'),
    );
    assert(clones.length > 0, 'product must really clone from Git');
    for (const clone of clones) {
      const sourceIndex: number = clone.argv.indexOf(fixture.repository);
      assert(sourceIndex >= 0, 'clone must use the actual owned Git URL');
      const rawDestination: string = clone.argv[sourceIndex + 1];
      assert.equal(typeof rawDestination, 'string');
      const destination = path.resolve(clone.canonicalCwd, rawDestination);
      const relative = path.relative(tmp, destination);
      assert(
        relative &&
          relative !== '..' &&
          !relative.startsWith('..' + path.sep) &&
          !path.isAbsolute(relative),
        'clone destination must be strictly inside owned TMPDIR',
      );
      assert(
        !fs.existsSync(destination),
        'product clone destination must be cleaned after resolution',
      );
    }
  } catch (error) {
    failure = error;
  } finally {
    if (session)
      fs.writeFileSync(
        path.join(output, 'terminal-failed.ansi'),
        session.output(),
      );
    for (const action of [
      () => session?.close(),
      () => model?.close(),
      () => fixture?.close(),
    ]) {
      try {
        await action();
      } catch (error) {
        cleanupErrors.push(String(error));
        failure ??= error;
      }
    }
    try {
      assert.equal(model?.requests.length ?? 0, 0, 'no late model request');
      assert.equal(fixture?.errors.length ?? 0, 0, 'no late Git fixture error');
      if (fixture && model) guard('after-cleanup');
    } catch (error) {
      cleanupErrors.push(String(error));
      failure ??= error;
    }
    json(path.join(output, 'frames.json'), frames);
    json(path.join(output, 'phases.json'), phases);
    json(path.join(output, 'inputs.json'), inputs);
    json(path.join(output, 'requests.json'), model?.requests ?? []);
    json(
      path.join(output, 'catalog-git-requests.json'),
      fixture?.requests ?? [],
    );
    let finalStores: unknown;
    try {
      finalStores = stores();
    } catch (error) {
      cleanupErrors.push('final stores: ' + String(error));
      failure ??= error;
      finalStores = { captureError: String(error) };
    }
    json(path.join(output, 'final-stores.json'), finalStores);
    json(path.join(output, 'RESULT.json'), {
      state: failure ? 'FAIL' : 'PASS',
      firstError: failure instanceof Error ? failure.stack : failure,
      cleanupErrors,
      exits,
      modelHTTP: model?.requests.length ?? 0,
      fixtureErrors: fixture?.errors ?? [],
      limits: [
        'Command-only HTTP catalog to Git, not Source50279 local-folder semantics or hooks.',
        'Git child PIDs are wrapper observations; no independent birth/waitpid proof.',
      ],
    });
  }
  if (failure) throw failure;
}, 120_000);
