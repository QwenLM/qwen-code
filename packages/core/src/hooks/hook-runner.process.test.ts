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
const { MessageDisplay, PreToolUse, StopFailure } = HookEventName;

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
  'HookRunner process boundaries',
  () => {
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
  },
);
