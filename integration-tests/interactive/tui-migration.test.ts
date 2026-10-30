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
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { E2E_MEMORY_SETTINGS_DEFAULTS } from '../e2e-memory-defaults.js';
import { startFakeOpenAIServer } from '../fake-openai-server.js';
import { pickE2eRenderer, resolveE2eCliCommand } from '../renderer-matrix.js';
import { InteractiveSession } from './interactive-session.js';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const renderer = pickE2eRenderer();
const runtime = resolveE2eCliCommand(renderer);
const bundle = join(root, 'dist/cli.js');
const digest = (value: string | Buffer) =>
  createHash('sha256').update(value).digest('hex');
const writeJson = (path: string, value: unknown) =>
  writeFileSync(path, JSON.stringify(value, null, 2) + '\n');
const prompts = ['migration first 中文🙂', 'migration second turn'];
const answers = ['FIRST_REPLY_甲乙🙂_DONE', 'SECOND_REPLY_丙丁🙂_DONE'];

function artifactFiles(
  directory: string,
  prefix = '',
): Array<[string, string]> {
  return readdirSync(directory, { withFileTypes: true })
    .sort((a, b) => a.name.localeCompare(b.name))
    .flatMap((entry): Array<[string, string]> => {
      const path = join(directory, entry.name);
      const name = prefix + entry.name;
      return entry.isDirectory()
        ? artifactFiles(path, name + '/')
        : [[name, digest(readFileSync(path))]];
    });
}

async function visible(
  session: InteractiveSession,
  predicate: (screen: string) => boolean,
  description: string,
): Promise<string> {
  const deadline = Date.now() + 20_000;
  do {
    const screen = await session.viewport();
    if (predicate(screen)) return screen;
    const exit = session.exitResult();
    if (exit) {
      throw new Error(
        `${description}: CLI exited (${JSON.stringify(exit)})\n${screen}`,
      );
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  } while (Date.now() < deadline);
  throw new Error(
    `${description}\nVisible screen:\n${await session.viewport()}`,
  );
}

describe.sequential(`TUI migration (${runtime}+${renderer})`, () => {
  it('preserves multi-turn submission and Hooks navigation across resize', async () => {
    const scratch = mkdtempSync(join(tmpdir(), 'qwen-tui-migration-'));
    const workspace = join(scratch, 'workspace');
    const home = join(scratch, 'qwen-home');
    const runtimeDir = join(scratch, 'runtime');
    const evidenceRoot =
      process.env['QWEN_TUI_ACCEPTANCE_OUT'] ??
      join(root, '.qwen/e2e-tests/tui-migration');
    for (const path of [workspace, home, runtimeDir, evidenceRoot]) {
      mkdirSync(path, { recursive: true });
    }
    const evidence = mkdtempSync(join(evidenceRoot, `${runtime}-${renderer}-`));
    const frames: Record<string, string> = {};
    let session: InteractiveSession | undefined;
    let failure: string | undefined;
    const server = await startFakeOpenAIServer(({ requestIndex }) => ({
      contentChunks:
        requestIndex < answers.length
          ? [answers[requestIndex].slice(0, 6), answers[requestIndex].slice(6)]
          : ['UNEXPECTED_EXTRA_REQUEST'],
    }));
    try {
      writeJson(join(home, 'settings.json'), {
        security: {
          auth: { selectedType: 'openai' },
          folderTrust: { enabled: false },
        },
        general: { enableAutoUpdate: false, showSessionRecap: false },
        ui: { enableFollowupSuggestions: false },
        memory: E2E_MEMORY_SETTINGS_DEFAULTS,
        hooks: {
          PreToolUse: [
            {
              matcher: '*',
              hooks: [
                {
                  type: 'command',
                  command:
                    '/usr/bin/true # ' +
                    'HOOK_LONG_DETAIL_'.repeat(24) +
                    ' HOOK_END',
                },
              ],
            },
          ],
        },
      });
      session = await InteractiveSession.start({
        cols: 100,
        rows: 30,
        cwd: workspace,
        inheritEnv: false,
        env: {
          PATH: process.env['PATH'],
          HOME: scratch,
          QWEN_HOME: home,
          QWEN_RUNTIME_DIR: runtimeDir,
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
          'fake-key',
          '--openai-base-url',
          server.baseUrl,
          '--model',
          'fake-model',
          '--approval-mode',
          'default',
        ],
      });
      await visible(
        session,
        (screen) =>
          screen.includes('Type your message') &&
          !screen.includes('Initializing...'),
        'ready prompt must be visible after initialization',
      );
      for (let index = 0; index < prompts.length; index++) {
        await session.idle(300);
        await session.send(prompts[index]);
        frames[`turn-${index}`] = await visible(
          session,
          (screen) => screen.includes(answers[index]),
          `response ${index} must reach the viewport`,
        );
        expect(frames[`turn-${index}`].split(answers[index])).toHaveLength(2);
        await session.idle(300);
        expect(server.requests).toHaveLength(index + 1);
        const messages = server.requests[index].body['messages'] as Array<{
          role: string;
          content: unknown;
        }>;
        const users = messages.filter((message) => message.role === 'user');
        expect(users).toHaveLength(index + 1);
        for (let turn = 0; turn <= index; turn++) {
          const content = users[turn].content;
          const parts =
            typeof content === 'string'
              ? [{ type: 'text', text: content }]
              : (content as Array<{ type: string; text?: string }>);
          expect(
            parts.filter((part) => !part.text?.startsWith('<system-reminder>')),
          ).toEqual([{ type: 'text', text: prompts[turn] }]);
        }
        if (index > 0) {
          expect(
            JSON.stringify(messages.filter((m) => m.role === 'assistant')),
          ).toContain(answers[index - 1]);
        }
      }

      await session.idle(300);
      await session.send('/hooks');
      await visible(
        session,
        (screen) => screen.includes('Hooks'),
        'Hooks opens',
      );
      for (const label of ['Matchers', 'Matcher:', 'Command:']) {
        await session.idle(300);
        session.pressKey('\r');
        await visible(
          session,
          (screen) => screen.includes(label),
          `Hooks navigation reaches ${label}`,
        );
      }
      if (renderer === 'opentui') {
        await session.idle(300);
        session.pressKey('\x1b[F');
      }
      frames['detail-wide'] = await visible(
        session,
        (screen) => screen.includes('HOOK_END'),
        'wide detail shows the complete command',
      );
      for (const [cols, rows] of [
        [80, 12],
        [40, 10],
      ]) {
        session.resize(cols, rows);
        await session.idle(300);
        frames[`detail-${cols}x${rows}-head`] = await session.viewport();
        expect(frames[`detail-${cols}x${rows}-head`].split('\n')).toHaveLength(
          rows,
        );
        if (renderer === 'opentui') {
          session.pressKey('\x1b[F');
          frames[`detail-${cols}x${rows}-end`] = await visible(
            session,
            (screen) => screen.includes('help.'),
            `End reaches the final instructions at ${cols}x${rows}`,
          );
          for (
            let step = 0;
            step < 40 && !(await session.viewport()).includes('HOOK_END');
            step++
          ) {
            session.pressKey('\x1b[A');
            await session.idle(100);
          }
          frames[`detail-${cols}x${rows}-command-tail`] = await visible(
            session,
            (screen) => screen.includes('HOOK_END'),
            `the command tail is reachable at ${cols}x${rows}`,
          );
          await session.idle(300);
          session.pressKey('\x1b[H');
          await visible(
            session,
            (screen) => screen.includes('Event:'),
            `Home returns to the detail head at ${cols}x${rows}`,
          );
        }
      }
      session.resize(100, 30);
      await session.idle(300);
      if (renderer === 'opentui') session.pressKey('\x1b[F');
      frames['detail-restored'] = await visible(
        session,
        (screen) => screen.includes('HOOK_END'),
        'restored terminal retains the full detail',
      );
      expect(frames['detail-restored'].split('\n')).toHaveLength(30);
      for (const [step, label] of [
        ['handlers', 'Matcher:'],
        ['matchers', 'Matchers'],
        ['events', 'PostToolUse'],
      ]) {
        session.pressKey('\x1b');
        await session.idle(300);
        frames[`back-${step}`] = await visible(
          session,
          (screen) => screen.includes(label) && !screen.includes('Command:'),
          `Escape returns to ${step}, keeping the dialog open`,
        );
      }
      session.pressKey('\x1b');
      await session.idle(300);
      frames['prompt-restored'] = await visible(
        session,
        (screen) =>
          screen.includes('Type your message') && !screen.includes('Command:'),
        'Escape returns to the prompt',
      );
      expect(server.requests).toHaveLength(2);
    } catch (error) {
      failure =
        error instanceof Error ? (error.stack ?? error.message) : String(error);
    } finally {
      try {
        if (session) {
          frames['final'] = await session.viewport();
        }
        try {
          await session?.close();
        } finally {
          await server.close();
          rmSync(scratch, { recursive: true, force: true });
        }
      } catch (error) {
        const cleanupFailure =
          error instanceof Error ? error.message : String(error);
        failure = [failure, cleanupFailure].filter(Boolean).join('\n');
      } finally {
        if (session) {
          writeFileSync(join(evidence, 'terminal.ansi'), session.output());
        }
        const manifest = artifactFiles(join(root, 'dist'));
        writeJson(join(evidence, 'bundle-manifest.json'), manifest);
        writeJson(join(evidence, 'frames.json'), frames);
        writeJson(join(evidence, 'requests.json'), server.requests);
        writeJson(join(evidence, 'result.json'), {
          result: failure ? 'FAIL' : 'PASS',
          failure,
          source: execFileSync('git', ['rev-parse', 'HEAD'], {
            cwd: root,
            encoding: 'utf8',
          }).trim(),
          workingDiffSha256: digest(
            execFileSync('git', ['diff', 'HEAD'], { cwd: root }),
          ),
          bundleSha256: digest(readFileSync(bundle)),
          bundleManifestSha256: digest(JSON.stringify(manifest)),
          fixtureSha256: digest(readFileSync(fileURLToPath(import.meta.url))),
          lockSha256: digest(readFileSync(join(root, 'pnpm-lock.yaml'))),
          runtime,
          runtimeVersion: execFileSync(runtime, ['--version'], {
            encoding: 'utf8',
          }).trim(),
          renderer,
          strict: renderer === 'opentui',
          exit: session?.exitResult(),
          terminalUnicodeVersion: '11',
          platform: process.platform,
          arch: process.arch,
          inkException:
            renderer === 'ink'
              ? 'Existing short-terminal Hooks clipping is recorded, not asserted as desired behavior.'
              : undefined,
        });
        console.log(`TUI migration evidence: ${evidence}`);
      }
    }
    if (failure) throw new Error(failure);
  });
});
