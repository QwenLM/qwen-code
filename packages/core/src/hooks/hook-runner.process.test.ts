/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { spawn, spawnSync } from 'node:child_process';
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, onTestFinished } from 'vitest';
import { HookRunner } from './hookRunner.js';
import { HookEventName, HooksConfigSource, HookType } from './types.js';
import type { HookInput } from './types.js';

// These tests spawn real processes (`node --import=tsx/esm` where the driver
// imports HookRunner's TypeScript source, plain node over `node:` builtins
// otherwise) and wait on wall-clock deadlines. No smarter wait speeds up
// process startup, so on a shared runner these deadlines are a coin flip
// rather than a signal: size them for the busiest host, not the median. The
// budgets cover the tsx path's seconds of loader startup, so they are
// generous for the plain-node fixtures. A genuine hang still fails, just
// later. Per-test timeouts are widened to match and stay numeric literals so
// the call shape, and the diff, stay unchanged.
const PROCESS_STARTUP_TIMEOUT_MS = 30_000;
const PROCESS_REAP_TIMEOUT_MS = 15_000;
const HOOK_GROUP_TIMEOUT_MS = 5000;
const CANCELLED = 'Hook execution cancelled (aborted)';
const { MessageDisplay, PreToolUse, SessionDelete, StopFailure } =
  HookEventName;

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

/** File contents, or '' while the file does not exist yet. */
const readText = (path: string) => readFile(path, 'utf8').catch(() => '');
const hasText = async (path: string, text = 'ready') =>
  (await readText(path)) === text;

const waitForExit = (timeoutMs: number, ...pids: Array<number | undefined>) =>
  waitFor(() => pids.every((pid) => !isRunning(pid as number)), timeoutMs);

type Pids = Partial<
  Record<'driver' | 'root' | 'descendant' | 'hook' | 'supervisor', number>
>;

// Polls each pid file into `pids` (so cleanup sees them even on a timeout)
// until every pid is set and, when given, `readyPath` reads 'ready'.
const waitForStart = (
  pids: Pids,
  files: Partial<Record<keyof Pids, string>>,
  readyPath?: string,
) =>
  waitFor(async () => {
    const keys = Object.keys(files) as Array<keyof Pids>;
    for (const key of keys) pids[key] = await readPid(files[key] as string);
    return (
      keys.every((key) => pids[key] !== undefined) &&
      (!readyPath || (await hasText(readyPath)))
    );
  }, PROCESS_STARTUP_TIMEOUT_MS);

/** A fresh temp dir, removed after the test's later-registered cleanups. */
const tempDirFor = async (prefix: string) => {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  onTestFinished(() => rm(dir, { recursive: true, force: true }));
  return dir;
};

/** SIGKILLs a pid (or, negated, a process group) that may be gone. */
const sigkill = (target: number) => {
  try {
    process.kill(target, 'SIGKILL');
  } catch {
    // Already gone.
  }
};

/** Cleanup: SIGKILLs `pid` (its group when `group`) if still running. */
const reapLeftover = (pid: number | undefined, group = false) => {
  if (pid && isRunning(pid)) sigkill(group ? -pid : pid);
};

const inputFor = (
  hook_event_name: HookEventName,
  session_id: string,
  cwd: string,
) => ({
  session_id,
  transcript_path: join(cwd, 'transcript.jsonl'),
  cwd,
  hook_event_name,
  timestamp: new Date().toISOString(),
});

/** Runs a project bash command hook in-process for `input`'s event. */
const runBash = (
  hook: { command: string; timeout: number; env?: Record<string, string> },
  input: HookInput & { hook_event_name: HookEventName },
  signal?: AbortSignal,
) =>
  new HookRunner().executeHook(
    {
      type: HookType.Command,
      source: HooksConfigSource.Project,
      shell: 'bash',
      ...hook,
    },
    input.hook_event_name,
    input,
    signal,
  );

/** `exec node <args>` with every word JSON-quoted. */
const nodeCmd = (...args: string[]) =>
  `exec ${[process.execPath, ...args].map((arg) => JSON.stringify(arg)).join(' ')}`;

/** Driver source binding each value to a same-named const. */
const consts = (values: Record<string, string>) =>
  `const { ${Object.keys(values).join(', ')} } = ${JSON.stringify(values)};`;

/** Driver/fixture source polling every 25ms until `condition` holds. */
const pollUntil = (condition: string) =>
  `while (true) {\n  try {\n    if (${condition}) break;\n  } catch {}\n  await new Promise((resolve) => setTimeout(resolve, 25));\n}`;

/** Writes and runs a driver under tsx; argv[2] is HookRunner's source URL. */
const startDriver = async (
  dir: string,
  source: string,
  env?: NodeJS.ProcessEnv,
) => {
  const driverPath = join(dir, 'driver.mjs');
  await writeFile(driverPath, source);
  const driver = spawn(
    process.execPath,
    [
      '--import=tsx/esm',
      driverPath,
      new URL('./hookRunner.ts', import.meta.url).href,
    ],
    {
      cwd: fileURLToPath(new URL('../../../../', import.meta.url)),
      env,
      stdio: 'ignore',
    },
  );
  const exit = new Promise<{
    code: number | null;
    signal: NodeJS.Signals | null;
  }>((resolve, reject) => {
    driver.on('error', reject);
    driver.on('exit', (code, signal) => resolve({ code, signal }));
  });
  return { pid: driver.pid, exit };
};

// Hook fixture: writes its pid to argv[2], runs node on the argv from [4] on
// (the descendant script first) and writes the descendant's pid to argv[3].
const HOOK_TREE = `import { spawn } from 'node:child_process';
import { writeFileSync } from 'node:fs';

writeFileSync(process.argv[2], String(process.pid));
const descendant = spawn(process.execPath, process.argv.slice(4), { stdio: 'ignore' });
writeFileSync(process.argv[3], String(descendant.pid));
setInterval(() => {}, 1000);
`;

// Hook fixture: ignores SIGTERM, writes its pid to argv[3], then 'ready'.
const SIGTERM_IGNORING_HOOK = `import { writeFileSync } from 'node:fs';

process.on('SIGTERM', () => {});
writeFileSync(process.argv[3], String(process.pid));
writeFileSync(process.argv[2], 'ready');
setInterval(() => {}, 1000);
`;

describe.skipIf(process.platform === 'win32')(
  'HookRunner project directory variables',
  () => {
    it.each(['CLAUDE_PROJECT_DIR', 'QWEN_PROJECT_DIR'])(
      'runs a double-quoted "$%s/..." script in a project path with a space',
      async (variable) => {
        const projectDir = await tempDirFor('qwen hook project-');
        const hooksDir = join(projectDir, '.qwen', 'hooks');
        await mkdir(hooksDir, { recursive: true });
        const scriptPath = join(hooksDir, 'check.sh');
        await writeFile(scriptPath, '#!/bin/sh\necho project-dir-hook-ran\n');
        await chmod(scriptPath, 0o755);

        const result = await new HookRunner().executeHook(
          {
            type: HookType.Command,
            command: `"$${variable}/.qwen/hooks/check.sh"`,
            source: HooksConfigSource.Project,
          },
          PreToolUse,
          inputFor(PreToolUse, 'project-dir-test', projectDir),
        );

        expect(result.stderr).toBe('');
        expect(result.success).toBe(true);
        expect(result.stdout).toContain('project-dir-hook-ran');
      },
      30_000,
    );
  },
);

describe.skipIf(process.platform === 'win32')(
  'HookRunner process tree cancellation',
  () => {
    it('reads a small command hook timeout as seconds for a real process', async () => {
      const tempDir = await tempDirFor('qwen-hook-seconds-');
      const startedAt = Date.now();
      const result = await runBash(
        {
          command: `exec ${JSON.stringify(process.execPath)} -e "setInterval(() => {}, 1000)"`,
          timeout: 1,
        },
        inputFor(PreToolUse, 'seconds-timeout-test', tempDir),
      );
      const elapsedMs = Date.now() - startedAt;

      expect(result).toMatchObject({
        success: false,
        outcome: 'timeout',
        error: { message: 'Hook timed out after 1s' },
      });
      // One second, not one millisecond and not a thousand seconds.
      expect(elapsedMs).toBeGreaterThanOrEqual(900);
      expect(elapsedMs).toBeLessThan(PROCESS_REAP_TIMEOUT_MS);
    }, 30_000);

    it('reaps a descendant that ignores SIGTERM before returning', async () => {
      const tempDir = await tempDirFor('qwen-hook-tree-');
      const fixturePath = join(tempDir, 'hook-tree.mjs');
      const descendantFixturePath = join(tempDir, 'descendant.mjs');
      const rootPidPath = join(tempDir, 'root.pid');
      const descendantPidPath = join(tempDir, 'descendant.pid');
      const descendantReadyPath = join(tempDir, 'descendant.ready');
      const descendantTermPath = join(tempDir, 'descendant.term');
      const controller = new AbortController();
      const pids: Pids = {};
      onTestFinished(() => {
        controller.abort();
        const { root, descendant } = pids;
        const descendantAlive = descendant ? isRunning(descendant) : false;
        if (root && (isRunning(root) || descendantAlive)) sigkill(-root);
        if (descendant && descendantAlive) sigkill(descendant);
      });

      await writeFile(fixturePath, HOOK_TREE);
      await writeFile(
        descendantFixturePath,
        `import { writeFileSync } from 'node:fs';

process.on('SIGTERM', () => writeFileSync(process.argv[3], 'received'));
writeFileSync(process.argv[2], 'ready');
setInterval(() => {}, 1000);
`,
      );

      const resultPromise = runBash(
        {
          command: nodeCmd(
            fixturePath,
            rootPidPath,
            descendantPidPath,
            descendantFixturePath,
            descendantReadyPath,
            descendantTermPath,
          ),
          timeout: 10_000,
        },
        inputFor(PreToolUse, 'process-tree-test', tempDir),
        controller.signal,
      );

      await waitForStart(
        pids,
        { root: rootPidPath, descendant: descendantPidPath },
        descendantReadyPath,
      );
      controller.abort();

      expect((await resultPromise).error?.message).toBe(CANCELLED);
      expect(await readFile(descendantTermPath, 'utf8')).toBe('received');
      await waitForExit(3000, pids.root, pids.descendant);
    }, 90_000);

    it.each([
      ['synchronous', 'process-exit', false],
      ['synchronous', 'signal-exit', false],
      ['synchronous', 'handled-signal-exit', false],
      ['async', 'process-exit', true],
    ] as const)(
      'reaps an active %s hook tree on parent %s',
      async (_, exitMode, isAsync) => {
        const tempDir = await tempDirFor('qwen-hook-exit-');
        const fixturePath = join(tempDir, 'hook-tree.mjs');
        const descendantFixturePath = join(tempDir, 'descendant.mjs');
        const rootPidPath = join(tempDir, 'root.pid');
        const descendantPidPath = join(tempDir, 'descendant.pid');
        const descendantReadyPath = join(tempDir, 'descendant.ready');
        const driverReadyPath = join(tempDir, 'driver.ready');
        const upperCompletedPath = join(tempDir, 'upper.completed');
        const pids: Pids = {};
        onTestFinished(() => {
          reapLeftover(pids.driver);
          reapLeftover(pids.root, true);
          reapLeftover(pids.descendant);
        });

        await writeFile(fixturePath, HOOK_TREE);
        await writeFile(
          descendantFixturePath,
          `import { writeFileSync } from 'node:fs';

process.on('SIGTERM', () => {});
process.on('SIGHUP', () => {});
writeFileSync(process.argv[2], 'ready');
setInterval(() => {}, 1000);
`,
        );
        const driver = await startDriver(
          tempDir,
          `import { readFileSync, writeFileSync } from 'node:fs';

const { HookRunner } = await import(process.argv[2]);
${consts({ tempDir, fixturePath, rootPidPath, descendantPidPath, descendantFixturePath, descendantReadyPath, driverReadyPath, upperCompletedPath, exitMode, isAsync: String(isAsync) })}
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
${pollUntil("readFileSync(descendantReadyPath, 'utf8') === 'ready'")}
writeFileSync(driverReadyPath, 'ready');
if (exitMode === 'process-exit') process.exit(0);
setInterval(() => {}, 1000);
`,
        );
        pids.driver = driver.pid;

        await waitForStart(
          pids,
          { root: rootPidPath, descendant: descendantPidPath },
          driverReadyPath,
        );
        if (exitMode !== 'process-exit') {
          process.kill(pids.driver as number, 'SIGTERM');
        }

        expect(await driver.exit).toEqual(
          exitMode === 'process-exit'
            ? { code: 0, signal: null }
            : exitMode === 'signal-exit'
              ? { code: null, signal: 'SIGTERM' }
              : { code: 77, signal: null },
        );
        if (exitMode === 'handled-signal-exit') {
          expect(await readFile(upperCompletedPath, 'utf8')).toBe('completed');
        }
        await waitForExit(PROCESS_REAP_TIMEOUT_MS, pids.root, pids.descendant);
      },
      90_000,
    );

    it.each(
      (
        [
          [MessageDisplay, false, 'explicit'],
          [StopFailure, false, 'explicit'],
          [SessionDelete, false, 'explicit'],
          [MessageDisplay, true, 'explicit'],
          [MessageDisplay, false, 'natural'],
          [StopFailure, false, 'natural'],
          [SessionDelete, false, 'natural'],
        ] as const
      ).map(
        ([event, isAsync, exitMode]) =>
          [
            `${isAsync ? 'an async' : 'a'} ${event} hook after ${exitMode} parent exit`,
            event,
            isAsync,
            exitMode,
          ] as const,
      ),
    )(
      'lets %s write output and finish',
      async (_, eventName, isAsync, exitMode) => {
        const tempDir = await tempDirFor('qwen-hook-survive-');
        const fixturePath = join(tempDir, 'hook.mjs');
        const readyPath = join(tempDir, 'hook.ready');
        const completedPath = join(tempDir, 'hook.completed');
        const pidPath = join(tempDir, 'hook.pid');
        const releasePath = join(tempDir, 'hook.release');
        const pids: Pids = {};
        onTestFinished(() => {
          reapLeftover(pids.driver);
          reapLeftover(pids.hook, true);
        });

        await writeFile(
          fixturePath,
          `import { readFileSync, writeFileSync } from 'node:fs';

const write = (stream, text) =>
  new Promise((resolve, reject) =>
    stream.write(text, (error) => (error ? reject(error) : resolve())),
  );
writeFileSync(process.argv[4], String(process.pid));
writeFileSync(process.argv[2], 'ready');
${pollUntil("readFileSync(process.argv[5], 'utf8') === 'continue'")}
await write(process.stdout, 'late stdout\\n');
await write(process.stderr, 'late stderr\\n');
writeFileSync(process.argv[3], 'completed');
`,
        );
        const driver = await startDriver(
          tempDir,
          `import { readFileSync } from 'node:fs';

const { HookRunner } = await import(process.argv[2]);
${consts({ tempDir, fixturePath, readyPath, completedPath, pidPath, releasePath, eventName, isAsync: String(isAsync), exitMode })}
const runner = new HookRunner();
void runner.executeHook(
  { type: 'command', command: \`exec \${JSON.stringify(process.execPath)} \${JSON.stringify(fixturePath)} \${JSON.stringify(readyPath)} \${JSON.stringify(completedPath)} \${JSON.stringify(pidPath)} \${JSON.stringify(releasePath)}\`, source: 'project', shell: 'bash', timeout: 60_000, async: isAsync === 'true' },
  eventName,
  { session_id: 'parent-exit-survival-test', transcript_path: \`\${tempDir}/transcript.jsonl\`, cwd: tempDir, hook_event_name: eventName, timestamp: new Date().toISOString() },
);
${pollUntil("readFileSync(readyPath, 'utf8') === 'ready'")}
if (exitMode === 'explicit') process.exit(0);
`,
        );
        pids.driver = driver.pid;

        await waitForStart(pids, { hook: pidPath }, readyPath);
        const readyAt = Date.now();
        expect(await driver.exit).toEqual({ code: 0, signal: null });
        expect(await readText(completedPath)).toBe('');
        if (exitMode === 'natural') {
          expect(Date.now() - readyAt).toBeLessThan(1000);
        }
        await writeFile(releasePath, 'continue');
        await waitFor(() => hasText(completedPath, 'completed'), 3000);
      },
      90_000,
    );

    it('enforces a surviving hook timeout after the parent exits', async () => {
      const tempDir = await tempDirFor('qwen-hook-deadline-');
      const fixturePath = join(tempDir, 'hook.mjs');
      const readyPath = join(tempDir, 'hook.ready');
      const pidPath = join(tempDir, 'hook.pid');
      const pids: Pids = {};
      onTestFinished(() => reapLeftover(pids.hook, true));

      await writeFile(fixturePath, SIGTERM_IGNORING_HOOK);
      const driver = await startDriver(
        tempDir,
        `import { readFileSync } from 'node:fs';

const { HookRunner } = await import(process.argv[2]);
${consts({ tempDir, fixturePath, readyPath, pidPath })}
const runner = new HookRunner();
void runner.executeHook(
  { type: 'command', command: \`exec \${JSON.stringify(process.execPath)} \${JSON.stringify(fixturePath)} \${JSON.stringify(readyPath)} \${JSON.stringify(pidPath)}\`, source: 'project', shell: 'bash', timeout: ${HOOK_GROUP_TIMEOUT_MS} },
  'StopFailure',
  { session_id: 'surviving-timeout-test', transcript_path: \`\${tempDir}/transcript.jsonl\`, cwd: tempDir, hook_event_name: 'StopFailure', timestamp: new Date().toISOString() },
);
${pollUntil("readFileSync(readyPath, 'utf8') === 'ready'")}
process.exit(0);
`,
      );

      expect(await driver.exit).toEqual({ code: 0, signal: null });
      pids.hook = await readPid(pidPath);
      expect(pids.hook).toBeDefined();
      expect(isRunning(pids.hook as number)).toBe(true);
      await waitForExit(PROCESS_REAP_TIMEOUT_MS, pids.hook);
    }, 90_000);

    it('preserves a surviving hook exit code 124 before its deadline', async () => {
      const result = await runBash(
        { command: 'exit 124', timeout: 10_000 },
        {
          ...inputFor(SessionDelete, 'surviving-exit-124-test', tmpdir()),
          transcript_path: '/tmp/transcript.jsonl',
        },
      );

      expect(result).toMatchObject({ success: false, exitCode: 124 });
      expect(result.error).toBeUndefined();
    }, 90_000);

    it('preserves a prompt exit 124 when the parent event loop is delayed past the deadline', async () => {
      const tempDir = await tempDirFor('qwen-hook-exit-124-');
      const markerPath = join(tempDir, 'hook.done');
      const resultPromise = runBash(
        {
          command: `: > ${JSON.stringify(markerPath)}; sleep 0.05; exit 124`,
          timeout: 1000,
        },
        inputFor(SessionDelete, 'surviving-delayed-exit-124-test', tempDir),
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
    }, 90_000);

    it('isolates the supervisor from hook NODE_OPTIONS', async () => {
      const tempDir = await tempDirFor('qwen-hook-node-options-');
      const preloadPath = join(tempDir, 'preload.cjs');
      const markerPath = join(tempDir, 'hook-node-options.txt');
      const nodeOptions = `--require=${preloadPath}`;

      await writeFile(preloadPath, 'process.exit(42);\n');
      const result = await runBash(
        {
          command: `printf '%s' "$NODE_OPTIONS" > ${JSON.stringify(markerPath)}`,
          timeout: 1000,
          env: { NODE_OPTIONS: nodeOptions },
        },
        inputFor(StopFailure, 'surviving-node-options-test', tempDir),
      );

      expect(result.success).toBe(true);
      expect(await readFile(markerPath, 'utf8')).toBe(nodeOptions);
    }, 90_000);

    it('forwards abort through a surviving hook supervisor', async () => {
      const tempDir = await tempDirFor('qwen-hook-abort-');
      const fixturePath = join(tempDir, 'hook.mjs');
      const readyPath = join(tempDir, 'hook.ready');
      const pidPath = join(tempDir, 'hook.pid');
      const controller = new AbortController();
      const pids: Pids = {};
      onTestFinished(() => {
        controller.abort();
        reapLeftover(pids.hook, true);
      });

      await writeFile(fixturePath, SIGTERM_IGNORING_HOOK);
      const resultPromise = runBash(
        { command: nodeCmd(fixturePath, readyPath, pidPath), timeout: 60_000 },
        inputFor(MessageDisplay, 'surviving-abort-test', tempDir),
        controller.signal,
      );

      await waitForStart(pids, { hook: pidPath }, readyPath);
      controller.abort();

      expect((await resultPromise).error?.message).toBe(CANCELLED);
      await waitForExit(PROCESS_REAP_TIMEOUT_MS, pids.hook);
    }, 90_000);

    it('reaps a surviving hook when its supervisor is stopped before abort', async () => {
      const tempDir = await tempDirFor('qwen-hook-stopped-');
      const fixturePath = join(tempDir, 'hook.mjs');
      const readyPath = join(tempDir, 'hook.ready');
      const hookPidPath = join(tempDir, 'hook.pid');
      const supervisorPidPath = join(tempDir, 'supervisor.pid');
      const controller = new AbortController();
      const pids: Pids = {};
      onTestFinished(() => {
        controller.abort();
        reapLeftover(pids.supervisor, true);
        reapLeftover(pids.hook, true);
      });

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
      const resultPromise = runBash(
        {
          command: nodeCmd(
            fixturePath,
            hookPidPath,
            supervisorPidPath,
            readyPath,
          ),
          timeout: 60_000,
        },
        inputFor(MessageDisplay, 'surviving-stopped-supervisor-test', tempDir),
        controller.signal,
      );

      await waitForStart(
        pids,
        { hook: hookPidPath, supervisor: supervisorPidPath },
        readyPath,
      );
      process.kill(pids.supervisor as number, 'SIGSTOP');
      controller.abort();

      expect((await resultPromise).error?.message).toBe(CANCELLED);
      expect(isRunning(pids.supervisor as number)).toBe(false);
      expect(isRunning(pids.hook as number)).toBe(false);
    }, 90_000);

    it('keeps supervising a surviving hook group after its root exits', async () => {
      const tempDir = await tempDirFor('qwen-hook-descendant-');
      const rootPath = join(tempDir, 'root.mjs');
      const descendantPath = join(tempDir, 'descendant.mjs');
      const descendantPidPath = join(tempDir, 'descendant.pid');
      const pids: Pids = {};
      onTestFinished(() => reapLeftover(pids.descendant));

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

      const result = await runBash(
        {
          command: nodeCmd(rootPath, descendantPath, descendantPidPath),
          // The root exits once the descendant has written its pid; the
          // supervisor then keeps the surviving descendant on the clock until
          // this deadline and kills the group, which is what ends the test.
          // So the deadline must outlast a node start on a loaded host: at
          // 300ms the descendant could die before writing its pid, and no
          // wait on the file afterwards could recover it.
          timeout: HOOK_GROUP_TIMEOUT_MS,
        },
        inputFor(SessionDelete, 'surviving-descendant-test', tempDir),
      );

      await waitForStart(pids, { descendant: descendantPidPath });
      expect(pids.descendant).toBeDefined();
      expect(result).toMatchObject({
        success: false,
        error: {
          message: `Hook timed out after ${HOOK_GROUP_TIMEOUT_MS / 1000}s`,
        },
      });
      await waitForExit(PROCESS_REAP_TIMEOUT_MS, pids.descendant);
    }, 90_000);

    it('delivers complete large input after the parent exits', async () => {
      const tempDir = await tempDirFor('qwen-hook-input-');
      const fixturePath = join(tempDir, 'hook.mjs');
      const resultPath = join(tempDir, 'input-result.json');
      const pidPath = join(tempDir, 'hook.pid');
      const displayedTextLength = 5 * 1024 * 1024;
      const pids: Pids = {};
      onTestFinished(() => reapLeftover(pids.hook, true));

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
        ...inputFor(MessageDisplay, 'large-input-test', tempDir),
        timestamp: '2026-01-01T00:00:00.000Z',
        message_id: 'message',
        displayed_text: 'x'.repeat(displayedTextLength),
        is_final: true,
      };
      const driver = await startDriver(
        tempDir,
        `const { HookRunner } = await import(process.argv[2]);
${consts({ tempDir, fixturePath, resultPath, pidPath, displayedTextLength: String(displayedTextLength) })}
const runner = new HookRunner();
void runner.executeHook(
  { type: 'command', command: \`exec \${JSON.stringify(process.execPath)} \${JSON.stringify(fixturePath)} \${JSON.stringify(resultPath)} \${JSON.stringify(pidPath)}\`, source: 'project', shell: 'bash', timeout: 60_000 },
  'MessageDisplay',
  { session_id: 'large-input-test', transcript_path: \`\${tempDir}/transcript.jsonl\`, cwd: tempDir, hook_event_name: 'MessageDisplay', timestamp: '2026-01-01T00:00:00.000Z', message_id: 'message', displayed_text: 'x'.repeat(Number(displayedTextLength)), is_final: true },
);
process.exit(0);
`,
        { ...process.env, TMPDIR: tempDir },
      );

      expect(await driver.exit).toEqual({ code: 0, signal: null });
      await waitFor(async () => (await readText(resultPath)).length > 0, 5000);
      pids.hook = await readPid(pidPath);
      expect(JSON.parse(await readFile(resultPath, 'utf8'))).toEqual({
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
    }, 90_000);
  },
);
