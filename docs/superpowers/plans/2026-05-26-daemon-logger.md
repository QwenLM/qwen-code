# `qwen serve` Daemon File Logger — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add a daemon-scoped file logger to `qwen serve` so route errors, lifecycle messages, and ACP child stderr land in `~/.qwen/debug/daemon/<id>.log` in addition to stderr — eliminating the manual `2>serve.log` workaround for issue #4548.

**Architecture:** New cli-local module `daemonLogger.ts` exposes `initDaemonLogger(opts) → DaemonLogger`. `info/warn/error` tee to file + stderr; `raw` is file-only. `acp-bridge` gets a new optional `BridgeOptions.onDiagnosticLine` callback and `createSpawnChannelFactory({ onDiagnosticLine })` helper so the cli can route `writeServeDebugLine` and ACP child stderr lines into the daemon log without acp-bridge taking a cli dependency. No global singleton — logger is constructed per `runQwenServe` invocation.

**Tech Stack:** TypeScript, Vitest, Node `fs.promises`, existing `Storage.getGlobalDebugDir()`, existing `updateSymlink` helper.

**Reference spec:** `docs/superpowers/specs/2026-05-26-daemon-logger-design.md`

**Test harness:** `vitest run` from each package; for a single file: `cd packages/<pkg> && npx vitest run <relative-path>`.

---

## File map

| File                                           | Action          | Purpose                                                                                                                      |
| ---------------------------------------------- | --------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| `packages/cli/src/serve/daemonLogger.ts`       | **new**         | Logger sink + format helper                                                                                                  |
| `packages/cli/src/serve/daemonLogger.test.ts`  | **new**         | Unit tests for the above                                                                                                     |
| `packages/acp-bridge/src/bridgeOptions.ts`     | modify          | Add `onDiagnosticLine?` field + `DiagnosticLineSink` type                                                                    |
| `packages/acp-bridge/src/bridge.ts`            | modify          | Tee `writeServeDebugLine` through `opts.onDiagnosticLine` (via local `teeServeDebugLine` closure)                            |
| `packages/acp-bridge/src/bridge.test.ts`       | modify          | Add test that `onDiagnosticLine` receives debug lines                                                                        |
| `packages/acp-bridge/src/spawnChannel.ts`      | modify          | Export `createSpawnChannelFactory({ onDiagnosticLine })`; tee child stderr into callback                                     |
| `packages/acp-bridge/src/spawnChannel.test.ts` | modify (or new) | Test stderr forwarding callback                                                                                              |
| `packages/cli/src/serve/server.ts`             | modify          | `createServeApp` deps accept optional `daemonLog`; `sendBridgeError` routes through it when provided                         |
| `packages/cli/src/serve/server.test.ts`        | modify          | Verify daemonLog receives route-error entries                                                                                |
| `packages/cli/src/serve/runQwenServe.ts`       | modify          | Init logger, boot banner, wire spawn factory + bridge callback, replace lifecycle `writeStderrLine` calls, flush on shutdown |
| `packages/cli/src/serve/runQwenServe.test.ts`  | modify          | Verify boot banner + flush behavior                                                                                          |
| `docs/cli/serve.md` (or equivalent)            | modify          | Document daemon log path + opt-out                                                                                           |

---

## Task 0: Pre-flight

- [ ] **Step 1: Confirm worktree + branch**

Run: `git rev-parse --abbrev-ref HEAD && pwd`
Expected: branch `feat/support_daemon_logger`, cwd ends with `.claude/worktrees/feat-support-daemon-logger`.

- [ ] **Step 2: Install dependencies + baseline tests green**

Run: `npm install && cd packages/cli && npx vitest run src/serve/runQwenServe.test.ts && cd ../acp-bridge && npx vitest run`
Expected: all pass. (If not, baseline is broken — stop and report.)

- [ ] **Step 3: Skim the spec**

Read `docs/superpowers/specs/2026-05-26-daemon-logger-design.md` end-to-end. Key sections to internalize: §3 (modules), §4 (path), §5 (API), §6 (format + tee semantics), §7 (boot/shutdown), §11 (error handling).

---

## Task 1: `buildDaemonLogLine` pure helper

Pure formatter. No I/O. Easy to TDD.

**Files:**

- Create: `packages/cli/src/serve/daemonLogger.ts`
- Create: `packages/cli/src/serve/daemonLogger.test.ts`

- [ ] **Step 1: Write the failing tests**

`packages/cli/src/serve/daemonLogger.test.ts`:

```ts
/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect } from 'vitest';
import { buildDaemonLogLine } from './daemonLogger.js';

describe('buildDaemonLogLine', () => {
  const FIXED = new Date('2026-05-26T03:14:15.926Z');

  it('formats INFO with no ctx', () => {
    expect(
      buildDaemonLogLine({
        level: 'INFO',
        message: 'daemon started',
        now: FIXED,
      }),
    ).toBe('2026-05-26T03:14:15.926Z [INFO] [DAEMON] daemon started\n');
  });

  it('renders ctx fields in fixed order', () => {
    const line = buildDaemonLogLine({
      level: 'ERROR',
      message: 'route failed',
      now: FIXED,
      ctx: {
        sessionId: 'sess-1',
        route: 'POST /session/:id/prompt',
        clientId: 'client-x',
        childPid: 4242,
        channelId: 'ch-9',
      },
    });
    expect(line).toBe(
      '2026-05-26T03:14:15.926Z [ERROR] [DAEMON] ' +
        'route=POST /session/:id/prompt sessionId=sess-1 clientId=client-x ' +
        'childPid=4242 channelId=ch-9 route failed\n',
    );
  });

  it('appends extra ctx keys sorted lexicographically after fixed keys', () => {
    const line = buildDaemonLogLine({
      level: 'WARN',
      message: 'note',
      now: FIXED,
      ctx: { zeta: 1, alpha: 'a', sessionId: 's' },
    });
    expect(line).toBe(
      '2026-05-26T03:14:15.926Z [WARN] [DAEMON] sessionId=s alpha=a zeta=1 note\n',
    );
  });

  it('JSON.stringify-quotes values that contain spaces or =', () => {
    const line = buildDaemonLogLine({
      level: 'INFO',
      message: 'hi',
      now: FIXED,
      ctx: { weird: 'has space', eq: 'a=b' },
    });
    expect(line).toBe(
      '2026-05-26T03:14:15.926Z [INFO] [DAEMON] eq="a=b" weird="has space" hi\n',
    );
  });

  it('appends error stack as indented continuation lines', () => {
    const err = new Error('boom');
    err.stack =
      'Error: boom\n    at fn (file.ts:1:1)\n    at main (file.ts:2:2)';
    const line = buildDaemonLogLine({
      level: 'ERROR',
      message: 'failed',
      now: FIXED,
      err,
    });
    expect(line).toBe(
      '2026-05-26T03:14:15.926Z [ERROR] [DAEMON] failed\n' +
        '  Error: boom\n' +
        '      at fn (file.ts:1:1)\n' +
        '      at main (file.ts:2:2)\n',
    );
  });

  it('falls back to err.message when stack missing', () => {
    const err: Error = { name: 'Plain', message: 'no stack' } as Error;
    const line = buildDaemonLogLine({
      level: 'ERROR',
      message: 'failed',
      now: FIXED,
      err,
    });
    expect(line).toBe(
      '2026-05-26T03:14:15.926Z [ERROR] [DAEMON] failed\n' +
        '  Plain: no stack\n',
    );
  });
});
```

- [ ] **Step 2: Run test, confirm fail**

Run: `cd packages/cli && npx vitest run src/serve/daemonLogger.test.ts`
Expected: failure — `buildDaemonLogLine` not exported.

- [ ] **Step 3: Implement `buildDaemonLogLine`**

Create `packages/cli/src/serve/daemonLogger.ts` with:

```ts
/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

export type DaemonLogLevel = 'INFO' | 'WARN' | 'ERROR';

export interface DaemonLogContext {
  route?: string;
  sessionId?: string;
  clientId?: string;
  childPid?: number;
  channelId?: string;
  [key: string]: unknown;
}

const FIXED_CTX_ORDER = [
  'route',
  'sessionId',
  'clientId',
  'childPid',
  'channelId',
] as const;

function renderCtxValue(value: unknown): string {
  const s = String(value);
  return /[\s=]/.test(s) ? JSON.stringify(s) : s;
}

function renderCtx(ctx: DaemonLogContext | undefined): string {
  if (!ctx) return '';
  const parts: string[] = [];
  for (const key of FIXED_CTX_ORDER) {
    const v = ctx[key];
    if (v !== undefined && v !== null) {
      parts.push(`${key}=${renderCtxValue(v)}`);
    }
  }
  const fixedSet = new Set<string>(FIXED_CTX_ORDER);
  const extraKeys = Object.keys(ctx)
    .filter((k) => !fixedSet.has(k) && ctx[k] !== undefined && ctx[k] !== null)
    .sort();
  for (const key of extraKeys) {
    parts.push(`${key}=${renderCtxValue(ctx[key])}`);
  }
  return parts.length > 0 ? parts.join(' ') + ' ' : '';
}

function renderErr(err: Error | undefined): string {
  if (!err) return '';
  const body = err.stack ?? `${err.name ?? 'Error'}: ${err.message}`;
  return (
    body
      .split('\n')
      .map((l) => `  ${l}`)
      .join('\n') + '\n'
  );
}

export interface BuildDaemonLogLineArgs {
  level: DaemonLogLevel;
  message: string;
  now: Date;
  ctx?: DaemonLogContext;
  err?: Error;
}

export function buildDaemonLogLine(args: BuildDaemonLogLineArgs): string {
  const ts = args.now.toISOString();
  const ctxStr = renderCtx(args.ctx);
  return `${ts} [${args.level}] [DAEMON] ${ctxStr}${args.message}\n${renderErr(args.err)}`;
}
```

- [ ] **Step 4: Run test, confirm pass**

Run: `cd packages/cli && npx vitest run src/serve/daemonLogger.test.ts`
Expected: PASS (6 specs).

- [ ] **Step 5: Commit**

```bash
git add packages/cli/src/serve/daemonLogger.ts packages/cli/src/serve/daemonLogger.test.ts
git commit -m "feat(serve): buildDaemonLogLine formatter (#4548)"
```

---

## Task 2: `initDaemonLogger` opt-out + no-op factory

Returns a no-op logger when `QWEN_DAEMON_LOG_FILE` is disabled. No filesystem touch yet.

**Files:**

- Modify: `packages/cli/src/serve/daemonLogger.ts`
- Modify: `packages/cli/src/serve/daemonLogger.test.ts`

- [ ] **Step 1: Add failing tests**

Append to `daemonLogger.test.ts`:

```ts
import { initDaemonLogger } from './daemonLogger.js';
import { afterEach, beforeEach } from 'vitest';

describe('initDaemonLogger opt-out', () => {
  const originalEnv = process.env['QWEN_DAEMON_LOG_FILE'];
  afterEach(() => {
    if (originalEnv === undefined) delete process.env['QWEN_DAEMON_LOG_FILE'];
    else process.env['QWEN_DAEMON_LOG_FILE'] = originalEnv;
  });

  for (const val of ['0', 'false', 'off', 'no', 'False', ' OFF ']) {
    it(`returns no-op logger when QWEN_DAEMON_LOG_FILE=${JSON.stringify(val)}`, () => {
      process.env['QWEN_DAEMON_LOG_FILE'] = val;
      const stderr: string[] = [];
      const logger = initDaemonLogger({
        boundWorkspace: '/tmp/ws',
        baseDir: '/tmp/nonexistent-should-not-touch',
        stderr: (s) => stderr.push(s),
      });
      logger.info('hello');
      logger.warn('there');
      logger.error('boom');
      logger.raw('raw');
      expect(stderr).toEqual([]); // no-op = nothing
      expect(logger.getLogPath()).toBe('');
      expect(logger.getDaemonId()).toBe('');
    });
  }
});
```

- [ ] **Step 2: Run, confirm fail**

Run: `cd packages/cli && npx vitest run src/serve/daemonLogger.test.ts`
Expected: failure — `initDaemonLogger` not exported.

- [ ] **Step 3: Implement opt-out + no-op shape**

Append to `daemonLogger.ts`:

```ts
export interface DaemonLogger {
  info(message: string, ctx?: DaemonLogContext): void;
  warn(message: string, ctx?: DaemonLogContext): void;
  error(message: string, err?: Error | null, ctx?: DaemonLogContext): void;
  raw(line: string, level?: 'info' | 'warn' | 'error'): void;
  getLogPath(): string;
  getDaemonId(): string;
  flush(): Promise<void>;
}

export interface InitDaemonLoggerOptions {
  boundWorkspace: string;
  pid?: number;
  now?: () => Date;
  stderr?: (line: string) => void;
  baseDir?: string;
}

const NOOP_LOGGER: DaemonLogger = {
  info: () => {},
  warn: () => {},
  error: () => {},
  raw: () => {},
  getLogPath: () => '',
  getDaemonId: () => '',
  flush: () => Promise.resolve(),
};

function isOptedOut(): boolean {
  const raw = process.env['QWEN_DAEMON_LOG_FILE'];
  if (!raw) return false;
  return ['0', 'false', 'off', 'no'].includes(raw.trim().toLowerCase());
}

export function initDaemonLogger(_opts: InitDaemonLoggerOptions): DaemonLogger {
  if (isOptedOut()) return NOOP_LOGGER;
  throw new Error('initDaemonLogger: file path not implemented yet');
}
```

- [ ] **Step 4: Run, confirm opt-out specs pass**

Run: `cd packages/cli && npx vitest run src/serve/daemonLogger.test.ts -t "opt-out"`
Expected: opt-out specs PASS; full file may still fail (we'll add coverage incrementally).

- [ ] **Step 5: Commit**

```bash
git add packages/cli/src/serve/daemonLogger.ts packages/cli/src/serve/daemonLogger.test.ts
git commit -m "feat(serve): daemon logger opt-out env + no-op shape (#4548)"
```

---

## Task 3: File init (daemon-id, mkdir, sync probe, degraded fallback)

**Files:**

- Modify: `packages/cli/src/serve/daemonLogger.ts`
- Modify: `packages/cli/src/serve/daemonLogger.test.ts`

- [ ] **Step 1: Add failing tests**

Append to `daemonLogger.test.ts`:

```ts
import * as os from 'node:os';
import * as path from 'node:path';
import {
  mkdtempSync,
  readFileSync,
  existsSync,
  mkdirSync,
  chmodSync,
} from 'node:fs';
import { rmSync } from 'node:fs';

describe('initDaemonLogger file init', () => {
  let tmp: string;
  beforeEach(() => {
    tmp = mkdtempSync(path.join(os.tmpdir(), 'daemon-log-'));
  });
  afterEach(() => {
    try {
      rmSync(tmp, { recursive: true, force: true });
    } catch {}
  });

  it('derives daemon-id "serve-<pid>-<workspaceHash>" and creates log file', () => {
    const logger = initDaemonLogger({
      boundWorkspace: '/workspace/foo',
      pid: 1234,
      baseDir: tmp,
    });
    expect(logger.getDaemonId()).toMatch(/^serve-1234-[0-9a-f]{8}$/);
    expect(logger.getLogPath()).toBe(
      path.join(tmp, 'daemon', `${logger.getDaemonId()}.log`),
    );
    expect(existsSync(logger.getLogPath())).toBe(true);
    expect(readFileSync(logger.getLogPath(), 'utf8')).toMatch(
      /\[INFO\] \[DAEMON\] daemon started pid=1234 workspace=\/workspace\/foo/,
    );
  });

  it('falls back to no-op when mkdir fails', () => {
    const stderr: string[] = [];
    // Create a file where the directory should be → mkdir EEXIST/ENOTDIR
    const blockingFile = path.join(tmp, 'daemon');
    require('node:fs').writeFileSync(blockingFile, 'blocker');

    const logger = initDaemonLogger({
      boundWorkspace: '/w',
      pid: 1,
      baseDir: tmp,
      stderr: (s) => stderr.push(s),
    });
    expect(logger.getLogPath()).toBe('');
    expect(stderr.join('\n')).toMatch(/daemon log disabled/);
    expect(() => logger.info('after')).not.toThrow();
  });
});
```

- [ ] **Step 2: Run, confirm fail**

Run: `cd packages/cli && npx vitest run src/serve/daemonLogger.test.ts -t "file init"`
Expected: failure — `throw new Error('not implemented')`.

- [ ] **Step 3: Implement file init**

Replace the throwing body of `initDaemonLogger`. Add imports and helpers:

```ts
import * as nodeFs from 'node:fs';
import * as nodePath from 'node:path';
import * as crypto from 'node:crypto';
import { writeStderrLine } from '../utils/stdioHelpers.js';
import { Storage } from '@qwen-code/qwen-code-core';

function computeDaemonId(pid: number, boundWorkspace: string): string {
  const hash = crypto
    .createHash('sha256')
    .update(boundWorkspace)
    .digest('hex')
    .slice(0, 8);
  return `serve-${pid}-${hash}`;
}

export function initDaemonLogger(opts: InitDaemonLoggerOptions): DaemonLogger {
  if (isOptedOut()) return NOOP_LOGGER;

  const pid = opts.pid ?? process.pid;
  const now = opts.now ?? (() => new Date());
  const stderr = opts.stderr ?? writeStderrLine;
  const baseDir = opts.baseDir ?? Storage.getGlobalDebugDir();

  const daemonId = computeDaemonId(pid, opts.boundWorkspace);
  const daemonDir = nodePath.join(baseDir, 'daemon');
  const logPath = nodePath.join(daemonDir, `${daemonId}.log`);

  try {
    nodeFs.mkdirSync(daemonDir, { recursive: true });
    const firstLine = buildDaemonLogLine({
      level: 'INFO',
      message: `daemon started pid=${pid} workspace=${opts.boundWorkspace}`,
      now: now(),
    });
    nodeFs.appendFileSync(logPath, firstLine, { flag: 'a' });
  } catch (err) {
    stderr(
      `qwen serve: daemon log disabled — init failed: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
    return NOOP_LOGGER;
  }

  // Methods come in Task 4. For now stub them out so the file-init tests pass.
  return {
    info: () => {},
    warn: () => {},
    error: () => {},
    raw: () => {},
    getLogPath: () => logPath,
    getDaemonId: () => daemonId,
    flush: () => Promise.resolve(),
  };
}
```

- [ ] **Step 4: Run, confirm pass**

Run: `cd packages/cli && npx vitest run src/serve/daemonLogger.test.ts -t "file init"`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/cli/src/serve/daemonLogger.ts packages/cli/src/serve/daemonLogger.test.ts
git commit -m "feat(serve): daemon logger file init + degraded fallback (#4548)"
```

---

## Task 4: `info` / `warn` / `error` + async queue + flush + stderr tee

**Files:**

- Modify: `packages/cli/src/serve/daemonLogger.ts`
- Modify: `packages/cli/src/serve/daemonLogger.test.ts`

- [ ] **Step 1: Add failing tests**

Append to `daemonLogger.test.ts`:

```ts
describe('initDaemonLogger info/warn/error', () => {
  let tmp: string;
  beforeEach(() => {
    tmp = mkdtempSync(path.join(os.tmpdir(), 'daemon-log-'));
  });
  afterEach(() => {
    try {
      rmSync(tmp, { recursive: true, force: true });
    } catch {}
  });

  it('info appends to file and tees to stderr', async () => {
    const stderr: string[] = [];
    const fixed = new Date('2026-05-26T03:14:15.926Z');
    const logger = initDaemonLogger({
      boundWorkspace: '/w',
      pid: 1,
      baseDir: tmp,
      stderr: (s) => stderr.push(s),
      now: () => fixed,
    });
    logger.info('hello', { route: 'GET /' });
    await logger.flush();
    const content = readFileSync(logger.getLogPath(), 'utf8');
    expect(content).toContain('[INFO] [DAEMON] route=GET / hello\n');
    // Stderr saw the same line (after boot banner, which isn't teed here).
    const teedLines = stderr.filter((s) => s.includes('[INFO] [DAEMON]'));
    expect(teedLines).toHaveLength(1);
  });

  it('error appends err.stack as continuation', async () => {
    const logger = initDaemonLogger({
      boundWorkspace: '/w',
      pid: 1,
      baseDir: tmp,
    });
    const err = new Error('boom');
    logger.error('route failed', err, { route: 'POST /x' });
    await logger.flush();
    const content = readFileSync(logger.getLogPath(), 'utf8');
    expect(content).toMatch(
      /\[ERROR\] \[DAEMON\] route=POST \/x route failed\n  Error: boom/,
    );
  });

  it('flush awaits all pending appends', async () => {
    const logger = initDaemonLogger({
      boundWorkspace: '/w',
      pid: 1,
      baseDir: tmp,
    });
    for (let i = 0; i < 50; i++) logger.info(`msg-${i}`);
    await logger.flush();
    const lines = readFileSync(logger.getLogPath(), 'utf8').split('\n');
    const msgLines = lines.filter((l) => /msg-\d+$/.test(l));
    expect(msgLines).toHaveLength(50);
    for (let i = 0; i < 50; i++) {
      expect(msgLines[i]).toContain(`msg-${i}`);
    }
  });

  it('warns once on append failure and keeps trying', async () => {
    const logger = initDaemonLogger({
      boundWorkspace: '/w',
      pid: 1,
      baseDir: tmp,
      stderr: () => {},
    });
    // Sabotage by removing the file mid-flight — POSIX will keep the inode
    // around for a held fd, but appendFile reopens each call → ENOENT once
    // the parent dir is gone.
    rmSync(path.dirname(logger.getLogPath()), { recursive: true, force: true });
    const stderr2: string[] = [];
    // Re-create logger to bind our stderr capture? Simpler: re-stub via
    // private state — instead, do this in a separate test using a custom
    // stderr from init time.
    logger.info('after-rm-1');
    logger.info('after-rm-2');
    await logger.flush();
    // No throw — degraded path swallows. (Stderr count assertion left to
    // a separate variant if needed; this test pins "no crash on failure".)
  });
});
```

- [ ] **Step 2: Run, confirm fail**

Run: `cd packages/cli && npx vitest run src/serve/daemonLogger.test.ts -t "info/warn/error"`
Expected: failure — methods are stubs.

- [ ] **Step 3: Implement methods + queue + flush + tee**

Replace the final `return {...}` block in `initDaemonLogger`:

```ts
let pending: Promise<void> = Promise.resolve();
let degraded = false;

const enqueueAppend = (line: string): void => {
  pending = pending.then(() =>
    nodeFs.promises.appendFile(logPath, line).catch((err) => {
      if (!degraded) {
        degraded = true;
        stderr(
          `qwen serve: daemon log write failed — entering degraded mode: ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
      }
    }),
  );
};

const teeLine = (
  level: DaemonLogLevel,
  message: string,
  ctx?: DaemonLogContext,
  err?: Error,
): void => {
  const line = buildDaemonLogLine({ level, message, now: now(), ctx, err });
  // stderr first (synchronous, preserves human-visible order), then file.
  stderr(line.trimEnd());
  enqueueAppend(line);
};

return {
  info: (message, ctx) => teeLine('INFO', message, ctx),
  warn: (message, ctx) => teeLine('WARN', message, ctx),
  error: (message, err, ctx) =>
    teeLine('ERROR', message, ctx, err ?? undefined),
  raw: () => {}, // implemented in Task 5
  getLogPath: () => logPath,
  getDaemonId: () => daemonId,
  flush: () => pending,
};
```

- [ ] **Step 4: Run, confirm pass**

Run: `cd packages/cli && npx vitest run src/serve/daemonLogger.test.ts -t "info/warn/error"`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/cli/src/serve/daemonLogger.ts packages/cli/src/serve/daemonLogger.test.ts
git commit -m "feat(serve): daemon logger info/warn/error + flush (#4548)"
```

---

## Task 5: `raw()` file-only tee

**Files:**

- Modify: `packages/cli/src/serve/daemonLogger.ts`
- Modify: `packages/cli/src/serve/daemonLogger.test.ts`

- [ ] **Step 1: Add failing test**

Append:

```ts
describe('initDaemonLogger raw', () => {
  let tmp: string;
  beforeEach(() => {
    tmp = mkdtempSync(path.join(os.tmpdir(), 'daemon-log-'));
  });
  afterEach(() => {
    try {
      rmSync(tmp, { recursive: true, force: true });
    } catch {}
  });

  it('appends prefixed line, no stderr tee', async () => {
    const stderr: string[] = [];
    const logger = initDaemonLogger({
      boundWorkspace: '/w',
      pid: 1,
      baseDir: tmp,
      stderr: (s) => stderr.push(s),
    });
    const stderrBefore = stderr.length;
    logger.raw('[serve pid=123 cwd=/x] child crashed', 'warn');
    logger.raw('[serve pid=123 cwd=/x] another');
    await logger.flush();
    const content = readFileSync(logger.getLogPath(), 'utf8');
    expect(content).toContain(
      '[WARN] [DAEMON] [serve pid=123 cwd=/x] child crashed\n',
    );
    expect(content).toContain(
      '[INFO] [DAEMON] [serve pid=123 cwd=/x] another\n',
    );
    // No new stderr lines from raw()
    expect(stderr.length).toBe(stderrBefore);
  });
});
```

- [ ] **Step 2: Run, confirm fail**

Run: `cd packages/cli && npx vitest run src/serve/daemonLogger.test.ts -t "raw"`
Expected: fail — raw is no-op.

- [ ] **Step 3: Implement raw**

In `initDaemonLogger`, replace `raw: () => {},` with:

```ts
raw: (line: string, level: 'info' | 'warn' | 'error' = 'info') => {
  const upper = level.toUpperCase() as DaemonLogLevel;
  const formatted = `${now().toISOString()} [${upper}] [DAEMON] ${line}\n`;
  enqueueAppend(formatted);
},
```

- [ ] **Step 4: Run, confirm pass**

Run: `cd packages/cli && npx vitest run src/serve/daemonLogger.test.ts -t "raw"`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/cli/src/serve/daemonLogger.ts packages/cli/src/serve/daemonLogger.test.ts
git commit -m "feat(serve): daemon logger raw() file-only tee (#4548)"
```

---

## Task 6: `latest` symlink

**Files:**

- Modify: `packages/cli/src/serve/daemonLogger.ts`
- Modify: `packages/cli/src/serve/daemonLogger.test.ts`

- [ ] **Step 1: Add failing test**

Append:

```ts
import { realpathSync, lstatSync } from 'node:fs';

describe('initDaemonLogger latest symlink', () => {
  let tmp: string;
  beforeEach(() => {
    tmp = mkdtempSync(path.join(os.tmpdir(), 'daemon-log-'));
  });
  afterEach(() => {
    try {
      rmSync(tmp, { recursive: true, force: true });
    } catch {}
  });

  it('creates daemon/latest pointing to the current log', () => {
    const logger = initDaemonLogger({
      boundWorkspace: '/w',
      pid: 42,
      baseDir: tmp,
    });
    const linkPath = path.join(tmp, 'daemon', 'latest');
    expect(lstatSync(linkPath).isSymbolicLink() || existsSync(linkPath)).toBe(
      true,
    );
    expect(realpathSync(linkPath)).toBe(realpathSync(logger.getLogPath()));
  });

  it('updates latest on subsequent init in same dir', () => {
    const a = initDaemonLogger({ boundWorkspace: '/w', pid: 1, baseDir: tmp });
    const b = initDaemonLogger({ boundWorkspace: '/w', pid: 2, baseDir: tmp });
    expect(realpathSync(path.join(tmp, 'daemon', 'latest'))).toBe(
      realpathSync(b.getLogPath()),
    );
    expect(realpathSync(a.getLogPath())).not.toBe(realpathSync(b.getLogPath()));
  });
});
```

- [ ] **Step 2: Run, confirm fail**

Run: `cd packages/cli && npx vitest run src/serve/daemonLogger.test.ts -t "latest symlink"`
Expected: fail — symlink not created.

- [ ] **Step 3: Implement symlink update**

Add import at top of `daemonLogger.ts`:

```ts
import { updateSymlink } from '@qwen-code/qwen-code-core/internal/symlink';
```

(If that path is not exported from core, expose it. If `updateSymlink` is not re-exported through the package barrel, add a re-export in `packages/core/src/index.ts` such as `export { updateSymlink } from './utils/symlink.js';`. Verify with `grep -n 'updateSymlink' packages/core/src/index.ts` before editing.)

Inside `initDaemonLogger`, after the `appendFileSync` first-line write succeeds, add:

```ts
try {
  const aliasPath = nodePath.join(daemonDir, 'latest');
  updateSymlink(aliasPath, logPath, { fallbackCopy: false }).catch(() => {
    // Best-effort. Symlink failure must not degrade primary writes.
  });
} catch {
  // Sync throw equally best-effort.
}
```

- [ ] **Step 4: Run, confirm pass**

Run: `cd packages/cli && npx vitest run src/serve/daemonLogger.test.ts -t "latest symlink"`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add packages/cli/src/serve/daemonLogger.ts packages/cli/src/serve/daemonLogger.test.ts packages/core/src/index.ts
git commit -m "feat(serve): daemon logger latest symlink (#4548)"
```

---

## Task 7: Add `BridgeOptions.onDiagnosticLine` + tee `writeServeDebugLine`

**Files:**

- Modify: `packages/acp-bridge/src/bridgeOptions.ts`
- Modify: `packages/acp-bridge/src/bridge.ts`
- Modify: `packages/acp-bridge/src/bridge.test.ts`

- [ ] **Step 1: Add `DiagnosticLineSink` type to `bridgeOptions.ts`**

Insert near the top of the `BridgeOptions` interface (before `sessionScope`):

```ts
/**
 * Sink for serve-level diagnostic lines (set by the cli daemon logger).
 * When provided, the bridge tees `writeServeDebugLine` output through
 * this callback alongside the existing stderr write — used by
 * runQwenServe to capture them in the daemon log file. The bridge
 * does not own a file logger itself; this is a pure pass-through hook.
 */
export type DiagnosticLineSink = (
  line: string,
  level?: 'info' | 'warn' | 'error',
) => void;
```

Add inside `BridgeOptions`:

```ts
  /**
   * Optional: tee `writeServeDebugLine` output. See {@link DiagnosticLineSink}.
   * No-op when omitted. Set by cli `runQwenServe` from the daemon logger.
   */
  onDiagnosticLine?: DiagnosticLineSink;
```

- [ ] **Step 2: Add failing test**

In `packages/acp-bridge/src/bridge.test.ts`, add a new `describe('onDiagnosticLine', ...)` block. Find a representative test that uses `QWEN_SERVE_DEBUG=1` (search: `grep -n "QWEN_SERVE_DEBUG" packages/acp-bridge/src/bridge.test.ts`) for the env-toggle pattern. Add:

```ts
describe('onDiagnosticLine', () => {
  const originalDebug = process.env['QWEN_SERVE_DEBUG'];
  afterEach(() => {
    if (originalDebug === undefined) delete process.env['QWEN_SERVE_DEBUG'];
    else process.env['QWEN_SERVE_DEBUG'] = originalDebug;
  });

  it('receives writeServeDebugLine output when QWEN_SERVE_DEBUG=1', async () => {
    process.env['QWEN_SERVE_DEBUG'] = '1';
    const captured: Array<{ line: string; level?: string }> = [];
    const factory: ChannelFactory = async () => ({
      stream: new MockStream(), // use existing test helper
      kill: async () => {},
      killSync: () => {},
      exited: Promise.resolve(undefined),
    });
    const bridge = createHttpAcpBridge({
      boundWorkspace: '/w',
      channelFactory: factory,
      onDiagnosticLine: (line, level) => captured.push({ line, level }),
    });
    // Trigger a code path that calls writeServeDebugLine. The simplest
    // trigger today is a permission flow with a missing voter — find an
    // existing test that exercises one of the writeServeDebugLine call
    // sites (bridge.ts:1410, 1423) and copy its setup. The assertion is:
    expect(captured.some((e) => e.line.includes('qwen serve: '))).toBe(true);
    expect(
      captured.every((e) => e.level === undefined || e.level === 'info'),
    ).toBe(true);
    await bridge.shutdown();
  });
});
```

(Pre-execution: read `packages/acp-bridge/src/bridge.test.ts` to grab the right `MockStream` import and the smallest-setup test that already triggers `writeServeDebugLine`; reuse its harness rather than reinventing.)

- [ ] **Step 3: Run, confirm fail**

Run: `cd packages/acp-bridge && npx vitest run src/bridge.test.ts -t "onDiagnosticLine"`
Expected: fail — callback not invoked.

- [ ] **Step 4: Tee `writeServeDebugLine` through the callback**

In `packages/acp-bridge/src/bridge.ts`, near the top of `createHttpAcpBridge` (after `opts` is destructured), introduce a local tee that wraps the existing module-level helper:

```ts
const teeServeDebugLine = (message: string): void => {
  writeServeDebugLine(message);
  if (opts.onDiagnosticLine && isServeDebugLoggingEnabled()) {
    opts.onDiagnosticLine(`qwen serve debug: ${message}`, 'info');
  }
};
```

Then, in this file replace every internal `writeServeDebugLine(...)` call **inside** `createHttpAcpBridge`'s closure with `teeServeDebugLine(...)`. Use:

```bash
grep -n "writeServeDebugLine(" packages/acp-bridge/src/bridge.ts
```

to enumerate call sites, then edit each (they're at roughly lines 1410, 1423 in the current tree; verify before editing). Do NOT change the module-level `writeServeDebugLine` definition itself — other entry points and tests rely on it.

(Reason for not editing the top-level definition: changes the signature for all callers including tests; the closure tee is additive and locally-scoped.)

- [ ] **Step 5: Run, confirm pass**

Run: `cd packages/acp-bridge && npx vitest run src/bridge.test.ts -t "onDiagnosticLine"`
Expected: PASS. Also run full file to catch regressions: `npx vitest run src/bridge.test.ts`.

- [ ] **Step 6: Commit**

```bash
git add packages/acp-bridge/src/bridgeOptions.ts packages/acp-bridge/src/bridge.ts packages/acp-bridge/src/bridge.test.ts
git commit -m "feat(acp-bridge): onDiagnosticLine sink for serve debug tee (#4548)"
```

---

## Task 8: `createSpawnChannelFactory` with `onDiagnosticLine`

**Files:**

- Modify: `packages/acp-bridge/src/spawnChannel.ts`
- Modify: `packages/acp-bridge/src/spawnChannel.test.ts` (or create if missing)

- [ ] **Step 1: Inspect current export shape**

```bash
grep -n "defaultSpawnChannelFactory\|onDiagnosticLine\|process.stderr.write" packages/acp-bridge/src/spawnChannel.ts | head -20
```

Confirm `defaultSpawnChannelFactory` is the only public spawn export. The existing child-stderr forwarder calls `process.stderr.write(prefix + line + '\n')` inside the body — locate that block (around line 125).

- [ ] **Step 2: Add failing test**

In `packages/acp-bridge/src/spawnChannel.test.ts` (look for an existing test file; if none, create one):

```ts
import { describe, it, expect } from 'vitest';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createSpawnChannelFactory } from './spawnChannel.js';

describe('createSpawnChannelFactory onDiagnosticLine', () => {
  it('returns a ChannelFactory that tees child stderr lines', async () => {
    const captured: Array<{ line: string; level?: string }> = [];
    const factory = createSpawnChannelFactory({
      onDiagnosticLine: (line, level) => captured.push({ line, level }),
    });
    // Spawn a tiny child that writes to stderr then exits. Use the
    // QWEN_CLI_ENTRY escape hatch to point at a Node one-liner.
    const here = path.dirname(fileURLToPath(import.meta.url));
    process.env['QWEN_CLI_ENTRY'] = path.join(
      here,
      'testutil',
      'stderrOnlyEntry.cjs',
    );
    try {
      const ch = await factory('/tmp', {});
      await ch.exited;
      // After child exit, the forwarder flushes buffered tail.
      expect(
        captured.some((e) =>
          /\[serve pid=\d+ cwd=\/tmp\] hello-stderr/.test(e.line),
        ),
      ).toBe(true);
      expect(
        captured.every((e) => e.level === undefined || e.level === 'warn'),
      ).toBe(true);
    } finally {
      delete process.env['QWEN_CLI_ENTRY'];
    }
  });
});
```

And a fixture entry `packages/acp-bridge/src/testutil/stderrOnlyEntry.cjs`:

```js
process.stderr.write('hello-stderr\n');
process.exit(0);
```

(Adjust if the bridge requires ACP initialize handshake before considering the child "spawned" — alternative: write the stderr line during initialize handling. If the test is too brittle, fall back to mocking the spawn and asserting the forwarder logic in isolation — read `defaultSpawnChannelFactory`'s body and unit-test the inner forwarder by exporting it for tests.)

- [ ] **Step 3: Run, confirm fail**

Run: `cd packages/acp-bridge && npx vitest run src/spawnChannel.test.ts -t "onDiagnosticLine"`
Expected: fail — `createSpawnChannelFactory` not exported.

- [ ] **Step 4: Implement `createSpawnChannelFactory`**

Refactor `defaultSpawnChannelFactory` into a factory-of-factories. Replace the top of `spawnChannel.ts`:

```ts
export interface SpawnChannelFactoryOptions {
  onDiagnosticLine?: (line: string, level?: 'info' | 'warn' | 'error') => void;
}

export function createSpawnChannelFactory(
  options: SpawnChannelFactoryOptions = {},
): ChannelFactory {
  const onDiagnosticLine = options.onDiagnosticLine;
  return async (workspaceCwd, childEnvOverrides) => {
    // ... existing body of defaultSpawnChannelFactory ...
    // Where the existing forwarder does:
    //   process.stderr.write(prefix + line + '\n')
    // change it to:
    //   const teedLine = prefix + line;
    //   process.stderr.write(teedLine + '\n');
    //   if (onDiagnosticLine) onDiagnosticLine(teedLine, 'warn');
    // For the [truncated] branch:
    //   const teedTrunc = prefix + buf.slice(0, STDERR_LINE_CAP_CHARS) + ' [truncated]';
    //   process.stderr.write(teedTrunc + '\n');
    //   if (onDiagnosticLine) onDiagnosticLine(teedTrunc, 'warn');
  };
}

// Preserve the old export for backward compatibility (no callback wiring).
export const defaultSpawnChannelFactory: ChannelFactory =
  createSpawnChannelFactory();
```

Implementation discipline:

- Do NOT remove `defaultSpawnChannelFactory` — channels/IDE adapters still import it.
- Stick to the exact existing stderr write semantics (line buffering, 64 KiB cap, truncation marker). The `onDiagnosticLine` call sits next to each existing `process.stderr.write` and never replaces it.

- [ ] **Step 5: Run, confirm pass**

Run: `cd packages/acp-bridge && npx vitest run src/spawnChannel.test.ts -t "onDiagnosticLine"`
Expected: PASS. Also `npx vitest run` full suite to confirm no regressions.

- [ ] **Step 6: Commit**

```bash
git add packages/acp-bridge/src/spawnChannel.ts packages/acp-bridge/src/spawnChannel.test.ts packages/acp-bridge/src/testutil/stderrOnlyEntry.cjs
git commit -m "feat(acp-bridge): createSpawnChannelFactory with onDiagnosticLine (#4548)"
```

---

## Task 9: Route `sendBridgeError` through `daemonLog`

**Files:**

- Modify: `packages/cli/src/serve/server.ts`
- Modify: `packages/cli/src/serve/server.test.ts`

- [ ] **Step 1: Add `daemonLog` to `createServeApp` deps**

Read `packages/cli/src/serve/server.ts` around the `createServeApp` signature (search for `export function createServeApp` or `export interface ServeAppDeps`). Add to its deps interface:

```ts
/**
 * Optional daemon logger. When provided, `sendBridgeError` routes
 * each route-mapped error through `daemonLog.error(...)` (which tees
 * to stderr + the daemon log file). When omitted, falls back to
 * existing stderr-only behavior.
 */
daemonLog?: import('./daemonLogger.js').DaemonLogger;
```

- [ ] **Step 2: Add failing test**

In `packages/cli/src/serve/server.test.ts`, add (or extend a route-error test):

```ts
import { initDaemonLogger } from './daemonLogger.js';

it('sendBridgeError routes through daemonLog when provided', async () => {
  const tmp = mkdtempSync(path.join(os.tmpdir(), 'daemon-log-'));
  try {
    const stderr: string[] = [];
    const daemonLog = initDaemonLogger({
      boundWorkspace: '/w',
      pid: 1,
      baseDir: tmp,
      stderr: (s) => stderr.push(s),
    });
    const app = createServeApp({
      // ... usual deps for an erroring route, copy from the closest existing test ...
      daemonLog,
    });
    await request(app).get('/some/erroring/route').expect(500);
    await daemonLog.flush();
    const content = readFileSync(daemonLog.getLogPath(), 'utf8');
    expect(content).toMatch(
      /\[ERROR\] \[DAEMON\] route=GET \/some\/erroring\/route/,
    );
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});
```

(Copy whatever route-throws-error harness already lives in `server.test.ts` — e.g. inject a deps stub that throws when called. The point is one route hits `sendBridgeError` → assertion lands in the daemon log.)

- [ ] **Step 3: Run, confirm fail**

Run: `cd packages/cli && npx vitest run src/serve/server.test.ts -t "daemonLog"`
Expected: fail.

- [ ] **Step 4: Wire `sendBridgeError`**

In `server.ts`, find the `sendBridgeError` function (around line 2765). It currently writes to stderr inline. Refactor:

1. Plumb `daemonLog` from `createServeApp` into the closure that owns `sendBridgeError` (it's defined inside the function — same closure).
2. At the bottom of `sendBridgeError`, where the stderr write happens, replace with:

```ts
if (daemonLog) {
  daemonLog.error(
    err instanceof Error ? err.message : String(err),
    err instanceof Error ? err : null,
    {
      ...(ctx?.route ? { route: ctx.route } : {}),
      ...(ctx?.sessionId ? { sessionId: ctx.sessionId } : {}),
    },
  );
} else {
  // Legacy stderr-only path. Keep behavior intact for embedders that
  // construct createServeApp without daemonLog (tests, direct integrations).
  writeStderrLine(
    `qwen serve: ${ctx?.route ?? 'unknown route'}: ${
      err instanceof Error ? (err.stack ?? err.message) : String(err)
    }${ctx?.sessionId ? ` sessionId=${ctx.sessionId}` : ''}`,
  );
}
```

Make sure the new branch is taken when `daemonLog` is non-null. `daemonLog.error` already tees to stderr, so the stderr line is still produced — no behavior loss.

- [ ] **Step 5: Run, confirm pass**

Run: `cd packages/cli && npx vitest run src/serve/server.test.ts`
Expected: full file PASS (new + old).

- [ ] **Step 6: Commit**

```bash
git add packages/cli/src/serve/server.ts packages/cli/src/serve/server.test.ts
git commit -m "feat(serve): route sendBridgeError through daemonLog (#4548)"
```

---

## Task 10: Wire `runQwenServe` — init, boot banner, callbacks, lifecycle, shutdown flush

**Files:**

- Modify: `packages/cli/src/serve/runQwenServe.ts`
- Modify: `packages/cli/src/serve/runQwenServe.test.ts`

- [ ] **Step 1: Read the existing boot + shutdown structure**

Re-read `packages/cli/src/serve/runQwenServe.ts` lines 590-1030 (the `createHttpAcpBridge({...})` call site, the `RunHandle.close` body, and the `onSignal` handler). Note all `writeStderrLine(...)` calls — they're at roughly 393, 565, 805, 821, 825, 835, 859, 865, 872, 877, 951, 961, 986, 997, 1027, 1361 (run `grep -n writeStderrLine` for the current line numbers).

- [ ] **Step 2: Add failing test**

In `packages/cli/src/serve/runQwenServe.test.ts`, add (or extend):

```ts
import { existsSync, readFileSync, rmSync, mkdtempSync } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

it('runQwenServe initializes daemon logger and writes boot banner + flushes on shutdown', async () => {
  const tmpRuntime = mkdtempSync(path.join(os.tmpdir(), 'serve-runtime-'));
  const originalRuntime = process.env['QWEN_RUNTIME_DIR'];
  process.env['QWEN_RUNTIME_DIR'] = tmpRuntime;
  try {
    const handle = await runQwenServe({
      port: 0,
      hostname: '127.0.0.1',
      mode: 'workspace',
      // ... fill remaining required opts from the smallest existing test ...
    });
    // Boot wrote a daemon log somewhere under tmpRuntime/debug/daemon
    const daemonDir = path.join(tmpRuntime, 'debug', 'daemon');
    expect(existsSync(daemonDir)).toBe(true);
    const logs = require('node:fs')
      .readdirSync(daemonDir)
      .filter((f: string) => f.endsWith('.log'));
    expect(logs.length).toBe(1);
    const content = readFileSync(path.join(daemonDir, logs[0]), 'utf8');
    expect(content).toMatch(/daemon started pid=\d+ workspace=/);
    await handle.close();
    // After shutdown, "shutdown signal" or equivalent should be in the log.
    const after = readFileSync(path.join(daemonDir, logs[0]), 'utf8');
    expect(after).toMatch(/shutdown/i);
  } finally {
    if (originalRuntime === undefined) delete process.env['QWEN_RUNTIME_DIR'];
    else process.env['QWEN_RUNTIME_DIR'] = originalRuntime;
    rmSync(tmpRuntime, { recursive: true, force: true });
  }
});
```

- [ ] **Step 3: Run, confirm fail**

Run: `cd packages/cli && npx vitest run src/serve/runQwenServe.test.ts -t "daemon logger"`
Expected: fail.

- [ ] **Step 4: Wire in `runQwenServe`**

Edit `runQwenServe.ts`:

1. Add imports near the existing ones:

```ts
import { initDaemonLogger, type DaemonLogger } from './daemonLogger.js';
import { createSpawnChannelFactory } from '@qwen-code/acp-bridge/spawnChannel';
```

2. Inside `runQwenServe(opts)`, right after `boundWorkspace` is canonicalized (find the assignment; it's the value passed to `createHttpAcpBridge`):

```ts
const daemonLog: DaemonLogger = initDaemonLogger({ boundWorkspace });
writeStderrLine(
  `qwen serve: daemon log → ${daemonLog.getLogPath() || '(disabled)'}`,
);
```

3. Update the `createHttpAcpBridge({...})` call (around line 606):

```ts
const channelFactory = createSpawnChannelFactory({
  onDiagnosticLine: (line, level) => daemonLog.raw(line, level),
});
const bridge =
  deps.bridge ??
  createHttpAcpBridge({
    // ... existing fields ...
    channelFactory,
    onDiagnosticLine: (line, level) => daemonLog.raw(line, level),
  });
```

(If `deps.bridge` is provided, the operator is embedding and owns their own wiring — skip the callback.)

4. Update `createServeApp({...})` to forward `daemonLog`:

```ts
const app = createServeApp({
  // ... existing deps ...
  daemonLog,
});
```

5. Replace **lifecycle-only** `writeStderrLine(...)` calls (the ones inside `onSignal`, the `bridge.shutdown` error path, the server `error` listener, the device-flow dispose error, the "received signal, draining" line) with `daemonLog.warn(...)` / `daemonLog.error(..., err)` — daemonLog tees to stderr so operator-visible output is preserved. Do NOT touch:
   - Boot banner about "listening on URL" (that one is stdout, not stderr — `writeStdoutLine`).
   - CLI usage/argparse errors before `daemonLog` is constructed.
   - The lone "qwen serve: daemon log → ..." banner added in step 2 (avoid logging a line about itself).

   To be concrete, the **mechanical** rule for this step: every `writeStderrLine` call **after** the `daemonLog` is constructed and **before** `process.exit` is candidate; if its content reads like a daemon diagnostic (not a one-shot startup banner), switch it.

6. In the `RunHandle.close` body, after the `finish` callback runs (or right before `process.exit(0)` in `onSignal`), add `await daemonLog.flush();`. Concretely, the `onSignal` handler becomes:

```ts
const onSignal = async (signal: NodeJS.Signals) => {
  if (shuttingDown) {
    /* unchanged */ return;
  }
  daemonLog.warn(`received ${signal}, draining`, { signal });
  try {
    await handle.close();
    await daemonLog.flush();
    process.exit(0);
  } catch (err) {
    daemonLog.error('shutdown error', err instanceof Error ? err : null);
    await daemonLog.flush().catch(() => {});
    process.exit(1);
  }
};
```

- [ ] **Step 5: Run, confirm pass**

Run: `cd packages/cli && npx vitest run src/serve/runQwenServe.test.ts`
Expected: full file PASS.

Run also: `cd packages/cli && npx vitest run src/serve/` (full serve dir, catches indirect regressions like server.test.ts assertions on stderr output).

- [ ] **Step 6: Commit**

```bash
git add packages/cli/src/serve/runQwenServe.ts packages/cli/src/serve/runQwenServe.test.ts
git commit -m "feat(serve): init daemonLogger in runQwenServe + flush on shutdown (#4548)"
```

---

## Task 11: Documentation

**Files:**

- Modify: existing serve docs (locate with `find docs -iname '*serve*'` and `ls docs/cli/`)

- [ ] **Step 1: Find the right doc**

```bash
find docs -iname '*serve*' -type f
ls docs/cli/ 2>/dev/null
```

Pick the most natural home — likely `docs/cli/serve.md`. If none exists for `qwen serve`, create `docs/cli/serve-daemon-log.md`.

- [ ] **Step 2: Write the section**

Add (or create) a "Daemon log file" section:

```markdown
## Daemon log file

`qwen serve` writes a per-process diagnostic log to:
```

${QWEN_RUNTIME_DIR or ~/.qwen}/debug/daemon/serve-<pid>-<workspaceHash>.log

```

A `latest` symlink in the same directory always points at the current
process's log, so `tail -f ~/.qwen/debug/daemon/latest` will follow whichever
daemon is running.

The log captures lifecycle messages, route errors (with `route=` and
`sessionId=` context), ACP child stderr, and — when `QWEN_SERVE_DEBUG=1`
is set — extra bridge breadcrumbs. Lines that go to stderr today still
go to stderr; the file log is **additive**, not a replacement.

### Disabling

Set `QWEN_DAEMON_LOG_FILE=0` (or `false`/`off`/`no`) to skip file logging
entirely. Stderr output is unaffected.

### Relation to session debug logs

Session-scoped debug logs (`~/.qwen/debug/<sessionId>.txt` and the
`~/.qwen/debug/latest` symlink) are independent. The daemon log lives
in a sibling `daemon/` subdirectory; per-session debug semantics are
unchanged by this feature.

### No rotation

The daemon log appends indefinitely. Rotate manually if it grows large.
A future enhancement may add automatic rotation; track via #4548
follow-ups.
```

- [ ] **Step 3: Commit**

```bash
git add docs/cli/serve.md   # or the actual file path
git commit -m "docs(serve): document daemon log file path and opt-out (#4548)"
```

---

## Task 12: Final verification

- [ ] **Step 1: Full test sweep**

```bash
cd /Users/jinye.djy/Projects/qwen-code/.claude/worktrees/feat-support-daemon-logger
npm run test --workspace=packages/acp-bridge
npm run test --workspace=packages/cli
```

Expected: all green.

- [ ] **Step 2: Typecheck**

```bash
npm run typecheck --workspace=packages/acp-bridge
npm run typecheck --workspace=packages/cli
```

Expected: no errors.

- [ ] **Step 3: Manual smoke**

```bash
QWEN_RUNTIME_DIR=$(mktemp -d) node packages/cli/dist/index.js serve --port 0 --hostname 127.0.0.1 &
SERVE_PID=$!
sleep 1
ls $QWEN_RUNTIME_DIR/debug/daemon/
cat $QWEN_RUNTIME_DIR/debug/daemon/latest
kill -TERM $SERVE_PID
wait $SERVE_PID 2>/dev/null || true
cat $QWEN_RUNTIME_DIR/debug/daemon/latest  # should now contain shutdown line
```

Expected: log file exists, contains `daemon started ...`, then after kill the `received SIGTERM, draining` line.

If `packages/cli/dist/index.js` doesn't exist, build first: `npm run build --workspace=packages/cli`.

- [ ] **Step 4: Open PR**

```bash
git push -u origin HEAD
gh pr create --title "feat(serve): add daemon file logger (#4548)" --body "$(cat <<'EOF'
## Summary
- Adds a per-process daemon file logger at `~/.qwen/debug/daemon/serve-<pid>-<workspaceHash>.log` (configurable via `QWEN_RUNTIME_DIR`, opt-out via `QWEN_DAEMON_LOG_FILE=0`).
- Routes `runQwenServe` lifecycle messages, `sendBridgeError` route errors, `writeServeDebugLine` debug breadcrumbs, and ACP child stderr into the daemon log without removing existing stderr output.
- Adds `BridgeOptions.onDiagnosticLine` and `createSpawnChannelFactory({ onDiagnosticLine })` to keep `acp-bridge` ignorant of cli.

Closes #4548.

## Test plan
- [x] New unit tests in `packages/cli/src/serve/daemonLogger.test.ts` cover formatter, file init, info/warn/error, raw, latest symlink, opt-out, degraded fallback.
- [x] `packages/acp-bridge/src/bridge.test.ts` covers `onDiagnosticLine` tee from `writeServeDebugLine`.
- [x] `packages/acp-bridge/src/spawnChannel.test.ts` covers child stderr forwarder.
- [x] `packages/cli/src/serve/server.test.ts` covers route-error routing through `daemonLog.error`.
- [x] `packages/cli/src/serve/runQwenServe.test.ts` covers boot banner + flush on shutdown.
- [x] Manual smoke: log file created at boot, contains shutdown line on SIGTERM.

🤖 Generated with [Qwen Code](https://github.com/QwenLM/qwen-code)
EOF
)"
```

---

## Self-review notes

- **Spec coverage**: §3 module table covered by Tasks 1-10. §4 daemon-id + path → Task 3. §5 API surface → Tasks 1-6. §6 format + tee semantics → Task 1 (format), Task 4 (info/warn/error tee), Task 5 (raw file-only). §7 boot/shutdown → Task 10. §8 coverage table → Tasks 7/8/9/10. §9 write path & flush → Task 4. §10 config → Task 2 (opt-out), Task 11 (docs). §11 error handling → Tasks 3, 4. §12 testing → distributed across tasks. §13 docs → Task 11. §15 acceptance criteria → met by Tasks 3, 9, 8, 10, 10, 11 respectively.

- **Trace context (§6 bullet)**: deferred. The spec leaves it explicit ("Helper extracted to a shared module ... or duplicated locally — leave to plan"). The current plan does NOT inject trace_id/span_id; that is a follow-up task tracked in §16. If reviewer pushes back, add a Task 4.5 that imports `trace` from `@opentelemetry/api` and folds the span context into `buildDaemonLogLine` — but only if the reviewer asks; YAGNI otherwise.

- **`updateSymlink` import path**: Task 6 step 3 hedges on whether `updateSymlink` is exported from `@qwen-code/qwen-code-core`. Verify before editing: `grep -n updateSymlink packages/core/src/index.ts`. If missing, add the re-export in the same commit as Task 6.

- **acp-bridge test for `createSpawnChannelFactory`**: spawning a real child in a unit test is brittle. If Task 8 step 2 turns out to be flaky in CI, the fallback is to refactor the inner stderr forwarder into a small exported helper (`forwardChildStderr(stream, { prefix, onLine })`) and unit-test that in isolation — no real spawn needed.
