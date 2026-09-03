/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { spawn, spawnSync } from 'node:child_process';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { HookRunner } from './hookRunner.js';
import { HookEventName, HooksConfigSource, HookType } from './types.js';
import type { HookInput } from './types.js';

// The tests here spawn real processes — `node --import=tsx/esm` where the
// fixture imports HookRunner's TypeScript source, plain node over `node:`
// builtins otherwise — and then wait on a wall-clock deadline. Process
// startup is not something a smarter wait can speed up, so on a shared
// runner these deadlines are a coin flip rather than a signal: size them for
// the busiest host, not the median one. The budgets below are sized for the
// tsx path, which pays seconds of loader startup the plain-node fixtures do
// not, so they are generous rather than tight for those.
// A genuine hang still fails, just later. The per-test timeouts below are
// widened to match; they stay numeric literals so the call shape, and the
// diff, stay unchanged.
const PROCESS_STARTUP_TIMEOUT_MS = 30_000;
const PROCESS_REAP_TIMEOUT_MS = 15_000;
const HOOK_GROUP_TIMEOUT_MS = 5000;

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
        }, PROCESS_STARTUP_TIMEOUT_MS);

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
    }, 90_000);

    it.each([
      ['synchronous', 'process-exit', false],
      ['synchronous', 'signal-exit', false],
      ['synchronous', 'handled-signal-exit', false],
      ['async', 'process-exit', true],
    ] as const)(
      'reaps an active %s hook tree on parent %s',
      async (_, exitMode, isAsync) => {
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
const [tempDir, fixturePath, rootPidPath, descendantPidPath, descendantFixturePath, descendantReadyPath, driverReadyPath, upperCompletedPath, exitMode, isAsync] = process.argv.slice(3);
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
  { type: 'command', command: \`exec \${JSON.stringify(process.execPath)} \${JSON.stringify(fixturePath)} \${JSON.stringify(rootPidPath)} \${JSON.stringify(descendantPidPath)} \${JSON.stringify(descendantFixturePath)} \${JSON.stringify(descendantReadyPath)}\`, source: 'project', shell: 'bash', timeout: 60_000, async: isAsync === 'true' },
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
              String(isAsync),
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
          }, PROCESS_STARTUP_TIMEOUT_MS);
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
            PROCESS_REAP_TIMEOUT_MS,
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
      90_000,
    );

    it.each([
      [
        'a MessageDisplay hook after explicit parent exit',
        HookEventName.MessageDisplay,
        false,
        'explicit',
      ],
      [
        'a StopFailure hook after explicit parent exit',
        HookEventName.StopFailure,
        false,
        'explicit',
      ],
      [
        'a SessionDelete hook after explicit parent exit',
        HookEventName.SessionDelete,
        false,
        'explicit',
      ],
      [
        'an async MessageDisplay hook after explicit parent exit',
        HookEventName.MessageDisplay,
        true,
        'explicit',
      ],
      [
        'a MessageDisplay hook after natural parent exit',
        HookEventName.MessageDisplay,
        false,
        'natural',
      ],
      [
        'a StopFailure hook after natural parent exit',
        HookEventName.StopFailure,
        false,
        'natural',
      ],
      [
        'a SessionDelete hook after natural parent exit',
        HookEventName.SessionDelete,
        false,
        'natural',
      ],
    ] as const)(
      'lets %s write output and finish',
      async (_, eventName, isAsync, exitMode) => {
        const tempDir = await mkdtemp(join(tmpdir(), 'qwen-hook-survive-'));
        const driverPath = join(tempDir, 'driver.mjs');
        const fixturePath = join(tempDir, 'hook.mjs');
        const readyPath = join(tempDir, 'hook.ready');
        const completedPath = join(tempDir, 'hook.completed');
        const pidPath = join(tempDir, 'hook.pid');
        const releasePath = join(tempDir, 'hook.release');
        let driverPid: number | undefined;
        let hookPid: number | undefined;

        try {
          await writeFile(
            driverPath,
            `import { readFileSync } from 'node:fs';

const { HookRunner } = await import(process.argv[2]);
const [tempDir, fixturePath, readyPath, completedPath, pidPath, releasePath, eventName, isAsync, exitMode] = process.argv.slice(3);
const runner = new HookRunner();
void runner.executeHook(
  { type: 'command', command: \`exec \${JSON.stringify(process.execPath)} \${JSON.stringify(fixturePath)} \${JSON.stringify(readyPath)} \${JSON.stringify(completedPath)} \${JSON.stringify(pidPath)} \${JSON.stringify(releasePath)}\`, source: 'project', shell: 'bash', timeout: 60_000, async: isAsync === 'true' },
  eventName,
  { session_id: 'parent-exit-survival-test', transcript_path: \`\${tempDir}/transcript.jsonl\`, cwd: tempDir, hook_event_name: eventName, timestamp: new Date().toISOString() },
);
while (true) {
  try {
    if (readFileSync(readyPath, 'utf8') === 'ready') break;
  } catch {}
  await new Promise((resolve) => setTimeout(resolve, 25));
}
if (exitMode === 'explicit') process.exit(0);
`,
          );
          await writeFile(
            fixturePath,
            `import { readFileSync, writeFileSync } from 'node:fs';

const write = (stream, text) =>
  new Promise((resolve, reject) =>
    stream.write(text, (error) => (error ? reject(error) : resolve())),
  );
writeFileSync(process.argv[4], String(process.pid));
writeFileSync(process.argv[2], 'ready');
while (true) {
  try {
    if (readFileSync(process.argv[5], 'utf8') === 'continue') break;
  } catch {}
  await new Promise((resolve) => setTimeout(resolve, 25));
}
await write(process.stdout, 'late stdout\\n');
await write(process.stderr, 'late stderr\\n');
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
              releasePath,
              eventName,
              String(isAsync),
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
            hookPid = await readPid(pidPath);
            return (
              hookPid !== undefined &&
              (await readFile(readyPath, 'utf8').catch(() => '')) === 'ready'
            );
          }, PROCESS_STARTUP_TIMEOUT_MS);
          const readyAt = Date.now();
          expect(await driverExit).toEqual({ code: 0, signal: null });
          expect(await readFile(completedPath, 'utf8').catch(() => '')).toBe(
            '',
          );
          if (exitMode === 'natural') {
            expect(Date.now() - readyAt).toBeLessThan(1000);
          }
          await writeFile(releasePath, 'continue');
          await waitFor(
            async () =>
              (await readFile(completedPath, 'utf8').catch(() => '')) ===
              'completed',
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
          if (hookPid && isRunning(hookPid)) {
            try {
              process.kill(-hookPid, 'SIGKILL');
            } catch {
              // Already gone.
            }
          }
          await rm(tempDir, { recursive: true, force: true });
        }
      },
      90_000,
    );

    it('enforces a surviving hook timeout after the parent exits', async () => {
      const tempDir = await mkdtemp(join(tmpdir(), 'qwen-hook-deadline-'));
      const driverPath = join(tempDir, 'driver.mjs');
      const fixturePath = join(tempDir, 'hook.mjs');
      const readyPath = join(tempDir, 'hook.ready');
      const pidPath = join(tempDir, 'hook.pid');
      let hookPid: number | undefined;

      try {
        await writeFile(
          driverPath,
          `import { readFileSync } from 'node:fs';

const { HookRunner } = await import(process.argv[2]);
const [tempDir, fixturePath, readyPath, pidPath] = process.argv.slice(3);
const runner = new HookRunner();
void runner.executeHook(
  { type: 'command', command: \`exec \${JSON.stringify(process.execPath)} \${JSON.stringify(fixturePath)} \${JSON.stringify(readyPath)} \${JSON.stringify(pidPath)}\`, source: 'project', shell: 'bash', timeout: ${HOOK_GROUP_TIMEOUT_MS} },
  'StopFailure',
  { session_id: 'surviving-timeout-test', transcript_path: \`\${tempDir}/transcript.jsonl\`, cwd: tempDir, hook_event_name: 'StopFailure', timestamp: new Date().toISOString() },
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

process.on('SIGTERM', () => {});
writeFileSync(process.argv[3], String(process.pid));
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
            readyPath,
            pidPath,
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
        expect(isRunning(hookPid as number)).toBe(true);
        await waitFor(
          () => !isRunning(hookPid as number),
          PROCESS_REAP_TIMEOUT_MS,
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
    }, 90_000);

    it('preserves a surviving hook exit code 124 before its deadline', async () => {
      const runner = new HookRunner();
      const result = await runner.executeHook(
        {
          type: HookType.Command,
          command: 'exit 124',
          source: HooksConfigSource.Project,
          shell: 'bash',
          timeout: 10_000,
        },
        HookEventName.SessionDelete,
        {
          session_id: 'surviving-exit-124-test',
          transcript_path: '/tmp/transcript.jsonl',
          cwd: tmpdir(),
          hook_event_name: HookEventName.SessionDelete,
          timestamp: new Date().toISOString(),
        },
      );

      expect(result).toMatchObject({ success: false, exitCode: 124 });
      expect(result.error).toBeUndefined();
    }, 90_000);

    it('preserves a prompt exit 124 when the parent event loop is delayed past the deadline', async () => {
      const tempDir = await mkdtemp(join(tmpdir(), 'qwen-hook-exit-124-'));
      const markerPath = join(tempDir, 'hook.done');

      try {
        const runner = new HookRunner();
        const resultPromise = runner.executeHook(
          {
            type: HookType.Command,
            command: `: > ${JSON.stringify(markerPath)}; sleep 0.05; exit 124`,
            source: HooksConfigSource.Project,
            shell: 'bash',
            timeout: 1000,
          },
          HookEventName.SessionDelete,
          {
            session_id: 'surviving-delayed-exit-124-test',
            transcript_path: join(tempDir, 'transcript.jsonl'),
            cwd: tempDir,
            hook_event_name: HookEventName.SessionDelete,
            timestamp: new Date().toISOString(),
          },
        );

        await waitFor(
          async () =>
            (await readFile(markerPath, 'utf8').catch(() => undefined)) !==
            undefined,
          5000,
        );
        const blockedUntil = Date.now() + 1300;
        while (Date.now() < blockedUntil) {
          // Delay delivery of the supervisor status and close events.
        }

        const result = await resultPromise;
        expect(result).toMatchObject({ success: false, exitCode: 124 });
        expect(result.error).toBeUndefined();
        expect(result.duration).toBeGreaterThan(1000);
      } finally {
        await rm(tempDir, { recursive: true, force: true });
      }
    }, 90_000);

    it('isolates the supervisor from hook NODE_OPTIONS', async () => {
      const tempDir = await mkdtemp(join(tmpdir(), 'qwen-hook-node-options-'));
      const preloadPath = join(tempDir, 'preload.cjs');
      const markerPath = join(tempDir, 'hook-node-options.txt');
      const nodeOptions = `--require=${preloadPath}`;

      try {
        await writeFile(preloadPath, 'process.exit(42);\n');
        const runner = new HookRunner();
        const result = await runner.executeHook(
          {
            type: HookType.Command,
            command: `printf '%s' "$NODE_OPTIONS" > ${JSON.stringify(markerPath)}`,
            source: HooksConfigSource.Project,
            shell: 'bash',
            timeout: 1000,
            env: { NODE_OPTIONS: nodeOptions },
          },
          HookEventName.StopFailure,
          {
            session_id: 'surviving-node-options-test',
            transcript_path: join(tempDir, 'transcript.jsonl'),
            cwd: tempDir,
            hook_event_name: HookEventName.StopFailure,
            timestamp: new Date().toISOString(),
          },
        );

        expect(result.success).toBe(true);
        expect(await readFile(markerPath, 'utf8')).toBe(nodeOptions);
      } finally {
        await rm(tempDir, { recursive: true, force: true });
      }
    }, 90_000);

    it('forwards abort through a surviving hook supervisor', async () => {
      const tempDir = await mkdtemp(join(tmpdir(), 'qwen-hook-abort-'));
      const fixturePath = join(tempDir, 'hook.mjs');
      const readyPath = join(tempDir, 'hook.ready');
      const pidPath = join(tempDir, 'hook.pid');
      const controller = new AbortController();
      let hookPid: number | undefined;

      try {
        await writeFile(
          fixturePath,
          `import { writeFileSync } from 'node:fs';

process.on('SIGTERM', () => {});
writeFileSync(process.argv[3], String(process.pid));
writeFileSync(process.argv[2], 'ready');
setInterval(() => {}, 1000);
`,
        );
        const runner = new HookRunner();
        const input: HookInput = {
          session_id: 'surviving-abort-test',
          transcript_path: join(tempDir, 'transcript.jsonl'),
          cwd: tempDir,
          hook_event_name: HookEventName.MessageDisplay,
          timestamp: new Date().toISOString(),
        };
        const resultPromise = runner.executeHook(
          {
            type: HookType.Command,
            command: `exec ${JSON.stringify(process.execPath)} ${JSON.stringify(fixturePath)} ${JSON.stringify(readyPath)} ${JSON.stringify(pidPath)}`,
            source: HooksConfigSource.Project,
            shell: 'bash',
            timeout: 60_000,
          },
          HookEventName.MessageDisplay,
          input,
          controller.signal,
        );

        await waitFor(async () => {
          hookPid = await readPid(pidPath);
          return (
            hookPid !== undefined &&
            (await readFile(readyPath, 'utf8').catch(() => '')) === 'ready'
          );
        }, PROCESS_STARTUP_TIMEOUT_MS);
        controller.abort();
        const result = await resultPromise;

        expect(result.error?.message).toBe(
          'Hook execution cancelled (aborted)',
        );
        await waitFor(
          () => !isRunning(hookPid as number),
          PROCESS_REAP_TIMEOUT_MS,
        );
      } finally {
        controller.abort();
        if (hookPid && isRunning(hookPid)) {
          try {
            process.kill(-hookPid, 'SIGKILL');
          } catch {
            // Already gone.
          }
        }
        await rm(tempDir, { recursive: true, force: true });
      }
    }, 90_000);

    it('reaps a surviving hook when its supervisor is stopped before abort', async () => {
      const tempDir = await mkdtemp(join(tmpdir(), 'qwen-hook-stopped-'));
      const fixturePath = join(tempDir, 'hook.mjs');
      const readyPath = join(tempDir, 'hook.ready');
      const hookPidPath = join(tempDir, 'hook.pid');
      const supervisorPidPath = join(tempDir, 'supervisor.pid');
      const controller = new AbortController();
      let hookPid: number | undefined;
      let supervisorPid: number | undefined;

      try {
        await writeFile(
          fixturePath,
          `import { writeFileSync } from 'node:fs';

process.on('SIGTERM', () => {});
writeFileSync(process.argv[2], String(process.pid));
writeFileSync(process.argv[3], String(process.ppid));
writeFileSync(process.argv[4], 'ready');
setInterval(() => {}, 1000);
`,
        );
        const runner = new HookRunner();
        const resultPromise = runner.executeHook(
          {
            type: HookType.Command,
            command: `exec ${JSON.stringify(process.execPath)} ${JSON.stringify(fixturePath)} ${JSON.stringify(hookPidPath)} ${JSON.stringify(supervisorPidPath)} ${JSON.stringify(readyPath)}`,
            source: HooksConfigSource.Project,
            shell: 'bash',
            timeout: 60_000,
          },
          HookEventName.MessageDisplay,
          {
            session_id: 'surviving-stopped-supervisor-test',
            transcript_path: join(tempDir, 'transcript.jsonl'),
            cwd: tempDir,
            hook_event_name: HookEventName.MessageDisplay,
            timestamp: new Date().toISOString(),
          },
          controller.signal,
        );

        await waitFor(async () => {
          hookPid = await readPid(hookPidPath);
          supervisorPid = await readPid(supervisorPidPath);
          return (
            hookPid !== undefined &&
            supervisorPid !== undefined &&
            (await readFile(readyPath, 'utf8').catch(() => '')) === 'ready'
          );
        }, PROCESS_STARTUP_TIMEOUT_MS);

        process.kill(supervisorPid as number, 'SIGSTOP');
        controller.abort();
        const result = await resultPromise;

        expect(result.error?.message).toBe(
          'Hook execution cancelled (aborted)',
        );
        expect(isRunning(supervisorPid as number)).toBe(false);
        expect(isRunning(hookPid as number)).toBe(false);
      } finally {
        controller.abort();
        if (supervisorPid && isRunning(supervisorPid)) {
          try {
            process.kill(-supervisorPid, 'SIGKILL');
          } catch {
            // Already gone.
          }
        }
        if (hookPid && isRunning(hookPid)) {
          try {
            process.kill(-hookPid, 'SIGKILL');
          } catch {
            // Already gone.
          }
        }
        await rm(tempDir, { recursive: true, force: true });
      }
    }, 90_000);

    it('keeps supervising a surviving hook group after its root exits', async () => {
      const tempDir = await mkdtemp(join(tmpdir(), 'qwen-hook-descendant-'));
      const rootPath = join(tempDir, 'root.mjs');
      const descendantPath = join(tempDir, 'descendant.mjs');
      const descendantPidPath = join(tempDir, 'descendant.pid');
      let descendantPid: number | undefined;

      try {
        await writeFile(
          rootPath,
          `import { spawn } from 'node:child_process';
import { readFileSync } from 'node:fs';

const descendant = spawn(process.execPath, [process.argv[2], process.argv[3]], { stdio: 'ignore' });
descendant.unref();
while (true) {
  try {
    if (readFileSync(process.argv[3], 'utf8')) break;
  } catch {}
  await new Promise((resolve) => setTimeout(resolve, 5));
}
`,
        );
        await writeFile(
          descendantPath,
          `import { writeFileSync } from 'node:fs';

writeFileSync(process.argv[2], String(process.pid));
setInterval(() => {}, 1000);
`,
        );
        const runner = new HookRunner();
        const input: HookInput = {
          session_id: 'surviving-descendant-test',
          transcript_path: join(tempDir, 'transcript.jsonl'),
          cwd: tempDir,
          hook_event_name: HookEventName.SessionDelete,
          timestamp: new Date().toISOString(),
        };
        const command = `exec ${JSON.stringify(process.execPath)} ${JSON.stringify(rootPath)} ${JSON.stringify(descendantPath)} ${JSON.stringify(descendantPidPath)}`;

        const result = await runner.executeHook(
          {
            type: HookType.Command,
            command,
            source: HooksConfigSource.Project,
            shell: 'bash',
            // The root exits as soon as the descendant has written its pid;
            // the supervisor then keeps the surviving descendant on the
            // clock until this deadline and kills the group. That kill is
            // what ends the test, so the deadline must outlast a node
            // process starting on a loaded host — at 300ms the descendant
            // could be killed before it ever wrote the pid, and no amount
            // of waiting for the file afterwards could recover it.
            timeout: HOOK_GROUP_TIMEOUT_MS,
          },
          HookEventName.SessionDelete,
          input,
        );

        await waitFor(async () => {
          descendantPid = await readPid(descendantPidPath);
          return descendantPid !== undefined;
        }, PROCESS_STARTUP_TIMEOUT_MS);
        expect(descendantPid).toBeDefined();
        expect(result).toMatchObject({
          success: false,
          error: { message: `Hook timed out after ${HOOK_GROUP_TIMEOUT_MS}ms` },
        });
        await waitFor(
          () => !isRunning(descendantPid as number),
          PROCESS_REAP_TIMEOUT_MS,
        );
      } finally {
        if (descendantPid && isRunning(descendantPid)) {
          try {
            process.kill(descendantPid, 'SIGKILL');
          } catch {
            // Already gone.
          }
        }
        await rm(tempDir, { recursive: true, force: true });
      }
    }, 90_000);

    it('delivers complete large input after the parent exits', async () => {
      const tempDir = await mkdtemp(join(tmpdir(), 'qwen-hook-input-'));
      const driverPath = join(tempDir, 'driver.mjs');
      const fixturePath = join(tempDir, 'hook.mjs');
      const resultPath = join(tempDir, 'input-result.json');
      const pidPath = join(tempDir, 'hook.pid');
      const displayedTextLength = 5 * 1024 * 1024;
      let hookPid: number | undefined;

      try {
        await writeFile(
          driverPath,
          `const { HookRunner } = await import(process.argv[2]);
const [tempDir, fixturePath, resultPath, pidPath, displayedTextLength] = process.argv.slice(3);
const runner = new HookRunner();
void runner.executeHook(
  { type: 'command', command: \`exec \${JSON.stringify(process.execPath)} \${JSON.stringify(fixturePath)} \${JSON.stringify(resultPath)} \${JSON.stringify(pidPath)}\`, source: 'project', shell: 'bash', timeout: 60_000 },
  'MessageDisplay',
  { session_id: 'large-input-test', transcript_path: \`\${tempDir}/transcript.jsonl\`, cwd: tempDir, hook_event_name: 'MessageDisplay', timestamp: '2026-01-01T00:00:00.000Z', message_id: 'message', displayed_text: 'x'.repeat(Number(displayedTextLength)), is_final: true },
);
process.exit(0);
`,
        );
        await writeFile(
          fixturePath,
          `import { fstatSync, readFileSync, writeFileSync } from 'node:fs';

writeFileSync(process.argv[3], String(process.pid));
const input = readFileSync(0, 'utf8');
let displayedLength;
try {
  displayedLength = JSON.parse(input).displayed_text.length;
} catch {}
writeFileSync(process.argv[2], JSON.stringify({ bytes: Buffer.byteLength(input), displayedLength, mode: fstatSync(0).mode & 0o777 }));
`,
        );

        const driverInput = {
          session_id: 'large-input-test',
          transcript_path: join(tempDir, 'transcript.jsonl'),
          cwd: tempDir,
          hook_event_name: HookEventName.MessageDisplay,
          timestamp: '2026-01-01T00:00:00.000Z',
          message_id: 'message',
          displayed_text: 'x'.repeat(displayedTextLength),
          is_final: true,
        };
        const driver = spawn(
          process.execPath,
          [
            '--import=tsx/esm',
            driverPath,
            new URL('./hookRunner.ts', import.meta.url).href,
            tempDir,
            fixturePath,
            resultPath,
            pidPath,
            String(displayedTextLength),
          ],
          {
            cwd: fileURLToPath(new URL('../../../../', import.meta.url)),
            env: { ...process.env, TMPDIR: tempDir },
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
        await waitFor(
          async () =>
            (await readFile(resultPath, 'utf8').catch(() => '')).length > 0,
          5000,
        );
        hookPid = await readPid(pidPath);
        const received = JSON.parse(await readFile(resultPath, 'utf8')) as {
          bytes: number;
          displayedLength?: number;
          mode: number;
        };
        expect(received).toEqual({
          bytes: Buffer.byteLength(JSON.stringify(driverInput)),
          displayedLength: displayedTextLength,
          mode: 0o600,
        });
        await waitFor(
          async () =>
            !(await readdir(tempDir)).some((name) =>
              name.startsWith('qwen-hook-input-'),
            ),
          1000,
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
    }, 90_000);
  },
);
