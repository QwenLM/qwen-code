/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { spawnSync } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { HookRunner } from './hookRunner.js';
import { HookEventName, HooksConfigSource, HookType } from './types.js';
import type { HookInput } from './types.js';

const waitFor = async (
  predicate: () => boolean | Promise<boolean>,
  timeoutMs: number,
): Promise<void> => {
  const deadline = Date.now() + timeoutMs;
  while (!(await predicate())) {
    if (Date.now() >= deadline) {
      throw new Error(`Condition not met within ${timeoutMs}ms`);
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
};

const readPid = async (path: string): Promise<number | undefined> => {
  try {
    const pid = Number.parseInt(await readFile(path, 'utf8'), 10);
    return Number.isSafeInteger(pid) && pid > 0 ? pid : undefined;
  } catch {
    return undefined;
  }
};

const isRunning = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ESRCH') {
      return false;
    }
    return true;
  }

  const ps = process.platform === 'linux' ? '/usr/bin/ps' : '/bin/ps';
  let result: ReturnType<typeof spawnSync>;
  try {
    result = spawnSync(ps, ['-o', 'stat=', '-p', pid.toString()], {
      encoding: 'utf8',
    });
  } catch {
    return true;
  }
  if (result.error || typeof result.stdout !== 'string') {
    return true;
  }
  if (result.status === 1) {
    return false;
  }
  if (result.status !== 0) {
    return true;
  }
  return !result.stdout.trim().startsWith('Z');
};

describe.skipIf(process.platform === 'win32')(
  'HookRunner process tree cancellation',
  () => {
    it('reaps a descendant that ignores SIGTERM before returning', async () => {
      const tempDir = await mkdtemp(join(tmpdir(), 'qwen-hook-tree-'));
      const fixturePath = join(tempDir, 'hook-tree.mjs');
      const descendantFixturePath = join(tempDir, 'descendant.mjs');
      const rootPidPath = join(tempDir, 'root.pid');
      const descendantPidPath = join(tempDir, 'descendant.pid');
      const descendantReadyPath = join(tempDir, 'descendant.ready');
      const descendantTermPath = join(tempDir, 'descendant.term');
      const controller = new AbortController();
      let rootPid: number | undefined;
      let descendantPid: number | undefined;

      try {
        await writeFile(
          fixturePath,
          `import { spawn } from 'node:child_process';
import { writeFileSync } from 'node:fs';

writeFileSync(process.argv[2], String(process.pid));
const descendant = spawn(process.execPath, [process.argv[4], process.argv[5], process.argv[6]], { stdio: 'ignore' });
writeFileSync(process.argv[3], String(descendant.pid));
setInterval(() => {}, 1000);
`,
        );
        await writeFile(
          descendantFixturePath,
          `import { writeFileSync } from 'node:fs';

process.on('SIGTERM', () => writeFileSync(process.argv[3], 'received'));
writeFileSync(process.argv[2], 'ready');
setInterval(() => {}, 1000);
`,
        );

        const runner = new HookRunner();
        const input: HookInput = {
          session_id: 'process-tree-test',
          transcript_path: join(tempDir, 'transcript.jsonl'),
          cwd: tempDir,
          hook_event_name: HookEventName.PreToolUse,
          timestamp: new Date().toISOString(),
        };
        const command = `exec ${JSON.stringify(process.execPath)} ${JSON.stringify(fixturePath)} ${JSON.stringify(rootPidPath)} ${JSON.stringify(descendantPidPath)} ${JSON.stringify(descendantFixturePath)} ${JSON.stringify(descendantReadyPath)} ${JSON.stringify(descendantTermPath)}`;

        const resultPromise = runner.executeHook(
          {
            type: HookType.Command,
            command,
            source: HooksConfigSource.Project,
            shell: 'bash',
            timeout: 10_000,
          },
          HookEventName.PreToolUse,
          input,
          controller.signal,
        );

        await waitFor(async () => {
          rootPid = await readPid(rootPidPath);
          descendantPid = await readPid(descendantPidPath);
          return (
            rootPid !== undefined &&
            descendantPid !== undefined &&
            (await readFile(descendantReadyPath, 'utf8').catch(() => '')) ===
              'ready'
          );
        }, 5000);

        controller.abort();
        const result = await resultPromise;

        expect(result.error?.message).toBe(
          'Hook execution cancelled (aborted)',
        );
        expect(await readFile(descendantTermPath, 'utf8')).toBe('received');
        await waitFor(
          () =>
            !isRunning(rootPid as number) &&
            !isRunning(descendantPid as number),
          3000,
        );
      } finally {
        controller.abort();
        const rootStillRunning = rootPid ? isRunning(rootPid) : false;
        const descendantStillRunning = descendantPid
          ? isRunning(descendantPid)
          : false;
        if (rootPid && (rootStillRunning || descendantStillRunning)) {
          try {
            process.kill(-rootPid, 'SIGKILL');
          } catch {
            // Already gone.
          }
        }
        if (descendantPid && descendantStillRunning) {
          try {
            process.kill(descendantPid, 'SIGKILL');
          } catch {
            // Already gone.
          }
        }
        await rm(tempDir, { recursive: true, force: true });
      }
    }, 15_000);
  },
);
