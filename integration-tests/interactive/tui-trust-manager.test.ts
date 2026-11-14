/**
 * @license
 * Copyright 2026 Qwen Code
 * SPDX-License-Identifier: Apache-2.0
 */
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import { it } from 'vitest';
import { InteractiveSession } from './interactive-session.js';
import { startFakeOpenAIServer } from '../fake-openai-server.js';
import { E2E_MEMORY_SETTINGS_DEFAULTS } from '../e2e-memory-defaults.js';

import { pickE2eRenderer, resolveE2eCliCommand } from '../renderer-matrix.js';

const root = path.resolve(import.meta.dirname, '../..');
const renderer = pickE2eRenderer();
const override = process.env['QWEN_TRUST_COMMAND_JSON'];
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
if (override)
  assert(
    path.isAbsolute(command.bin),
    'explicit command override must use an absolute executable',
  );
const profile = override
  ? `explicit-${renderer}`
  : `${command.bin}-${renderer}`;
const outputRoot =
  process.env['QWEN_TUI_ACCEPTANCE_OUT'] ??
  path.join(root, '.qwen/e2e-tests/trust-manager');

type RuntimeRecord = {
  pid: number;
  session_id: string;
  work_dir: string;
  started_at: number;
  proc_start?: string | null;
  pid_ns?: number | null;
};
function filesUnder(root: string): string[] {
  return fs.readdirSync(root, { withFileTypes: true }).flatMap((entry) => {
    const file = path.join(root, entry.name);
    assert(
      !entry.isSymbolicLink(),
      'owned fixture contains unexpected symlink',
    );
    return entry.isDirectory() ? filesUnder(file) : [file];
  });
}
function tree(root: string, excludedFile?: string): Record<string, unknown> {
  const result: Record<string, unknown> = {};
  const visit = (file: string) => {
    if (file === excludedFile) return;
    const stat = fs.lstatSync(file);
    assert(!stat.isSymbolicLink());
    const relative = path.relative(root, file) || '.';
    if (stat.isDirectory()) {
      result[relative] = { type: 'dir', mode: stat.mode & 0o7777 };
      for (const name of fs.readdirSync(file).sort())
        visit(path.join(file, name));
    } else {
      assert(stat.isFile());
      const bytes = fs.readFileSync(file);
      result[relative] = {
        type: 'file',
        mode: stat.mode & 0o7777,
        bytes: bytes.length,
        sha256: createHash('sha256').update(bytes).digest('hex'),
        base64: bytes.toString('base64'),
      };
    }
  };
  visit(root);
  return result;
}
function processIdentity(pid: number) {
  if (process.platform === 'win32')
    return {
      pid,
      observed: false as const,
      reason:
        'POSIX ps identity unavailable; no Windows process classification claimed',
    };
  const raw = execFileSync(
    'ps',
    ['-p', String(pid), '-o', 'pid=,ppid=,lstart=,tty=,command='],
    {
      encoding: 'utf8',
      maxBuffer: 65536,
      env: { ...process.env, LC_ALL: 'C' },
    },
  );
  const words = raw.trim().split(/\s+/);
  assert.equal(Number(words[0]), pid);
  assert(words.length >= 9 && Number.isSafeInteger(Number(words[1])));
  return {
    pid,
    observed: true as const,
    ppid: Number(words[1]),
    birth: words.slice(2, 7).join(' '),
    tty: words[7],
    command: words.slice(8).join(' '),
    raw,
  };
}

it(
  `public trust parent, cancellation, two real r relaunches and cold persistence (${profile})`,
  { timeout: 120000, retry: 0 },
  async () => {
    fs.mkdirSync(outputRoot, { recursive: true });
    const output = fs.realpathSync(
      fs.mkdtempSync(path.join(outputRoot, 'trust-')),
    );
    const home = path.join(output, 'home');
    const runtime = path.join(output, 'runtime');
    const tmp = path.join(output, 'tmp');
    const parent = path.join(output, 'owned-parent');
    const workspace = path.join(parent, 'workspace');
    const sibling = path.join(parent, 'sibling');
    const sentinel = path.join(output, 'unrelated-sentinel');
    for (const dir of [
      home,
      runtime,
      tmp,
      parent,
      workspace,
      sibling,
      sentinel,
    ])
      fs.mkdirSync(dir);
    const trustDir = path.join(output, 'trust-data');
    fs.mkdirSync(trustDir);
    const trust = path.join(trustDir, 'trustedFolders.json');
    fs.writeFileSync(
      path.join(trustDir, 'unrelated-trust.txt'),
      'OWNED_TRUST_SENTINEL\n',
    );
    for (const dir of [workspace, sibling, sentinel])
      fs.writeFileSync(path.join(dir, 'owned.txt'), 'OWNED_READ_ONLY\n');
    const system = path.join(output, 'system.json');
    const defaults = path.join(output, 'defaults.json');
    const save = (name: string, value: unknown) =>
      fs.writeFileSync(
        path.join(output, name),
        JSON.stringify(value, null, 2) + '\n',
      );
    const initial = { [workspace]: 'TRUST_FOLDER', [sentinel]: 'DO_NOT_TRUST' };
    fs.writeFileSync(trust, JSON.stringify(initial, null, 2) + '\n');
    fs.writeFileSync(system, JSON.stringify({ $version: 4 }));
    fs.writeFileSync(defaults, JSON.stringify({ $version: 4 }));
    const settings = {
      $version: 4,
      memory: E2E_MEMORY_SETTINGS_DEFAULTS,
      security: {
        folderTrust: { enabled: true },
        auth: { selectedType: 'openai' },
      },
    };
    fs.writeFileSync(
      path.join(home, 'settings.json'),
      JSON.stringify(settings, null, 2) + '\n',
    );
    const protectedFiles = [
      system,
      defaults,
      path.join(home, 'settings.json'),
    ].map((file) => ({ file, raw: fs.readFileSync(file, 'base64') }));
    const firstTrustBytes = fs.readFileSync(trust);
    let expectedTrust = initial;
    const readOnly = () => ({
      parent: tree(parent),
      sentinel: tree(sentinel),
      otherTrust: tree(trustDir, trust),
      settings: protectedFiles.map((row) => ({
        file: row.file,
        raw: fs.readFileSync(row.file, 'base64'),
      })),
    });
    const readOnlyBefore = readOnly();
    const phases: Array<{ label: string; trust: unknown; readOnly: unknown }> =
      [];
    const restartEvents: Array<Record<string, unknown>> = [];
    const server = await startFakeOpenAIServer(() => ({
      content: 'UNEXPECTED_TRUST_MODEL_REQUEST',
    }));
    const frames: Record<string, string> = {};
    const inputs: Array<{ session: number; value: string }> = [];
    const exits: Array<{ beforeCleanup: unknown; afterCleanup: unknown }> = [];
    const cleanupErrors: string[] = [];
    let session: InteractiveSession | undefined;
    let number = 0;
    let failure: unknown;
    const zero = () =>
      assert.equal(
        server.requests.length,
        0,
        'trust management must not call model',
      );
    const guard = () => {
      zero();
      assert.deepEqual(readOnly(), readOnlyBefore);
      assert.deepEqual(
        JSON.parse(fs.readFileSync(trust, 'utf8')),
        expectedTrust,
      );
    };
    const phase = (label: string) => {
      guard();
      phases.push({
        label,
        trust: JSON.parse(fs.readFileSync(trust, 'utf8')),
        readOnly: readOnly(),
      });
    };
    const until = async (
      check: () => Promise<boolean> | boolean,
      label: string,
    ) => {
      const end = performance.now() + 12000;
      while (!(await check())) {
        assert(performance.now() < end, label);
        await new Promise((done) => setTimeout(done, 100));
      }
    };
    const screen = (label: string, texts: string[]) =>
      until(async () => {
        const frame = await session!.viewport();
        frames[label] = frame;
        zero();
        return texts.every((text) => frame.includes(text));
      }, label);
    const press = async (value: string) => {
      await session!.idle(150, 500);
      inputs.push({ session: number, value });
      session!.pressKey(value);
      await session!.idle(150, 500);
      zero();
    };
    const type = async (value: string) => {
      for (const point of value) await press(point);
    };
    const open = async (label: string, current: string) => {
      await type('/trust');
      await press('\r');
      await screen(label, [
        'Modify Trust Level',
        'Trust this folder',
        'Trust parent folder',
        "Don't trust",
        `Current Level: ${current}`,
      ]);
      phase(label);
    };
    const readTrust = () => JSON.parse(fs.readFileSync(trust, 'utf8'));
    const launch = async (cwd: string) => {
      number++;
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
        cwd,
        cols: 120,
        rows: 40,
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
          QWEN_CODE_TRUSTED_FOLDERS_PATH: trust,
          QWEN_CODE_SYSTEM_SETTINGS_PATH: system,
          QWEN_CODE_SYSTEM_DEFAULTS_PATH: defaults,
          QWEN_CODE_FORCE_FILE_STORAGE: 'true',
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
        onStartupFailure: (raw) =>
          fs.writeFileSync(path.join(output, `startup-${number}.ansi`), raw),
      });
      await screen(`ready-${number}`, ['Type your message']);
      phase(`ready-${number}`);
    };
    const quit = async () => {
      await type('/quit');
      await press('\r');
      await until(
        () => session!.exitResult() !== undefined,
        'public natural quit',
      );
      assert.equal(session!.exitResult()!.exitCode, 0);
      assert.equal(session!.exitResult()!.signal ?? 0, 0);
      const beforeCleanup = session!.exitResult();
      fs.writeFileSync(
        path.join(output, `terminal-${number}.ansi`),
        session!.output(),
      );
      await session!.close();
      exits.push({ beforeCleanup, afterCleanup: session!.exitResult() });
      session = undefined;
      guard();
    };
    const runtimeRecords = (): RuntimeRecord[] =>
      filesUnder(runtime)
        .filter((file) => file.endsWith('.runtime.json'))
        .map(
          (file) => JSON.parse(fs.readFileSync(file, 'utf8')) as RuntimeRecord,
        );
    const currentRecord = async (
      cwd: string,
      excluding = new Set<string>(),
    ) => {
      let selected: RuntimeRecord | undefined;
      await until(() => {
        const candidates = runtimeRecords().filter(
          (record) =>
            record.work_dir === cwd && !excluding.has(record.session_id),
        );
        const live = candidates.filter((record) => {
          try {
            process.kill(record.pid, 0);
            return true;
          } catch {
            return false;
          }
        });
        selected = live.sort((a, b) => b.started_at - a.started_at)[0];
        return !!selected;
      }, 'actual current runtime session record');
      assert(
        selected &&
          typeof selected.session_id === 'string' &&
          selected.session_id.length > 0,
      );
      return selected;
    };
    const realRestart = async (label: string, level: string) => {
      const beforeRecord = await currentRecord(workspace);
      const known = new Set(
        runtimeRecords().map((record) => record.session_id),
      );
      const beforeProcess = processIdentity(beforeRecord.pid);
      const beforeParent = beforeProcess.observed
        ? processIdentity(beforeProcess.ppid)
        : null;
      save(`${label}-before.json`, {
        beforeRecord,
        beforeProcess,
        beforeParent,
        allRecords: runtimeRecords(),
        trust: readTrust(),
      });
      assert.equal(
        session!.exitResult(),
        undefined,
        'PTY must still be live before r',
      );
      await press('r');
      expectedTrust = { ...initial, [workspace]: level };
      await until(
        () => isDeepStrictEqual(readTrust(), expectedTrust),
        'r persisted exact trust value',
      );
      const afterRecord = await currentRecord(workspace, known);
      assert.notEqual(afterRecord.session_id, beforeRecord.session_id);
      await screen(`${label}-fresh-composer`, ['Type your message']);
      assert.equal(
        session!.exitResult(),
        undefined,
        'r must relaunch within the existing PTY, not end the session',
      );
      const afterProcess = processIdentity(afterRecord.pid);
      const afterParent = afterProcess.observed
        ? processIdentity(afterProcess.ppid)
        : null;
      if (beforeProcess.observed && afterProcess.observed)
        assert.equal(
          afterProcess.tty,
          beforeProcess.tty,
          'relaunch must preserve the actual terminal',
        );
      let priorPidAlive = false;
      try {
        process.kill(beforeRecord.pid, 0);
        priorPidAlive = true;
      } catch {
        /* The old child may have been replaced. */
      }
      if (afterRecord.pid !== beforeRecord.pid)
        assert.equal(
          priorPidAlive,
          false,
          'replaced application child must not remain live',
        );
      const event = {
        label,
        key: 'r',
        beforeRecord,
        afterRecord,
        beforeProcess,
        afterProcess,
        beforeParent,
        afterParent,
        priorPidAlive,
        classification:
          afterRecord.pid === beforeRecord.pid
            ? 'SAME_PID_FRESH_SESSION_AND_UI; exec syscall not directly traced'
            : 'CHANGED_PID_FRESH_SESSION_AND_UI; inner exit42 not directly observed',
        innerExit42: 'UNKNOWN_NOT_EXPOSED_BY_PUBLIC_SUPERVISOR',
        rootToolSession: 'Not an application PID or child handle',
        trust: readTrust(),
      };
      restartEvents.push(event);
      save(`${label}-after.json`, event);
      phase(label);
    };
    try {
      save('LAUNCH.json', {
        profile,
        command,
        workspace,
        sibling,
        trust,
        budgets: { conditionSeconds: 12, testSeconds: 120, retry: 0 },
        scope:
          'Public trust parent/cancel/cold-sibling plus two genuine r relaunches and independent cold reconstruction; no private restart call.',
      });
      await launch(workspace);
      await open('initial-options', 'TRUST_FOLDER');
      await press('\x1b');
      await screen('cancel-composer', ['Type your message']);
      assert.deepEqual(fs.readFileSync(trust), firstTrustBytes);
      phase('initial-cancel-no-write');
      await open('parent-options', 'TRUST_FOLDER');
      await press('\x1b[B');
      await press('\r');
      await screen('parent-saved-composer', ['Type your message']);
      const expectedParent = { ...initial, [workspace]: 'TRUST_PARENT' };
      expectedTrust = expectedParent;
      assert.deepEqual(readTrust(), expectedParent);
      const parentBytes = fs.readFileSync(trust);
      save('parent-trust.json', readTrust());
      phase('parent-immediate-save');
      await open('pending-options', 'TRUST_PARENT');
      await press('\x1b[B');
      await press('\r');
      await screen('pending-restart', [
        'Qwen Code must be restarted',
        "'r' to restart CLI now",
      ]);
      assert.deepEqual(fs.readFileSync(trust), parentBytes);
      phase('pending-no-write');
      await press('\x1b');
      await screen('pending-cancel-composer', ['Type your message']);
      assert.deepEqual(fs.readFileSync(trust), parentBytes);
      await open('parent-still-current', 'TRUST_PARENT');
      await press('\x1b');
      await screen('before-first-quit', ['Type your message']);
      await quit();
      await launch(sibling);
      await open('cold-sibling-inherited', 'Not Set');
      await screen('cold-sibling-parent-note', [
        'inherits trust from a parent folder',
      ]);
      assert.deepEqual(fs.readFileSync(trust), parentBytes);
      await press('\x1b');
      await screen('sibling-composer', ['Type your message']);
      await quit();
      phase('cold-sibling-parent-no-write');
      await launch(workspace);
      await open('before-first-r', 'TRUST_PARENT');
      await press('\x1b[B');
      await press('\r');
      await screen('first-r-pending', [
        'Qwen Code must be restarted',
        "'r' to restart CLI now",
      ]);
      assert.deepEqual(fs.readFileSync(trust), parentBytes);
      phase('first-r-not-yet-committed');
      await realRestart('to-untrusted', 'DO_NOT_TRUST');
      await open('after-first-r-untrusted', 'DO_NOT_TRUST');
      await press('\x1b[A');
      await press('\x1b[A');
      await press('\r');
      await screen('second-r-pending', [
        'Qwen Code must be restarted',
        "'r' to restart CLI now",
      ]);
      phase('second-r-not-yet-committed');
      await realRestart('to-trusted', 'TRUST_FOLDER');
      await open('after-second-r-trusted', 'TRUST_FOLDER');
      await press('\x1b');
      await screen('after-r-final-composer', ['Type your message']);
      await quit();
      await launch(workspace);
      await open('independent-cold-trust-folder', 'TRUST_FOLDER');
      await press('\x1b');
      await screen('independent-cold-composer', ['Type your message']);
      await quit();
      assert.equal(restartEvents.length, 2);
      assert.equal(exits.length, 4);
      phase('final-cold-no-write');
      save('final-trust.json', readTrust());
    } catch (error) {
      failure = error;
    } finally {
      if (session) {
        const beforeCleanup = session.exitResult() ?? null;
        try {
          frames.failure = await session.viewport();
          fs.writeFileSync(
            path.join(output, `terminal-${number}.ansi`),
            session.output(),
          );
        } catch (error) {
          cleanupErrors.push('capture: ' + String(error));
        }
        try {
          await session.close();
        } catch (error) {
          cleanupErrors.push('close: ' + String(error));
        }
        exits.push({
          beforeCleanup,
          afterCleanup: session.exitResult() ?? null,
        });
      }
      try {
        fs.cpSync(runtime, path.join(output, 'raw-runtime'), {
          recursive: true,
        });
        guard();
      } catch (error) {
        cleanupErrors.push('capture/guard: ' + String(error));
      }
      try {
        await server.close();
        zero();
      } catch (error) {
        cleanupErrors.push('server/late model: ' + String(error));
      }
      save('frames.json', frames);
      save('inputs.json', inputs);
      save('exits.json', exits);
      save('requests.json', server.requests);
      save('phases.json', phases);
      save('restarts.json', restartEvents);
      try {
        save('runtime-records.json', runtimeRecords());
        fs.copyFileSync(trust, path.join(output, 'trustedFolders-after.json'));
      } catch (error) {
        cleanupErrors.push('final raw capture: ' + String(error));
      }
      save('RESULT.json', {
        result: failure
          ? 'FAIL'
          : cleanupErrors.length
            ? 'EVIDENCE_ERROR'
            : 'PASS',
        firstError:
          failure instanceof Error
            ? (failure.stack ?? failure.message)
            : failure
              ? String(failure)
              : null,
        cleanupErrors,
        profile,
        command,
        exits,
        modelHTTP: server.requests.length,
        scope:
          'Public trust control and actual r-induced fresh application sessions on one PTY; process observations classify PID continuity but never invent supervisor exit42 or syscall tracing; no installed/platform/final-migration claim.',
      });
    }
    if (failure) throw failure;
    assert.deepEqual(cleanupErrors, []);
  },
);
