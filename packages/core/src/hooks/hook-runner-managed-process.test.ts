/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import * as childProcess from 'node:child_process';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { HookRunner } from './hookRunner.js';
import {
  HookCommandCgroup,
  HookCommandIsolationUnavailableError,
} from './hook-command-cgroup.js';
import { HookEventName, HookType, type HookInput } from './types.js';

vi.mock('node:child_process', async (importOriginal) => {
  const original = await importOriginal<typeof import('node:child_process')>();
  return { ...original, spawn: vi.fn(original.spawn) };
});

const cgroupRoot = process.env['QWEN_MANAGED_HOOK_CGROUP_ROOT'];
const hasCgroup = process.platform === 'linux' && Boolean(cgroupRoot);
let cwd: string;
beforeEach(async () => {
  cwd = await mkdtemp(path.join(tmpdir(), 'managed-hook-process-'));
});
afterEach(async () => {
  vi.restoreAllMocks();
  await rm(cwd, { recursive: true, force: true });
});
function input(eventName = HookEventName.PreToolUse): HookInput {
  return {
    session_id: 'session',
    transcript_path: '',
    cwd,
    hook_event_name: eventName,
    timestamp: new Date().toISOString(),
  };
}
async function expectNotLive(pid: number) {
  try {
    const stat = await readFile(`/proc/${pid}/stat`, 'utf8');
    expect(stat.split(') ')[1]?.[0]).toBe('Z');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
}
describe('managed command admission', () => {
  it('does not drain a removed unit after a launcher spawn error has settled', async () => {
    const child = childProcess.spawn(process.execPath, ['--eval', ''], {
      cwd: path.join(cwd, 'missing'),
    });
    const closed = new Promise<void>((resolve) => child.once('close', resolve));
    vi.mocked(childProcess.spawn).mockReturnValueOnce(child);
    const waitForEmpty = vi.fn(async () => false);
    const terminate = vi.fn(async () => undefined);
    const remove = vi.fn();
    vi.spyOn(HookCommandCgroup, 'create').mockReturnValue({
      directory: cwd,
      launch: () => ({
        executable: process.execPath,
        args: [],
        env: { PATH: '', LANG: 'C.UTF-8', QWEN_HOOK_COMMAND_ENV: '{}' },
      }),
      empty: () => true,
      waitForEmpty,
      kill: vi.fn(),
      terminate,
      remove,
    });
    const result = await new HookRunner().executeHook(
      { type: HookType.Command, command: 'printf forbidden', timeout: 0.2 },
      HookEventName.PreToolUse,
      input(),
      undefined,
      { waitForProcessTree: true, cgroupRoot: cwd },
    );
    await closed;
    expect(result).toMatchObject({
      success: false,
      processTreeDrained: true,
      error: { code: 'ENOENT' },
    });
    expect(remove).toHaveBeenCalledOnce();
    expect(waitForEmpty).not.toHaveBeenCalled();
    expect(terminate).not.toHaveBeenCalled();
  });

  it.each([undefined, '/definitely-missing-qwen-cgroup'])(
    'rejects unavailable isolation before command execution (%s)',
    async (root) => {
      const result = await new HookRunner().executeHook(
        {
          type: HookType.Command,
          command: 'printf effect > forbidden-effect',
          timeout: 5000,
        },
        HookEventName.PreToolUse,
        input(),
        undefined,
        { waitForProcessTree: true, cgroupRoot: root },
      );
      expect(result).toMatchObject({
        success: false,
        processTreeDrained: true,
      });
      expect(result.error).toBeInstanceOf(HookCommandIsolationUnavailableError);
      await expect(
        readFile(path.join(cwd, 'forbidden-effect')),
      ).rejects.toThrow();
    },
  );
  it('rejects an ordinary directory instead of accepting fake cgroup evidence', async () => {
    const result = await new HookRunner().executeHook(
      { type: HookType.Command, command: 'printf effect > forbidden-effect' },
      HookEventName.PreToolUse,
      input(),
      undefined,
      { waitForProcessTree: true, cgroupRoot: cwd },
    );
    expect(result.error).toBeInstanceOf(HookCommandIsolationUnavailableError);
    await expect(
      readFile(path.join(cwd, 'forbidden-effect')),
    ).rejects.toThrow();
  });
});
describe.skipIf(!hasCgroup)('managed command process receipt', () => {
  it('waits for a detached descendant after the original process group exits', async () => {
    await writeFile(
      path.join(cwd, 'child.mjs'),
      `import { existsSync, writeFileSync } from 'node:fs';
const poll = setInterval(() => {
  if (!existsSync('release')) return;
  writeFileSync('escaped-effect', 'done');
  clearInterval(poll);
}, 10);
setTimeout(() => process.exit(), 5000).unref();`,
    );
    await writeFile(
      path.join(cwd, 'launch.mjs'),
      `import { spawn } from 'node:child_process';
import { writeFileSync } from 'node:fs';
const child = spawn(process.execPath, ['child.mjs'], {
  detached: true, stdio: 'ignore',
});
writeFileSync('escaped.pid', String(child.pid));
child.unref();`,
    );
    let pid = 0;
    try {
      let completed = false;
      const pending = new HookRunner()
        .executeHook(
          {
            type: HookType.Command,
            command: `"${process.execPath}" launch.mjs`,
            timeout: 5000,
          },
          HookEventName.PreToolUse,
          input(),
          undefined,
          { waitForProcessTree: true, cgroupRoot },
        )
        .then((result) => {
          completed = true;
          return result;
        });
      await vi.waitFor(async () => {
        pid = Number(await readFile(path.join(cwd, 'escaped.pid'), 'utf8'));
        expect(pid).toBeGreaterThan(1);
      });
      expect(() => process.kill(pid, 0)).not.toThrow();
      await new Promise((resolve) => setTimeout(resolve, 100));
      expect(completed).toBe(false);
      await writeFile(path.join(cwd, 'release'), '');
      await vi.waitFor(async () => {
        expect(await readFile(path.join(cwd, 'escaped-effect'), 'utf8')).toBe(
          'done',
        );
      });
      expect(await pending).toMatchObject({
        success: true,
        processTreeDrained: true,
      });
    } finally {
      if (pid) {
        try {
          process.kill(-pid, 'SIGKILL');
        } catch {
          // The detached descendant already exited.
        }
      }
    }
  });
  it('waits for descendants even when the root and output streams already closed', async () => {
    let completed = false;
    const pending = new HookRunner()
      .executeHook(
        {
          type: HookType.Command,
          command: '(sleep 0.2; printf done > finished) >/dev/null 2>&1 &',
          timeout: 5000,
        },
        HookEventName.PreToolUse,
        input(),
        undefined,
        { waitForProcessTree: true, cgroupRoot },
      )
      .then((result) => {
        completed = true;
        return result;
      });
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(completed).toBe(false);
    expect(await pending).toMatchObject({
      success: true,
      processTreeDrained: true,
    });
    expect(await readFile(path.join(cwd, 'finished'), 'utf8')).toBe('done');
  });
  it('waits beyond SIGKILL escalation before certifying cancellation', async () => {
    const controller = new AbortController();
    const pending = new HookRunner().executeHook(
      {
        type: HookType.Command,
        command:
          'trap "" TERM; printf "%s" $$ > pid; while :; do sleep 1; done',
        timeout: 10_000,
      },
      HookEventName.PreToolUse,
      input(),
      controller.signal,
      { waitForProcessTree: true, cgroupRoot },
    );
    let pid = 0;
    await vi.waitFor(async () => {
      pid = Number(await readFile(path.join(cwd, 'pid'), 'utf8'));
      expect(pid).toBeGreaterThan(1);
    });
    controller.abort();
    expect(await pending).toMatchObject({
      outcome: 'cancelled',
      processTreeDrained: true,
    });
    await expectNotLive(pid);
  });
  it('kills a detached descendant that ignores SIGTERM before cancellation settles', async () => {
    await writeFile(
      path.join(cwd, 'holder.mjs'),
      `import { writeFileSync, existsSync } from 'node:fs';
process.on('SIGTERM', () => {});
writeFileSync('detached-ready', String(process.pid));
setInterval(() => {
  if (existsSync('release')) writeFileSync('forbidden-effect', 'alive');
}, 10);`,
    );
    await writeFile(
      path.join(cwd, 'launch.mjs'),
      `import { spawn } from 'node:child_process';
spawn(process.execPath, ['holder.mjs'], {
  detached: true, stdio: 'ignore',
}).unref();`,
    );
    const controller = new AbortController();
    let pid = 0;
    try {
      const pending = new HookRunner().executeHook(
        {
          type: HookType.Command,
          command: `"${process.execPath}" launch.mjs`,
          timeout: 10_000,
        },
        HookEventName.PreToolUse,
        input(),
        controller.signal,
        { waitForProcessTree: true, cgroupRoot },
      );
      await vi.waitFor(async () => {
        pid = Number(await readFile(path.join(cwd, 'detached-ready'), 'utf8'));
        expect(pid).toBeGreaterThan(1);
      });
      controller.abort();
      expect(await pending).toMatchObject({
        outcome: 'cancelled',
        processTreeDrained: true,
      });
      await expectNotLive(pid);
      await writeFile(path.join(cwd, 'release'), '');
      await new Promise((resolve) => setTimeout(resolve, 100));
      await expect(
        readFile(path.join(cwd, 'forbidden-effect')),
      ).rejects.toThrow();
    } finally {
      controller.abort();
      if (pid) {
        try {
          process.kill(-pid, 'SIGKILL');
        } catch {
          // A failed assertion must not leave the test descendant alive.
        }
      }
    }
  });
  it('keeps display hooks owned and captures their final result', async () => {
    const result = await new HookRunner().executeHook(
      {
        type: HookType.Command,
        command: 'printf "{\\"continue\\":true}"',
        timeout: 5000,
      },
      HookEventName.MessageDisplay,
      input(HookEventName.MessageDisplay),
      undefined,
      { waitForProcessTree: true, cgroupRoot },
    );
    expect(result).toMatchObject({
      success: true,
      processTreeDrained: true,
      output: { continue: true },
    });
  });
});
