/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { spawn, spawnSync } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
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

    it.each(['process-exit', 'signal-exit', 'handled-signal-exit'] as const)(
      'reaps an active hook tree on parent %s',
      async (exitMode) => {
        const tempDir = await mkdtemp(join(tmpdir(), 'qwen-hook-exit-'));
        const driverPath = join(tempDir, 'driver.mjs');
        const fixturePath = join(tempDir, 'hook-tree.mjs');
        const descendantFixturePath = join(tempDir, 'descendant.mjs');
        const rootPidPath = join(tempDir, 'root.pid');
        const descendantPidPath = join(tempDir, 'descendant.pid');
        const descendantReadyPath = join(tempDir, 'descendant.ready');
        const driverReadyPath = join(tempDir, 'driver.ready');
        const upperCompletedPath = join(tempDir, 'upper.completed');
        let driverPid: number | undefined;
        let rootPid: number | undefined;
        let descendantPid: number | undefined;

        try {
          await writeFile(
            driverPath,
            `import { readFileSync, writeFileSync } from 'node:fs';

const { HookRunner } = await import(process.argv[2]);
const [tempDir, fixturePath, rootPidPath, descendantPidPath, descendantFixturePath, descendantReadyPath, driverReadyPath, upperCompletedPath, exitMode] = process.argv.slice(3);
const runner = new HookRunner();
const controller = new AbortController();
if (exitMode === 'handled-signal-exit') {
  process.once('SIGTERM', async () => {
    await resultPromise;
    writeFileSync(upperCompletedPath, 'completed');
    process.exit(77);
  });
}
const resultPromise = runner.executeHook(
  { type: 'command', command: \`exec \${JSON.stringify(process.execPath)} \${JSON.stringify(fixturePath)} \${JSON.stringify(rootPidPath)} \${JSON.stringify(descendantPidPath)} \${JSON.stringify(descendantFixturePath)} \${JSON.stringify(descendantReadyPath)}\`, source: 'project', shell: 'bash', timeout: 60_000 },
  'PreToolUse',
  { session_id: 'parent-exit-test', transcript_path: \`\${tempDir}/transcript.jsonl\`, cwd: tempDir, hook_event_name: 'PreToolUse', timestamp: new Date().toISOString() },
  controller.signal,
);
while (true) {
  try {
    if (readFileSync(descendantReadyPath, 'utf8') === 'ready') break;
  } catch {}
  await new Promise((resolve) => setTimeout(resolve, 25));
}
writeFileSync(driverReadyPath, 'ready');
if (exitMode === 'process-exit') process.exit(0);
setInterval(() => {}, 1000);
`,
          );
          await writeFile(
            fixturePath,
            `import { spawn } from 'node:child_process';
import { writeFileSync } from 'node:fs';

writeFileSync(process.argv[2], String(process.pid));
const descendant = spawn(process.execPath, [process.argv[4], process.argv[5]], { stdio: 'ignore' });
writeFileSync(process.argv[3], String(descendant.pid));
setInterval(() => {}, 1000);
`,
          );
          await writeFile(
            descendantFixturePath,
            `import { writeFileSync } from 'node:fs';

process.on('SIGTERM', () => {});
process.on('SIGHUP', () => {});
writeFileSync(process.argv[2], 'ready');
setInterval(() => {}, 1000);
`,
          );

          const driver = spawn(
            process.execPath,
            [
              '--import=tsx/esm',
              driverPath,
              new URL('./hookRunner.ts', import.meta.url).href,
              tempDir,
              fixturePath,
              rootPidPath,
              descendantPidPath,
              descendantFixturePath,
              descendantReadyPath,
              driverReadyPath,
              upperCompletedPath,
              exitMode,
            ],
            {
              cwd: fileURLToPath(new URL('../../../../', import.meta.url)),
              stdio: 'ignore',
            },
          );
          driverPid = driver.pid;
          const driverExit = new Promise<{
            code: number | null;
            signal: NodeJS.Signals | null;
          }>((resolve, reject) => {
            driver.on('error', reject);
            driver.on('exit', (code, signal) => resolve({ code, signal }));
          });

          await waitFor(async () => {
            rootPid = await readPid(rootPidPath);
            descendantPid = await readPid(descendantPidPath);
            return (
              rootPid !== undefined &&
              descendantPid !== undefined &&
              (await readFile(driverReadyPath, 'utf8').catch(() => '')) ===
                'ready'
            );
          }, 5000);
          if (exitMode !== 'process-exit') {
            process.kill(driverPid as number, 'SIGTERM');
          }

          const exit = await driverExit;
          expect(exit).toEqual(
            exitMode === 'process-exit'
              ? { code: 0, signal: null }
              : exitMode === 'signal-exit'
                ? { code: null, signal: 'SIGTERM' }
                : { code: 77, signal: null },
          );
          if (exitMode === 'handled-signal-exit') {
            expect(await readFile(upperCompletedPath, 'utf8')).toBe(
              'completed',
            );
          }
          await waitFor(
            () =>
              !isRunning(rootPid as number) &&
              !isRunning(descendantPid as number),
            3000,
          );
        } finally {
          if (driverPid && isRunning(driverPid)) {
            try {
              process.kill(driverPid, 'SIGKILL');
            } catch {
              // Already gone.
            }
          }
          if (rootPid && isRunning(rootPid)) {
            try {
              process.kill(-rootPid, 'SIGKILL');
            } catch {
              // Already gone.
            }
          }
          if (descendantPid && isRunning(descendantPid)) {
            try {
              process.kill(descendantPid, 'SIGKILL');
            } catch {
              // Already gone.
            }
          }
          await rm(tempDir, { recursive: true, force: true });
        }
      },
      15_000,
    );

    it.each([
      ['a MessageDisplay hook', false],
      ['an async command hook', true],
    ] as const)('lets %s finish after parent exit', async (_, isAsync) => {
      const tempDir = await mkdtemp(join(tmpdir(), 'qwen-hook-survive-'));
      const driverPath = join(tempDir, 'driver.mjs');
      const fixturePath = join(tempDir, 'hook.mjs');
      const readyPath = join(tempDir, 'hook.ready');
      const completedPath = join(tempDir, 'hook.completed');
      const pidPath = join(tempDir, 'hook.pid');
      let hookPid: number | undefined;

      try {
        await writeFile(
          driverPath,
          `import { readFileSync } from 'node:fs';

const { HookRunner } = await import(process.argv[2]);
const [tempDir, fixturePath, readyPath, completedPath, pidPath, isAsync] = process.argv.slice(3);
const runner = new HookRunner();
void runner.executeHook(
  { type: 'command', command: \`exec \${JSON.stringify(process.execPath)} \${JSON.stringify(fixturePath)} \${JSON.stringify(readyPath)} \${JSON.stringify(completedPath)} \${JSON.stringify(pidPath)}\`, source: 'project', shell: 'bash', timeout: 60_000, async: isAsync === 'true' },
  isAsync === 'true' ? 'PreToolUse' : 'MessageDisplay',
  { session_id: 'parent-exit-survival-test', transcript_path: \`\${tempDir}/transcript.jsonl\`, cwd: tempDir, hook_event_name: isAsync === 'true' ? 'PreToolUse' : 'MessageDisplay', timestamp: new Date().toISOString() },
);
while (true) {
  try {
    if (readFileSync(readyPath, 'utf8') === 'ready') break;
  } catch {}
  await new Promise((resolve) => setTimeout(resolve, 25));
}
process.exit(0);
`,
        );
        await writeFile(
          fixturePath,
          `import { writeFileSync } from 'node:fs';

writeFileSync(process.argv[4], String(process.pid));
writeFileSync(process.argv[2], 'ready');
await new Promise((resolve) => setTimeout(resolve, 250));
writeFileSync(process.argv[3], 'completed');
`,
        );

        const driver = spawn(
          process.execPath,
          [
            '--import=tsx/esm',
            driverPath,
            new URL('./hookRunner.ts', import.meta.url).href,
            tempDir,
            fixturePath,
            readyPath,
            completedPath,
            pidPath,
            String(isAsync),
          ],
          {
            cwd: fileURLToPath(new URL('../../../../', import.meta.url)),
            stdio: 'ignore',
          },
        );
        const exit = await new Promise<{
          code: number | null;
          signal: NodeJS.Signals | null;
        }>((resolve, reject) => {
          driver.on('error', reject);
          driver.on('exit', (code, signal) => resolve({ code, signal }));
        });

        expect(exit).toEqual({ code: 0, signal: null });
        hookPid = await readPid(pidPath);
        expect(hookPid).toBeDefined();
        await waitFor(
          async () =>
            (await readFile(completedPath, 'utf8').catch(() => '')) ===
            'completed',
          3000,
        );
      } finally {
        if (hookPid && isRunning(hookPid)) {
          try {
            process.kill(-hookPid, 'SIGKILL');
          } catch {
            // Already gone.
          }
        }
        await rm(tempDir, { recursive: true, force: true });
      }
    });
  },
);
