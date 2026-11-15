/**
 * @license
 * Copyright 2026 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import path from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { it } from 'vitest';
import { InteractiveSession } from './interactive-session.js';
import { startFakeOpenAIServer } from '../fake-openai-server.js';
import { E2E_MEMORY_SETTINGS_DEFAULTS } from '../e2e-memory-defaults.js';
import {
  e2eRendererEnv,
  pickE2eRenderer,
  resolveE2eCliCommand,
} from '../renderer-matrix.js';

const root = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../..',
);
const renderer = pickE2eRenderer();
const phase = process.env['QWEN_STATS_PHASE'] ?? `${renderer}-candidate`;
const override = process.env['QWEN_STATS_COMMAND_JSON'];
const command = override
  ? (JSON.parse(override) as { bin: string; args: string[] })
  : {
      bin: resolveE2eCliCommand(renderer),
      args: [path.join(root, 'dist/cli.js')],
    };
assert(
  command && typeof command.bin === 'string' && Array.isArray(command.args),
);
assert(command.args.every((arg) => typeof arg === 'string'));
if (override) assert(path.isAbsolute(command.bin));
const outputRoot =
  process.env['QWEN_TUI_ACCEPTANCE_OUT'] ??
  path.join(tmpdir(), 'qwen-stats-history-acceptance');
assert(path.isAbsolute(outputRoot));

function tree(directory: string): Record<string, unknown> {
  const entries: Record<string, unknown> = {};
  const visit = (file: string) => {
    const st = fs.lstatSync(file);
    assert(!st.isSymbolicLink());
    const name = path.relative(directory, file) || '.';
    if (st.isDirectory()) {
      entries[name] = { type: 'dir', mode: st.mode & 0o7777 };
      for (const child of fs.readdirSync(file).sort())
        visit(path.join(file, child));
    } else {
      assert(st.isFile());
      entries[name] = {
        type: 'file',
        mode: st.mode & 0o7777,
        sha256: createHash('sha256')
          .update(fs.readFileSync(file))
          .digest('hex'),
      };
    }
  };
  visit(directory);
  return entries;
}

function statsPanel(frame: string): string | null {
  const lines = frame.split('\n');
  const matches: string[] = [];
  for (let top = 0; top < lines.length; top++) {
    const border = /([┌╭])─+([┐╮])/u.exec(lines[top]);
    if (!border || (border[1] === '┌' ? border[2] !== '┐' : border[2] !== '╮'))
      continue;
    const bottomLeft = border[1] === '┌' ? '└' : '╰';
    const bottomRight = border[1] === '┌' ? '┘' : '╯';
    const left = border.index;
    const right = left + border[0].length - 1;
    for (let bottom = top + 1; bottom < lines.length; bottom++) {
      const line = lines[bottom];
      if (line[left] !== bottomLeft || line[right] !== bottomRight) continue;
      const bodyRows = lines.slice(top + 1, bottom);
      if (!bodyRows.every((row) => row[left] === '│' && row[right] === '│'))
        break;
      const body = bodyRows.map((row) => row.slice(left + 1, right)).join('\n');
      if (/Session\s+Activity\s+Efficiency/u.test(body)) matches.push(body);
      break;
    }
  }
  return matches.length === 1 ? matches[0] : null;
}

it(
  'Group A: public historical stats ranges, months and efficiency',
  { timeout: 120000, retry: 0 },
  async () => {
    fs.mkdirSync(outputRoot, { recursive: true });
    const output = fs.realpathSync(
      fs.mkdtempSync(path.join(outputRoot, 'stats-A-')),
    );
    const home = path.join(output, 'home');
    const runtime = path.join(output, 'runtime');
    const tmp = path.join(output, 'tmp');
    const workspace = path.join(output, 'owned-stats-p0');
    const other = path.join(output, 'owned-stats-p1');
    for (const directory of [home, runtime, tmp, workspace, other])
      fs.mkdirSync(directory);
    fs.writeFileSync(
      path.join(workspace, 'sentinel.txt'),
      'OWNED_STATS_READ_ONLY\n',
    );
    fs.writeFileSync(
      path.join(other, 'sentinel.txt'),
      'OWNED_OTHER_READ_ONLY\n',
    );
    const save = (name: string, value: unknown) =>
      fs.writeFileSync(
        path.join(output, name),
        JSON.stringify(value, null, 2) + '\n',
      );
    const settings = path.join(home, 'settings.json');
    const system = path.join(output, 'system.json');
    const defaults = path.join(output, 'defaults.json');
    const trust = path.join(output, 'trustedFolders.json');
    fs.writeFileSync(
      settings,
      JSON.stringify(
        {
          $version: 4,
          memory: E2E_MEMORY_SETTINGS_DEFAULTS,
          security: { auth: { selectedType: 'openai' } },
        },
        null,
        2,
      ) + '\n',
    );
    for (const file of [system, defaults])
      fs.writeFileSync(file, JSON.stringify({ $version: 4 }) + '\n');
    fs.writeFileSync(
      trust,
      JSON.stringify({ [workspace]: 'TRUST_FOLDER' }) + '\n',
    );
    const anchor = Date.now();
    const day = new Date(anchor).toISOString().slice(0, 10);
    const records = [0, 2, 14, 60].map((days, index) => {
      const factor = 2 ** index;
      const timestamp = anchor - days * 86400000 - 1000;
      return {
        version: 1,
        sessionId: `owned-history-${index}`,
        timestamp,
        startTime: timestamp - factor * 60000,
        project: index % 2 ? other : workspace,
        durationMs: factor * 60000,
        totalLatencyMs: factor * (index + 1) * 1000,
        models: {
          [index % 2 ? 'owned-stats-b' : 'owned-stats-a']: {
            requests: factor,
            inputTokens: factor * 111,
            outputTokens: factor * 17,
            thoughtsTokens: 0,
            totalTokens: factor * 128,
            cachedTokens: index % 2 ? (factor * 111) / 2 : 0,
            totalLatencyMs: factor * (index + 1) * 1000,
          },
        },
        tools: {
          totalCalls: factor,
          totalSuccess: factor,
          totalFail: 0,
          byName: {
            [`owned-tool-${index}`]: {
              count: factor,
              success: factor,
              fail: 0,
              totalDurationMs: factor * 1000,
            },
          },
        },
        files: { linesAdded: factor * 2, linesRemoved: factor },
      };
    });
    assert.equal(
      new Date(records[0].timestamp).toISOString().slice(0, 10),
      day,
      'setup too close to local midnight; Today fixture is not qualified',
    );
    const usage = path.join(home, 'usage_record.jsonl');
    fs.writeFileSync(
      usage,
      records.map((row) => JSON.stringify(row)).join('\n') + '\n',
    );
    const months = [
      ...new Set(
        records.map((row) => {
          const date = new Date(row.timestamp);
          return `${date.getUTCFullYear()}-${String(date.getUTCMonth() + 1).padStart(2, '0')}`;
        }),
      ),
    ]
      .sort()
      .reverse();
    assert(months.length >= 2);
    const monthCaption = (value: string) => {
      const [year, month] = value.split('-').map(Number);
      return `${['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'][month - 1]} ${year}`;
    };
    save('GOLDEN.json', {
      anchor,
      localDate: day,
      timezone: {
        parentEnvironment: process.env['TZ'] ?? null,
        parentResolved: Intl.DateTimeFormat().resolvedOptions().timeZone,
        application: 'UTC',
      },
      records,
      months,
      totals: { all: 1920, month: 896, week: 384, today: 128 },
      visibleTokens: { all: '1.9k', month: '896', week: '384', today: '128' },
      efficiency: {
        topLatencyMs: 49000,
        requests: 15,
        modelALatencyMs: 13000,
        modelBLatencyMs: 36000,
        modelARequests: 5,
        modelBRequests: 10,
        cachePercent: '33.3%',
        visibleAverage: '3.3s',
        visibleModelA: '2.6s',
        visibleModelB: '3.6s',
      },
      scope:
        'Exact1920 is fixture golden, not public displayed precision; All time displays rounded1.9k.',
    });
    const fixed = [settings, system, defaults, trust, usage];
    const protectedMap = () => ({
      files: fixed.map((file) => ({
        file,
        bytes: fs.readFileSync(file, 'base64'),
        mode: fs.statSync(file).mode & 0o7777,
      })),
      workspace: tree(workspace),
      other: tree(other),
    });
    const before = protectedMap();
    const server = await startFakeOpenAIServer(() => ({
      content: 'UNEXPECTED_STATS_MODEL_CALL',
    }));
    let session: InteractiveSession | undefined;
    let failure: unknown;
    const frames: Record<string, string> = {};
    const inputs: string[] = [];
    const phases: Array<{ label: string; protected: unknown }> = [];
    const cleanupErrors: string[] = [];
    let naturalExit: unknown = null;
    const guard = () => {
      assert.equal(server.requests.length, 0);
      assert.equal(
        new Date().toISOString().slice(0, 10),
        day,
        'fixture crossed local date boundary; setup no longer qualified',
      );
      assert.deepEqual(protectedMap(), before);
    };
    const checkpoint = (label: string) => {
      guard();
      phases.push({ label, protected: protectedMap() });
    };
    const until = async (
      test: () => Promise<boolean> | boolean,
      label: string,
    ) => {
      const end = performance.now() + 12000;
      while (true) {
        assert(performance.now() < end, label);
        const passed = await test();
        assert(performance.now() < end, label);
        if (passed) return;
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
    };
    const press = async (value: string) => {
      await session!.idle(150, 500);
      inputs.push(value);
      session!.pressKey(value);
      await session!.idle(150, 500);
      guard();
    };
    const type = async (value: string) => {
      for (const point of value) await press(point);
    };
    const panel = async (
      label: string,
      predicate: (body: string) => boolean,
    ) => {
      await until(async () => {
        const frame = await session!.viewport();
        frames[label] = frame;
        guard();
        const body = statsPanel(frame);
        return body !== null && predicate(body);
      }, label);
      checkpoint(label);
    };
    const activity = (sessions: number, tokens: string) => (body: string) =>
      new RegExp(`Sessions\\s+${sessions}(?:\\s|$)`).test(body) &&
      new RegExp(`Tokens\\s+${tokens.replace('.', '\\.')}\\b`).test(body) &&
      body.includes('Token Trend') &&
      body.includes('Projects') &&
      ['All time', 'Last 30 days', 'Last 7 days', 'Today'].every((label) =>
        body.includes(label),
      );
    try {
      save('LAUNCH.json', {
        phase,
        command,
        budgets: { case: 120, condition: 12, retry: 0 },
      });
      session = await InteractiveSession.start({
        command: {
          bin: command.bin,
          args: [
            ...command.args,
            '--auth-type',
            'openai',
            '--openai-api-key',
            'fixture',
            '--openai-base-url',
            server.baseUrl,
            '--model',
            'qwen-vl-baseline',
            '--approval-mode',
            'default',
          ],
        },
        cwd: workspace,
        cols: 120,
        rows: 48,
        inheritEnv: false,
        env: {
          PATH: process.env['PATH'],
          HOME: home,
          USERPROFILE: home,
          QWEN_HOME: home,
          QWEN_RUNTIME_DIR: runtime,
          TMPDIR: tmp,
          TMP: tmp,
          TEMP: tmp,
          QWEN_CODE_SYSTEM_SETTINGS_PATH: system,
          QWEN_CODE_SYSTEM_DEFAULTS_PATH: defaults,
          QWEN_CODE_TRUSTED_FOLDERS_PATH: trust,
          QWEN_CODE_FORCE_FILE_STORAGE: 'true',
          QWEN_CODE_DISABLE_CRON: '1',
          QWEN_CODE_SKIP_UPDATE_CHECK_ONCE: 'true',
          QWEN_CODE_MODELS_DEV_REFRESH: 'off',
          QWEN_SANDBOX: 'false',
          TERM: 'xterm-256color',
          LANG: 'en_US.UTF-8',
          QWEN_CODE_LANG: 'en',
          TZ: 'UTC',
          NO_PROXY: 'localhost,127.0.0.1',
          no_proxy: 'localhost,127.0.0.1',
          ...e2eRendererEnv(renderer),
        },
        onStartupFailure: (raw) =>
          fs.writeFileSync(path.join(output, 'startup-failed.ansi'), raw),
      });
      await until(
        async () => (await session!.viewport()).includes('Type your message'),
        'ready composer',
      );
      checkpoint('ready');
      await type('/stats');
      await press('\r');
      await panel(
        'session-live-zero',
        (body) =>
          /Tool Calls:\s*0\b/u.test(body) && body.includes('Session ID:'),
      );
      await press('\t');
      await panel('all-time', activity(4, '1.9k'));
      assert(frames['all-time'].includes(monthCaption(months[0])));
      assert(/Duration\s+15m\b/u.test(frames['all-time']));
      assert(
        frames['all-time'].includes('owned-stats-p0') &&
          frames['all-time'].includes('owned-stats-p1'),
      );
      for (let index = 1; index < months.length; index++) {
        await press('h');
        await panel(
          `older-month-${index}`,
          (body) =>
            activity(4, '1.9k')(body) &&
            body.includes(monthCaption(months[index])),
        );
      }
      await press('h');
      await panel(
        'oldest-month-clamped',
        (body) =>
          activity(4, '1.9k')(body) &&
          body.includes(monthCaption(months.at(-1)!)),
      );
      for (let index = months.length - 2; index >= 0; index--) {
        await press('l');
        await panel(
          `newer-month-${index}`,
          (body) =>
            activity(4, '1.9k')(body) &&
            body.includes(monthCaption(months[index])),
        );
      }
      await press('l');
      await panel(
        'newest-month-clamped',
        (body) =>
          activity(4, '1.9k')(body) && body.includes(monthCaption(months[0])),
      );
      for (const [label, count, tokens] of [
        ['month', 3, '896'],
        ['week', 2, '384'],
        ['today', 1, '128'],
        ['all', 4, '1.9k'],
      ] as const) {
        await press('r');
        await panel(`range-${label}`, activity(count, tokens));
      }
      await press('\t');
      await panel(
        'efficiency',
        (body) =>
          body.includes('Cache Hit Rate') &&
          body.includes('33.3%') &&
          body.includes('Tool Success') &&
          body.includes('100.0%') &&
          body.includes('Avg Latency') &&
          body.includes('3.3s') &&
          body
            .split('\n')
            .some((row) =>
              /owned-stats-a\s+5\s+555\/85\s+0\s+0%\s+2\.6s/u.test(row),
            ) &&
          body
            .split('\n')
            .some((row) =>
              /owned-stats-b\s+10\s+1\.1k\/170\s+0\s+50%\s+3\.6s/u.test(row),
            ) &&
          [
            'owned-tool-0',
            'owned-tool-1',
            'owned-tool-2',
            'owned-tool-3',
          ].every((name) => body.includes(name)) &&
          /Code Impact\s+\+30\s*\/\s*-15/u.test(body),
      );
      await press('\x1b[Z');
      await panel('back-activity', activity(4, '1.9k'));
      await press('\x1b');
      await until(async () => {
        const frame = await session!.viewport();
        frames.closed = frame;
        return (
          statsPanel(frame) === null && frame.includes('Type your message')
        );
      }, 'closed composer');
      checkpoint('closed-no-write');
      await type('/quit');
      await press('\r');
      await until(() => session!.exitResult() !== undefined, 'natural quit');
      naturalExit = session.exitResult();
      assert.equal(session.exitResult()!.exitCode, 0);
      assert.equal(session.exitResult()!.signal ?? 0, 0);
      checkpoint('natural-no-write');
    } catch (error) {
      failure = error;
    } finally {
      if (session) {
        try {
          fs.writeFileSync(
            path.join(output, 'terminal.ansi'),
            session.output(),
          );
          frames.failureOrFinal = await session.viewport();
        } catch (error) {
          cleanupErrors.push('capture: ' + String(error));
        }
        try {
          await session.close();
        } catch (error) {
          cleanupErrors.push(String(error));
        }
      }
      try {
        guard();
      } catch (error) {
        cleanupErrors.push('guard: ' + String(error));
      }
      try {
        await server.close();
      } catch (error) {
        cleanupErrors.push('server: ' + String(error));
      }
      if (server.requests.length) cleanupErrors.push('late model HTTP');
      save('frames.json', frames);
      save('inputs.json', inputs);
      save('phases.json', phases);
      save('requests.json', server.requests);
      save('protected-before.json', before);
      try {
        save('protected-after.json', protectedMap());
      } catch (error) {
        cleanupErrors.push('final map: ' + String(error));
      }
      save('RESULT.json', {
        result: failure
          ? 'FAIL'
          : cleanupErrors.length
            ? 'EVIDENCE_ERROR'
            : 'PASS',
        firstError:
          failure instanceof Error
            ? failure.stack
            : failure
              ? String(failure)
              : null,
        phase,
        naturalExit,
        afterCleanup: session?.exitResult() ?? null,
        cleanupErrors,
        modelHTTP: server.requests.length,
        scope:
          'GroupA publicdisplayedroundedaggregates/ranges/months/efficiency/readonly/naturalexit only; exact1920 not proven by1.9k; no allStats/GUI/platform/finalmain claim.',
      });
    }
    if (failure) throw failure;
    assert.deepEqual(cleanupErrors, []);
  },
);
