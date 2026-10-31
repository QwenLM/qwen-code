/**
 * @license
 * Copyright 2026 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import type { StatusLineCommandInput } from '../../packages/cli/src/ui/hooks/useStatusLine.js';
import { E2E_MEMORY_SETTINGS_DEFAULTS } from '../e2e-memory-defaults.js';
import { startFakeOpenAIServer } from '../fake-openai-server.js';
import { pickE2eRenderer, resolveE2eCliCommand } from '../renderer-matrix.js';
import { InteractiveSession } from './interactive-session.js';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const runtime = resolveE2eCliCommand(pickE2eRenderer());
const renderer = pickE2eRenderer();
const hash = (value: string | Buffer) =>
  createHash('sha256').update(value).digest('hex');
const json = (file: string, value: unknown) =>
  writeFileSync(file, JSON.stringify(value, null, 2) + '\n');
const quote = (value: string) => "'" + value.replaceAll("'", "'\\''") + "'";
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

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
        : [[name, hash(readFileSync(path))]];
    });
}

async function until(check: () => boolean | Promise<boolean>, message: string) {
  const deadline = Date.now() + 20_000;
  while (!(await check())) {
    if (Date.now() > deadline) throw new Error(message);
    await sleep(50);
  }
}

interface CommandRecord {
  pid: number;
  started: string;
  input: StatusLineCommandInput;
}

function sameCommand(record: CommandRecord, script: string): boolean {
  try {
    const started = execFileSync(
      'ps',
      ['-p', String(record.pid), '-o', 'lstart='],
      { encoding: 'utf8' },
    ).trim();
    const args = execFileSync('ps', ['-p', String(record.pid), '-o', 'args='], {
      encoding: 'utf8',
    }).trim();
    return started === record.started && args.includes(script);
  } catch {
    return false;
  }
}

describe.skipIf(process.platform === 'win32')(
  `statusline (${runtime}+${renderer})`,
  () => {
    it.each(['command', 'preset'] as const)(
      'preserves the real %s configuration-to-display cycle',
      async (kind) => {
        const out =
          process.env['QWEN_TUI_ACCEPTANCE_OUT'] ??
          join(root, '.qwen/e2e-tests/tui-migration');
        mkdirSync(out, { recursive: true });
        const evidence = mkdtempSync(
          join(out, `statusline-${renderer}-${kind}-`),
        );
        const scratch = realpathSync(
          mkdtempSync(join(tmpdir(), 'qwen-statusline-')),
        );
        const cwd = join(scratch, 'workspace');
        const home = join(scratch, 'qwen-home');
        const settings = join(home, 'settings.json');
        const system = join(scratch, 'system.json');
        const defaults = join(scratch, 'defaults.json');
        const control = join(scratch, 'control.json');
        const log = join(scratch, 'command.jsonl');
        const script = join(
          root,
          'integration-tests/helpers/statusline-command.mjs',
        );
        const frames: Record<string, string> = {};
        const exits: unknown[] = [];
        let manifest: Array<[string, string]> | undefined;
        let session: InteractiveSession | undefined;
        let failure: unknown;
        const cleanupErrors: string[] = [];
        let server:
          | Awaited<ReturnType<typeof startFakeOpenAIServer>>
          | undefined;
        const records = (): CommandRecord[] =>
          existsSync(log)
            ? readFileSync(log, 'utf8')
                .split('\n')
                .slice(0, -1)
                .filter(Boolean)
                .map((line) => JSON.parse(line) as CommandRecord)
            : [];
        const snapshot = () =>
          [settings, system, defaults, join(cwd, '.qwen/settings.json')].map(
            (file) => (existsSync(file) ? readFileSync(file, 'utf8') : null),
          );
        const current = () => {
          if (!session) throw new Error('No active statusline test session');
          return session;
        };
        const visible = async (value: string, label: string) =>
          until(async () => {
            expect(current().exitResult()).toBeUndefined();
            frames[label] = await current().viewport();
            return frames[label].includes(value);
          }, `${label}: ${value}`);
        const press = async (key: string) => {
          await current().idle(150, 700);
          current().pressKey(key);
          await current().idle(150, 700);
        };
        const type = async (text: string) => {
          await current().idle(150, 700);
          for (const char of text) {
            current().pressKey(char);
            await sleep(8);
          }
          await current().idle(150, 700);
        };
        let launches = 0;
        const launch = async () => {
          session = await InteractiveSession.start({
            cwd,
            cols: 120,
            rows: 40,
            inheritEnv: false,
            env: {
              PATH: process.env['PATH'],
              HOME: scratch,
              QWEN_HOME: home,
              QWEN_RUNTIME_DIR: join(scratch, 'runtime'),
              QWEN_CODE_SYSTEM_SETTINGS_PATH: system,
              QWEN_CODE_SYSTEM_DEFAULTS_PATH: defaults,
              TERM: 'xterm-256color',
              COLORTERM: 'truecolor',
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
              server!.baseUrl,
              '--model',
              'statusline-model',
              '--approval-mode',
              'default',
            ],
          });
          launches++;
          await visible('Type your message', `ready-${launches}`);
        };
        const quit = async () => {
          await type('/quit ');
          await press('\r');
          await until(
            () => current().exitResult() !== undefined,
            '/quit exits',
          );
          expect(current().exitResult()).toMatchObject({ exitCode: 0 });
          exits.push(current().exitResult());
          writeFileSync(
            join(evidence, `session-${launches}.ansi`),
            current().output(),
          );
          await current().close();
          session = undefined;
        };
        const open = async () => {
          await type('/statusline ');
          await press('\r');
          await visible('Configure Status Line', 'dialog');
          expect(server!.requests).toHaveLength(0);
        };
        const selected = async (label: string, checked: boolean) => {
          const frame = await current().viewport();
          const row = frame
            .split('\n')
            .find((value) => value.includes(label) && /\[[ x]\]/.test(value));
          expect(row).toBeDefined();
          expect(row?.includes('[x]')).toBe(checked);
        };
        try {
          for (const dir of [cwd, home]) mkdirSync(dir, { recursive: true });
          manifest = artifactFiles(join(root, 'dist'));
          json(join(evidence, 'bundle-manifest.json'), manifest);
          server = await startFakeOpenAIServer(() => ({
            content: 'STATUSLINE_REPLY',
            usage: {
              prompt_tokens: 13,
              completion_tokens: 7,
              total_tokens: 20,
            },
          }));
          json(system, { $version: 4 });
          json(defaults, { $version: 4 });
          json(control, { phase: 'A' });
          json(settings, {
            $version: 4,
            security: {
              auth: { selectedType: 'openai' },
              folderTrust: { enabled: false },
            },
            general: { enableAutoUpdate: false, showSessionRecap: false },
            ui: {
              enableFollowupSuggestions: false,
              statusLine:
                kind === 'command'
                  ? {
                      type: 'command',
                      command: `exec ${quote(process.execPath)} ${quote(script)} ${quote(log)} ${quote(control)}`,
                      refreshInterval: 1,
                      respectUserColors: true,
                      hideContextIndicator: true,
                    }
                  : {
                      type: 'preset',
                      items: ['model'],
                      useThemeColors: false,
                      hideContextIndicator: true,
                    },
            },
            memory: E2E_MEMORY_SETTINGS_DEFAULTS,
          });
          const beforeSettings = snapshot();
          await launch();
          if (kind === 'command') {
            const output = async (phase: string) => {
              await visible(`STATUS_COLOR_${phase}`, `color-${phase}`);
              await visible(`STATUS_SECOND_${phase}`, `second-${phase}`);
              const rows = await current().viewportCells();
              const first = rows.findIndex((row) =>
                row.text.includes(`STATUS_COLOR_${phase}`),
              );
              const second = rows.findIndex((row) =>
                row.text.includes(`STATUS_SECOND_${phase}`),
              );
              expect(first).toBeGreaterThanOrEqual(0);
              expect(second).toBe(first + 1);
              expect(
                rows.some((row) => row.text.includes('STATUS_MUST_CLIP')),
              ).toBe(false);
              const x = rows[first].text.indexOf(`STATUS_COLOR_${phase}`);
              const cells = rows[first].cells.slice(
                x,
                x + `STATUS_COLOR_${phase}`.length,
              );
              expect(cells.map((cell) => cell?.text).join('')).toBe(
                `STATUS_COLOR_${phase}`,
              );
              json(join(evidence, `cells-${phase}.json`), cells);
              for (const cell of cells)
                expect(cell).toMatchObject({
                  fg: 0xc52553,
                  rgb: true,
                  dim: false,
                });
            };
            await output('A');
            await until(() => records().length > 0, 'command receives stdin');
            const initial = records().at(-1)!.input;
            expect(realpathSync(initial.workspace.current_dir)).toBe(cwd);
            expect(initial.session_id).toBeTruthy();
            expect(initial.model.display_name).toContain('statusline-model');
            expect(initial.version).toBe(
              JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'))
                .version,
            );
            expect(initial.context_window.total_input_tokens).toBe(0);
            json(control, { phase: 'B' });
            await output('B');
            expect(server.requests).toHaveLength(0);
            await type('STATUSLINE_EXACT_REQUEST');
            await press('\r');
            await visible('STATUSLINE_REPLY', 'model-reply');
            await until(
              () =>
                records().some(
                  ({ input }) =>
                    input.context_window.total_input_tokens === 13 &&
                    input.context_window.total_output_tokens === 7,
                ),
              'real metrics reach status command',
            );
            await visible('in=13 out=7', 'updated-usage');
            expect(server.requests).toHaveLength(1);
            const users = (
              server.requests[0].body['messages'] as Array<{
                role: string;
                content: string | Array<{ type: string; text?: string }>;
              }>
            ).filter((message) => message.role === 'user');
            expect(users).toHaveLength(1);
            const parts =
              typeof users[0].content === 'string'
                ? [{ type: 'text', text: users[0].content }]
                : users[0].content;
            expect(
              parts.filter(
                (part) => !part.text?.startsWith('<system-reminder>'),
              ),
            ).toEqual([{ type: 'text', text: 'STATUSLINE_EXACT_REQUEST' }]);
            const updated = records().at(-1)!.input;
            expect(updated.session_id).toBe(initial.session_id);
            expect(updated.context_window.current_usage).toBe(13);
            expect(snapshot()).toEqual(beforeSettings);
          } else {
            await open();
            await selected('Use theme colors', false);
            await press(' ');
            await selected('Use theme colors', true);
            await type('total-input');
            await selected('total-input-tokens', false);
            await press(' ');
            await selected('total-input-tokens', true);
            await visible('Preview', 'preview');
            const preview = (await current().viewport())
              .split('Preview')
              .at(-1);
            expect(preview).toContain('statusline-model');
            expect(preview).toContain('0 total in');
            await press('\r');
            await visible(
              'Status line preset saved to user settings.',
              'saved',
            );
            expect(
              JSON.parse(readFileSync(settings, 'utf8')).ui.statusLine,
            ).toEqual({
              type: 'preset',
              useThemeColors: true,
              items: ['model', 'total-input-tokens'],
              hideContextIndicator: true,
            });
            const saved = snapshot();
            expect(saved.slice(1)).toEqual(beforeSettings.slice(1));
            await open();
            await type('total-input');
            await press(' ');
            await selected('total-input-tokens', false);
            await press('\x1b');
            await visible('Configure Status Line', 'escape-clears');
            await selected('Use theme colors', true);
            await press('\x1b');
            await until(
              async () =>
                !(await current().viewport()).includes('Configure Status Line'),
              'cancel closes dialog',
            );
            expect(snapshot()).toEqual(saved);
            await quit();
            await launch();
            await visible('0 total in', 'restart-persistence');
            await open();
            await selected('Use theme colors', true);
            await type('total-input');
            await selected('total-input-tokens', true);
            await press('\x1b');
            await press('\x1b');
            await until(
              async () =>
                !(await current().viewport()).includes('Configure Status Line'),
              'reopened dialog closes',
            );
            expect(snapshot()).toEqual(saved);
            expect(server.requests).toHaveLength(0);
          }
          await quit();
          await until(
            () => records().every((record) => !sameCommand(record, script)),
            'command child survives normal quit',
          );
        } catch (error) {
          failure = error;
        } finally {
          const cleanup = async (action: () => void | Promise<void>) => {
            try {
              await action();
            } catch (error) {
              cleanupErrors.push(String(error));
            }
          };
          await cleanup(async () => {
            if (session) {
              frames['final'] = await session.viewport();
              writeFileSync(join(evidence, 'final.ansi'), session.output());
            }
          });
          await cleanup(() => session?.close());
          await cleanup(() => {
            for (const record of records())
              if (sameCommand(record, script))
                process.kill(record.pid, 'SIGKILL');
          });
          await cleanup(() =>
            until(
              () => records().every((record) => !sameCommand(record, script)),
              'command cleanup',
            ),
          );
          await cleanup(() => server?.close());
          await cleanup(() => {
            json(join(evidence, 'command-inputs.json'), records());
            json(join(evidence, 'settings.json'), snapshot());
            json(join(evidence, 'frames.json'), frames);
            json(join(evidence, 'requests.json'), server?.requests ?? []);
            if (manifest)
              expect(artifactFiles(join(root, 'dist'))).toEqual(manifest);
          });
          await cleanup(() =>
            rmSync(scratch, { recursive: true, force: true }),
          );
          json(join(evidence, 'result.json'), {
            status: failure || cleanupErrors.length ? 'FAIL' : 'PASS',
            failure:
              failure instanceof Error ? failure.stack : String(failure ?? ''),
            cleanupErrors,
            exits,
            runtime,
            renderer,
            bundleManifestSha256: manifest && hash(JSON.stringify(manifest)),
            runtimeVersion: execFileSync(runtime, ['--version'], {
              encoding: 'utf8',
            }).trim(),
            source: execFileSync('git', ['rev-parse', 'HEAD'], {
              cwd: root,
              encoding: 'utf8',
            }).trim(),
            trackedDiffHash: hash(
              execFileSync('git', ['diff', 'HEAD'], { cwd: root }),
            ),
            lockHash: hash(readFileSync(join(root, 'pnpm-lock.yaml'))),
            fixtureHash: hash(readFileSync(fileURLToPath(import.meta.url))),
            helperHash: hash(readFileSync(script)),
            platform: process.platform,
            arch: process.arch,
          });
        }
        if (cleanupErrors.length)
          throw new Error([String(failure ?? ''), ...cleanupErrors].join('\n'));
        if (failure) throw failure;
      },
      120_000,
    );
  },
);
