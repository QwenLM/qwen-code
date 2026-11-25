/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync, spawn } from 'node:child_process';
import { observe, sameProcess } from './process-observer.js';
import * as fs from 'node:fs';
import path from 'node:path';
import type { InteractiveSession } from '../interactive/interactive-session.js';

export const sha = (file: string) =>
  createHash('sha256').update(fs.readFileSync(file)).digest('hex');
export const save = (file: string, value: unknown) =>
  fs.writeFileSync(file, JSON.stringify(value, null, 2) + '\n');
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
export async function until(
  check: () => boolean | Promise<boolean>,
  budget = 15_000,
) {
  const deadline = Date.now() + budget;
  while (Date.now() < deadline) {
    if (await check()) return true;
    await sleep(100);
  }
  return false;
}
export type Entry = {
  symlink: string | false;
  sha256?: string;
  bytes?: number;
  mode?: string;
};
export function inventory(directory: string): Record<string, Entry> {
  const result: Record<string, Entry> = {};
  const walk = (folder: string) => {
    for (const name of fs.readdirSync(folder).sort()) {
      const file = path.join(folder, name);
      const stat = fs.lstatSync(file);
      const relative = path.relative(directory, file);
      if (stat.isSymbolicLink())
        result[relative] = { symlink: fs.readlinkSync(file) };
      else if (stat.isDirectory()) walk(file);
      else {
        assert.ok(stat.isFile());
        result[relative] = {
          symlink: false,
          sha256: sha(file),
          bytes: stat.size,
          mode: `0o${(stat.mode & 0o777).toString(8)}`,
        };
      }
    }
  };
  walk(directory);
  return result;
}
export function inventoryEntry(file: string): Entry {
  const stat = fs.lstatSync(file);
  return stat.isSymbolicLink()
    ? { symlink: fs.readlinkSync(file) }
    : {
        symlink: false,
        sha256: sha(file),
        bytes: stat.size,
        mode: `0o${(stat.mode & 0o777).toString(8)}`,
      };
}
export async function cells(session: InteractiveSession) {
  const rows = await session.viewportCells();
  const row = rows.find((entry) =>
    entry.text.includes('const R3_HIGHLIGHT_VALUE = 42;'),
  );
  if (!row) return undefined;
  const keyword = row.cells[row.text.indexOf('const')];
  const number = row.cells[row.text.indexOf('42;')];
  return {
    text: row.text,
    attrs: row.cells,
    highlighted: Boolean(
      keyword &&
        number &&
        keyword.fg >= 0 &&
        number.fg >= 0 &&
        keyword.fg !== number.fg,
    ),
  };
}

export function checkout(root: string) {
  return {
    head: execFileSync('git', ['rev-parse', 'HEAD'], {
      cwd: root,
      encoding: 'utf8',
      timeout: 10_000,
    }).trim(),
    diff: createHash('sha256')
      .update(
        execFileSync('git', ['diff', 'HEAD', '--binary'], {
          cwd: root,
          timeout: 10_000,
        }),
      )
      .digest('hex'),
  };
}

export async function ownedCommand(
  out: string,
  bin: string,
  args: string[],
  cwd: string,
  env: NodeJS.ProcessEnv,
  seconds = 600,
) {
  assert.equal(fs.existsSync(out), false, 'never overwrite a command attempt');
  fs.mkdirSync(out, { recursive: true });
  const pidFile = path.join(out, 'pid');
  const observer = observe(pidFile);
  let child: ReturnType<typeof spawn> | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let killer: ReturnType<typeof setTimeout> | undefined;
  let stdout = '';
  let stderr = '';
  let timedOut = false;
  let failure: unknown;
  const facts: Record<string, unknown> = { outcome: 'RUNNING', bin, args, cwd };
  try {
    child = spawn(bin, args, {
      cwd,
      env,
      detached: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    child.stdout!.on('data', (data: Buffer) => {
      stdout += data.toString();
    });
    child.stderr!.on('data', (data: Buffer) => {
      stderr += data.toString();
    });
    const done = new Promise<void>((resolve, reject) => {
      child!.once('error', reject);
      child!.once('close', (code, signal) => {
        facts.code = code;
        facts.signal = signal;
        resolve();
      });
    });
    void done.catch(() => {});
    assert.ok(child.pid);
    fs.writeFileSync(pidFile, String(child.pid));
    observer.poll();
    const kill = (signal: NodeJS.Signals) => {
      try {
        process.kill(-child!.pid!, signal);
      } catch {
        /* already exited */
      }
    };
    timer = setTimeout(() => {
      timedOut = true;
      kill('SIGTERM');
    }, seconds * 1000);
    killer = setTimeout(() => kill('SIGKILL'), seconds * 1000 + 5000);
    await done;
    assert.equal(timedOut, false);
    assert.equal(facts.code, 0, stderr);
    assert.equal(facts.signal, null);
    assert.ok(
      await until(
        () => observer.snapshot().every((row) => !sameProcess(row)),
        3000,
      ),
    );
  } catch (error) {
    failure = error;
  } finally {
    if (timer) clearTimeout(timer);
    if (killer) clearTimeout(killer);
    const errors: string[] = [];
    try {
      facts.observerError = observer.stop();
      facts.captured = observer.snapshot();
      if (!observer.snapshot().some((row) => row.pid === child?.pid))
        errors.push('owned command root was not observed');
      facts.liveBeforeCleanup = observer.snapshot().filter(sameProcess);
      if (facts.observerError) errors.push(String(facts.observerError));
      if ((facts.liveBeforeCleanup as unknown[]).length)
        errors.push('owned command survived before cleanup');
    } catch (error) {
      errors.push(String(error));
    }
    try {
      await observer.cleanup();
    } catch (error) {
      errors.push(String(error));
    }
    if (child?.pid && child.exitCode === null && child.signalCode === null) {
      try {
        process.kill(-child.pid, 'SIGKILL');
      } catch {
        /* already exited */
      }
      if (
        !(await until(
          () => child!.exitCode !== null || child!.signalCode !== null,
          5000,
        ))
      ) {
        errors.push('owned command did not exit after cleanup');
      }
    }
    facts.timedOut = timedOut;
    facts.cleanupErrors = errors;
    if (errors.length) failure ??= new Error(errors.join('\n'));
    facts.outcome = failure ? 'FAIL' : 'PASS';
    facts.error = failure ? String(failure) : undefined;
    fs.writeFileSync(path.join(out, 'stdout.log'), stdout);
    fs.writeFileSync(path.join(out, 'stderr.log'), stderr);
    save(path.join(out, 'result.json'), facts);
  }
  if (failure) throw failure;
  return stdout;
}
