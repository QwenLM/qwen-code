/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import * as os from 'node:os';
import * as path from 'node:path';
import {
  appendFileSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  existsSync,
  promises as fsPromises,
  writeFileSync,
  rmSync,
  realpathSync,
  lstatSync,
} from 'node:fs';
import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import {
  buildDaemonLogLine,
  initDaemonLogger,
  type DaemonLogger,
} from './daemon-logger.js';

const openLoggers = new Set<DaemonLogger>();

async function createLogger(
  options: Parameters<typeof initDaemonLogger>[0],
): Promise<DaemonLogger> {
  const logger = await initDaemonLogger(options);
  openLoggers.add(logger);
  return logger;
}

afterEach(async () => {
  await Promise.all([...openLoggers].map((logger) => logger.close()));
  openLoggers.clear();
});

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

describe('initDaemonLogger opt-out', () => {
  const originalEnv = process.env['QWEN_DAEMON_LOG_FILE'];
  afterEach(() => {
    if (originalEnv === undefined) delete process.env['QWEN_DAEMON_LOG_FILE'];
    else process.env['QWEN_DAEMON_LOG_FILE'] = originalEnv;
  });

  for (const val of ['0', 'false', 'off', 'no', 'False', ' OFF ']) {
    it(`returns stderr-only logger when QWEN_DAEMON_LOG_FILE=${JSON.stringify(val)}`, async () => {
      process.env['QWEN_DAEMON_LOG_FILE'] = val;
      const stderr: string[] = [];
      const root = mkdtempSync(path.join(os.tmpdir(), 'daemon-log-optout-'));
      const baseDir = path.join(root, 'must-not-exist');
      try {
        const logger = await createLogger({
          boundWorkspace: '/tmp/ws',
          baseDir,
          stderr: (s) => stderr.push(s),
        });
        logger.info('hello');
        logger.warn('there');
        logger.error('boom');
        logger.raw('raw');
        expect(stderr).toHaveLength(3);
        expect(logger.getLogPath()).toBe('');
        expect(logger.getDaemonId()).toMatch(/^daemon:\d+$/);
        expect(logger.getStatus()).toMatchObject({
          mode: 'stderr-only',
          health: 'ok',
        });
        expect(existsSync(baseDir)).toBe(false);
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    });
  }
});

describe('initDaemonLogger file init', () => {
  let tmp: string;
  beforeEach(() => {
    tmp = mkdtempSync(path.join(os.tmpdir(), 'daemon-log-'));
  });
  afterEach(() => {
    try {
      rmSync(tmp, { recursive: true, force: true });
    } catch {
      // cleanup best-effort
    }
  });

  it('rejects a pending-byte budget smaller than one capped record', async () => {
    await expect(
      initDaemonLogger({
        boundWorkspace: '/workspace/foo',
        baseDir: tmp,
        policy: { maxRecordBytes: 256, maxPendingBytes: 255 },
      }),
    ).rejects.toThrow(
      'Daemon logger maxRecordBytes must not exceed maxPendingBytes',
    );
  });

  it('derives daemon-scoped daemon-id and creates the stable log file', async () => {
    const logger = await createLogger({
      boundWorkspace: '/workspace/foo',
      pid: 1234,
      baseDir: tmp,
      runId: '0123456789abcdef0123456789abcdef',
    });
    expect(logger.getDaemonId()).toBe('daemon:1234');
    expect(logger.getLogPath()).toBe(path.join(tmp, 'daemon', 'daemon.log'));
    expect(existsSync(logger.getLogPath())).toBe(true);
    expect(readFileSync(logger.getLogPath(), 'utf8')).toMatch(
      /\[INFO\] \[DAEMON\] runId=0123456789abcdef0123456789abcdef pid=1234 workspace=\/workspace\/foo workspaceHash=[0-9a-f]{8} daemon started/,
    );
    if (process.platform !== 'win32') {
      expect(lstatSync(path.join(tmp, 'daemon')).mode & 0o777).toBe(0o700);
      expect(
        lstatSync(path.join(tmp, 'daemon', '.stable-writer.lock')).mode & 0o777,
      ).toBe(0o700);
      expect(lstatSync(path.join(tmp, 'daemon', 'archive')).mode & 0o777).toBe(
        0o700,
      );
      expect(lstatSync(logger.getLogPath()).mode & 0o777).toBe(0o600);
    }
    expect(logger.getStatus()).toMatchObject({ mode: 'stable', health: 'ok' });
  });

  it('falls back to degraded stderr-only mode when mkdir fails', async () => {
    const stderr: string[] = [];
    // Create a file where the directory should be -> mkdir EEXIST/ENOTDIR
    const blockingFile = path.join(tmp, 'daemon');
    writeFileSync(blockingFile, 'blocker');

    const logger = await createLogger({
      boundWorkspace: '/w',
      pid: 1,
      baseDir: tmp,
      stderr: (s) => stderr.push(s),
    });
    expect(logger.getLogPath()).toBe('');
    expect(stderr.join('\n')).toMatch(/daemon log disabled/);
    expect(() => logger.info('after')).not.toThrow();
    expect(logger.getStatus()).toMatchObject({
      mode: 'stderr-only',
      health: 'degraded',
      issues: ['init_failed'],
    });
  });
});

describe('initDaemonLogger raw', () => {
  let tmp: string;
  beforeEach(() => {
    tmp = mkdtempSync(path.join(os.tmpdir(), 'daemon-log-'));
  });
  afterEach(() => {
    try {
      rmSync(tmp, { recursive: true, force: true });
    } catch {
      // cleanup best-effort
    }
  });

  it('appends prefixed line, no stderr tee', async () => {
    const stderr: string[] = [];
    const logger = await createLogger({
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
    expect(content).toMatch(
      /\[WARN\] \[DAEMON\] runId=[0-9a-f]{32} pid=1 \[serve pid=123 cwd=\/x\] child crashed\n/,
    );
    expect(content).toMatch(
      /\[INFO\] \[DAEMON\] runId=[0-9a-f]{32} pid=1 \[serve pid=123 cwd=\/x\] another\n/,
    );
    // No new stderr lines from raw()
    expect(stderr.length).toBe(stderrBefore);
  });
});

describe('initDaemonLogger info/warn/error', () => {
  let tmp: string;
  beforeEach(() => {
    tmp = mkdtempSync(path.join(os.tmpdir(), 'daemon-log-'));
  });
  afterEach(() => {
    try {
      rmSync(tmp, { recursive: true, force: true });
    } catch {
      // cleanup best-effort
    }
  });

  it('info appends to file and tees to stderr', async () => {
    const stderr: string[] = [];
    const fixed = new Date('2026-05-26T03:14:15.926Z');
    const logger = await createLogger({
      boundWorkspace: '/w',
      pid: 1,
      baseDir: tmp,
      stderr: (s) => stderr.push(s),
      now: () => fixed,
    });
    logger.info('hello', { route: 'GET /' });
    await logger.flush();
    const content = readFileSync(logger.getLogPath(), 'utf8');
    expect(content).toMatch(
      /\[INFO\] \[DAEMON\] runId=[0-9a-f]{32} pid=1 route=GET \/ hello\n/,
    );
    // Stderr saw the same line (after boot banner, which isn't teed here).
    const teedLines = stderr.filter((s) => s.includes('[INFO] [DAEMON]'));
    expect(teedLines).toHaveLength(1);
  });

  it('error appends err.stack as continuation', async () => {
    const logger = await createLogger({
      boundWorkspace: '/w',
      pid: 1,
      baseDir: tmp,
    });
    const err = new Error('boom');
    logger.error('route failed', err, { route: 'POST /x' });
    await logger.flush();
    const content = readFileSync(logger.getLogPath(), 'utf8');
    expect(content).toMatch(
      /\[ERROR\] \[DAEMON\] runId=[0-9a-f]{32} pid=1 route=POST \/x route failed\n {2}Error: boom/,
    );
  });

  it('flush awaits all pending appends', async () => {
    const logger = await createLogger({
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

  it('poisons file writes after an append result becomes unknown', async () => {
    const logger = await createLogger({
      boundWorkspace: '/w',
      pid: 1,
      baseDir: tmp,
      stderr: () => {},
    });
    // Sabotage by removing the parent directory so subsequent appendFile fails with ENOENT.
    rmSync(path.dirname(logger.getLogPath()), { recursive: true, force: true });
    logger.info('after-rm-1');
    logger.info('after-rm-2');
    await logger.flush();
    expect(logger.getStatus()).toMatchObject({
      health: 'degraded',
      issues: ['write_failed'],
      droppedRecords: 1,
    });
  });
});

describe('initDaemonLogger latest symlink', () => {
  let tmp: string;
  beforeEach(() => {
    tmp = mkdtempSync(path.join(os.tmpdir(), 'daemon-log-'));
  });
  afterEach(() => {
    try {
      rmSync(tmp, { recursive: true, force: true });
    } catch {
      // cleanup best-effort
    }
  });

  it('creates daemon/latest pointing to the current log', async () => {
    const logger = await createLogger({
      boundWorkspace: '/w',
      pid: 42,
      baseDir: tmp,
    });
    const linkPath = path.join(tmp, 'daemon', 'latest');
    expect(lstatSync(linkPath).isSymbolicLink()).toBe(true);
    expect(realpathSync(linkPath)).toBe(realpathSync(logger.getLogPath()));
  });

  it('keeps latest on stable while a concurrent logger uses fallback', async () => {
    const a = await createLogger({
      boundWorkspace: '/w',
      pid: 1,
      baseDir: tmp,
      runId: '11111111111111111111111111111111',
      policy: { stableAcquireBudgetMs: 0 },
    });
    const b = await createLogger({
      boundWorkspace: '/w',
      pid: 2,
      baseDir: tmp,
      runId: '22222222222222222222222222222222',
      policy: { stableAcquireBudgetMs: 0 },
    });
    expect(realpathSync(path.join(tmp, 'daemon', 'latest'))).toBe(
      realpathSync(a.getLogPath()),
    );
    expect(b.getStatus()).toMatchObject({ mode: 'fallback', health: 'ok' });
    expect(b.getLogPath()).toContain(
      path.join('runs', 'run-22222222222222222222222222222222'),
    );
  });
});

describe('initDaemonLogger bounded storage', () => {
  let tmp: string;
  beforeEach(() => {
    tmp = mkdtempSync(path.join(os.tmpdir(), 'daemon-log-storage-'));
  });
  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  it('reuses the stable path across restarts and keeps run identity immutable', async () => {
    const stderr: string[] = [];
    const first = await createLogger({
      boundWorkspace: '/w',
      pid: 11,
      baseDir: tmp,
      runId: '11111111111111111111111111111111',
      stderr: (line) => stderr.push(line),
    });
    first.info('first run', {
      runId: 'spoofed',
      pid: 999,
    });
    await first.flush();
    await first.close();

    const second = await createLogger({
      boundWorkspace: '/w',
      pid: 22,
      baseDir: tmp,
      runId: '22222222222222222222222222222222',
      stderr: (line) => stderr.push(line),
    });
    second.info('second run');
    await second.flush();

    expect(second.getLogPath()).toBe(first.getLogPath());
    const content = readFileSync(second.getLogPath(), 'utf8');
    expect(content).toContain(
      'runId=11111111111111111111111111111111 pid=11 first run',
    );
    expect(content).toContain(
      'runId=22222222222222222222222222222222 pid=22 second run',
    );
    expect(content).not.toContain('spoofed');
    expect(stderr.join('\n')).toContain('pid=999 runId=spoofed first run');
  });

  it('truncates a file record on a UTF-8 boundary without truncating stderr', async () => {
    const stderr: string[] = [];
    const logger = await createLogger({
      boundWorkspace: '/w',
      pid: 1,
      baseDir: tmp,
      stderr: (line) => stderr.push(line),
      policy: {
        maxBytes: 512,
        maxRecordBytes: 256,
        maxPendingBytes: 1_024,
      },
    });
    const message = '你'.repeat(200);
    logger.info(message);
    await logger.flush();

    const content = readFileSync(logger.getLogPath(), 'utf8');
    expect(content).toContain('[truncated originalBytes=');
    expect(content).not.toContain('\ufffd');
    expect(stderr.join('\n')).toContain(message);
  });

  it('rotates before exceeding the active limit and keeps a strict archive cap', async () => {
    const logger = await createLogger({
      boundWorkspace: '/w',
      pid: 1,
      baseDir: tmp,
      stderr: () => {},
      policy: {
        maxBytes: 512,
        maxArchives: 2,
        maxRecordBytes: 256,
        maxPendingBytes: 8 * 1024,
      },
    });
    for (let i = 0; i < 12; i += 1) {
      logger.info(`record-${i}-${'x'.repeat(140)}`);
    }
    await logger.flush();

    const archiveDir = path.join(tmp, 'daemon', 'archive');
    const archives = readdirSync(archiveDir).filter((name) =>
      /^daemon-\d{12}-\d{8}T\d{9}Z-[0-9a-f]{8}\.log$/.test(name),
    );
    expect(archives).toHaveLength(2);
    expect(lstatSync(logger.getLogPath()).size).toBeLessThanOrEqual(512);
  });

  it('throttles failed rotation retries while allowing records that still fit', async () => {
    let monotonicMs = 0;
    let renameCalls = 0;
    const logger = await createLogger({
      boundWorkspace: '/w',
      baseDir: tmp,
      stderr: () => {},
      monotonicNow: () => monotonicMs,
      fs: {
        ...fsPromises,
        rename: async (...args) => {
          renameCalls += 1;
          if (renameCalls === 1) throw new Error('reader blocks rename');
          return fsPromises.rename(...args);
        },
      },
      policy: {
        maxBytes: 600,
        maxRecordBytes: 500,
        maxPendingBytes: 1_024,
        rotationRetryIntervalMs: 1_000,
      },
    });

    logger.info('first-trigger-' + 'x'.repeat(600));
    await logger.flush();
    expect(renameCalls).toBe(1);

    logger.info('small-' + 's'.repeat(80));
    logger.info('second-trigger-' + 'x'.repeat(600));
    await logger.flush();
    expect(renameCalls).toBe(1);

    monotonicMs = 1_000;
    logger.info('retry-after-window');
    await logger.flush();
    expect(renameCalls).toBe(2);
    const archive = readdirSync(path.join(tmp, 'daemon', 'archive'))[0];
    expect(
      readFileSync(path.join(tmp, 'daemon', 'archive', archive), 'utf8'),
    ).toContain('small');
    expect(logger.getStatus()).toMatchObject({
      issues: ['rotation_failed'],
      droppedRecords: 2,
    });
  });

  it('separates an incomplete previous tail before writing the next boot record', async () => {
    const first = await createLogger({
      boundWorkspace: '/w',
      pid: 1,
      baseDir: tmp,
      stderr: () => {},
    });
    const logPath = first.getLogPath();
    await first.close();
    appendFileSync(logPath, 'partial-tail');

    const second = await createLogger({
      boundWorkspace: '/w',
      pid: 2,
      baseDir: tmp,
      stderr: () => {},
    });
    const content = readFileSync(second.getLogPath(), 'utf8');
    expect(content).toMatch(
      /partial-tail\n.*previousTailIncomplete=true.*daemon started\n$/s,
    );
  });

  it('rotates an incomplete tail when its repair record would cross the limit', async () => {
    const policy = {
      maxBytes: 512,
      maxRecordBytes: 256,
      maxPendingBytes: 1_024,
    };
    const first = await createLogger({
      boundWorkspace: '/w',
      pid: 1,
      baseDir: tmp,
      stderr: () => {},
      policy,
    });
    const logPath = first.getLogPath();
    await first.close();
    writeFileSync(logPath, 'x'.repeat(370));

    const second = await createLogger({
      boundWorkspace: '/w',
      pid: 2,
      baseDir: tmp,
      runId: '22222222222222222222222222222222',
      now: () => new Date('2026-07-15T00:00:00.000Z'),
      stderr: () => {},
      policy,
    });

    const active = readFileSync(second.getLogPath(), 'utf8');
    expect(active).toMatch(/^2026-07-15T00:00:00.000Z/);
    expect(active).not.toContain('previousTailIncomplete');
    expect(readdirSync(path.join(tmp, 'daemon', 'archive'))).toHaveLength(1);
  });

  it('caps pending payload and reports recovered queue loss before the next record', async () => {
    let releaseAppend: (() => void) | undefined;
    let blockAppends = false;
    const stderr: string[] = [];
    const gate = new Promise<void>((resolve) => {
      releaseAppend = resolve;
    });
    const logger = await createLogger({
      boundWorkspace: '/w',
      pid: 1,
      baseDir: tmp,
      stderr: (line) => stderr.push(line),
      fs: {
        ...fsPromises,
        appendFile: async (...args) => {
          if (blockAppends) await gate;
          return fsPromises.appendFile(...args);
        },
      },
      policy: {
        maxBytes: 4 * 1024,
        maxRecordBytes: 256,
        maxPendingBytes: 400,
      },
    });
    blockAppends = true;
    for (let i = 0; i < 5; i += 1) {
      logger.info(`queued-${i}-${'x'.repeat(90)}`);
    }
    expect(logger.getStatus().issues).toContain('queue_overflow');
    expect(logger.getStatus().droppedRecords).toBeGreaterThan(0);
    expect(
      stderr.filter((line) => line.includes('queue limit reached')),
    ).toHaveLength(1);

    releaseAppend?.();
    await logger.flush();
    logger.info('after-recovery');
    await logger.flush();
    const content = readFileSync(logger.getLogPath(), 'utf8');
    const summaryIndex = content.indexOf('daemon file log records dropped');
    expect(summaryIndex).toBeGreaterThanOrEqual(0);
    expect(summaryIndex).toBeLessThan(content.indexOf('after-recovery'));
  });

  it('attempts the final queue-loss summary during close', async () => {
    let releaseAppend: (() => void) | undefined;
    let blockAppends = false;
    const gate = new Promise<void>((resolve) => {
      releaseAppend = resolve;
    });
    const logger = await createLogger({
      boundWorkspace: '/w',
      baseDir: tmp,
      stderr: () => {},
      fs: {
        ...fsPromises,
        appendFile: async (...args) => {
          if (blockAppends) await gate;
          return fsPromises.appendFile(...args);
        },
      },
      policy: { maxPendingBytes: 512, maxRecordBytes: 256 },
    });
    blockAppends = true;
    logger.info('accepted-' + 'a'.repeat(100));
    for (let i = 0; i < 10; i += 1) {
      logger.info(`dropped-${i}-` + 'x'.repeat(200));
    }

    const closing = logger.close();
    releaseAppend?.();
    await closing;

    expect(readFileSync(logger.getLogPath(), 'utf8')).toContain(
      'daemon file log records dropped',
    );
  });

  it('stops file mutation after append failure and excludes the unknown record from exact loss', async () => {
    let appendCalls = 0;
    const logger = await createLogger({
      boundWorkspace: '/w',
      pid: 1,
      baseDir: tmp,
      stderr: () => {},
      fs: {
        ...fsPromises,
        appendFile: async (...args) => {
          appendCalls += 1;
          if (appendCalls === 2) throw new Error('injected append failure');
          return fsPromises.appendFile(...args);
        },
      },
    });
    logger.info('unknown-result');
    logger.info('skipped-after-poison');
    await logger.flush();

    expect(appendCalls).toBe(2);
    expect(logger.getStatus()).toMatchObject({
      health: 'degraded',
      issues: ['write_failed'],
      droppedRecords: 1,
    });
  });

  it('releases stable ownership after a failed stable boot probe', async () => {
    let appendCalls = 0;
    const fallback = await createLogger({
      boundWorkspace: '/w',
      baseDir: tmp,
      runId: '11111111111111111111111111111111',
      stderr: () => {},
      fs: {
        ...fsPromises,
        appendFile: async (...args) => {
          appendCalls += 1;
          if (appendCalls === 1) throw new Error('stable boot failed');
          return fsPromises.appendFile(...args);
        },
      },
      policy: { stableAcquireBudgetMs: 0 },
    });
    expect(fallback.getStatus()).toMatchObject({
      mode: 'fallback',
      health: 'degraded',
      issues: ['init_failed', 'write_failed'],
    });

    const next = await createLogger({
      boundWorkspace: '/w',
      baseDir: tmp,
      runId: '22222222222222222222222222222222',
      stderr: () => {},
      policy: { stableAcquireBudgetMs: 0 },
    });
    expect(next.getStatus().mode).toBe('stable');
    await next.close();
    await fallback.close();
  });

  it('releases stable ownership when the probe warning cannot reach stderr', async () => {
    let appendCalls = 0;
    const fallback = await createLogger({
      boundWorkspace: '/w',
      baseDir: tmp,
      runId: '11111111111111111111111111111111',
      stderr: () => {
        throw new Error('stderr unavailable');
      },
      fs: {
        ...fsPromises,
        appendFile: async (...args) => {
          appendCalls += 1;
          if (appendCalls === 1) throw new Error('stable boot failed');
          return fsPromises.appendFile(...args);
        },
      },
      policy: { stableAcquireBudgetMs: 0 },
    });
    expect(fallback.getStatus()).toMatchObject({
      mode: 'fallback',
      health: 'degraded',
      issues: ['init_failed', 'write_failed'],
    });

    const next = await createLogger({
      boundWorkspace: '/w',
      baseDir: tmp,
      runId: '22222222222222222222222222222222',
      stderr: () => {},
      policy: { stableAcquireBudgetMs: 0 },
    });
    expect(next.getStatus().mode).toBe('stable');
    await next.close();
    await fallback.close();
  });

  it('ignores a released stable lease compromise after switching to fallback', async () => {
    let appendCalls = 0;
    const compromiseByLockPath = new Map<string, (error: Error) => void>();
    const acquireLock = vi.fn(async (_target: string, options: unknown) => {
      const lockOptions = options as {
        lockfilePath?: string;
        onCompromised?: (error: Error) => void;
      };
      if (lockOptions.lockfilePath && lockOptions.onCompromised) {
        compromiseByLockPath.set(
          lockOptions.lockfilePath,
          lockOptions.onCompromised,
        );
      }
      return async () => {
        if (lockOptions.lockfilePath?.endsWith('.stable-writer.lock')) {
          lockOptions.onCompromised?.(
            new Error('stable compromise during release'),
          );
        }
      };
    });
    const logger = await createLogger({
      boundWorkspace: '/w',
      pid: 1,
      baseDir: tmp,
      runId: '11111111111111111111111111111111',
      stderr: () => {},
      acquireLock: acquireLock as never,
      fs: {
        ...fsPromises,
        chmod: async () => {},
        appendFile: async (...args) => {
          appendCalls += 1;
          if (appendCalls === 1) throw new Error('stable boot failed');
          return fsPromises.appendFile(...args);
        },
      },
    });
    expect(logger.getStatus().mode).toBe('fallback');

    const stableLockPath = path.join(tmp, 'daemon', '.stable-writer.lock');
    compromiseByLockPath.get(stableLockPath)?.(
      new Error('late stable compromise'),
    );
    logger.raw('fallback-remains-writable');
    await logger.flush();

    expect(readFileSync(logger.getLogPath(), 'utf8')).toContain(
      'fallback-remains-writable',
    );
    expect(logger.getStatus().issues).not.toContain('lease_compromised');
    expect(logger.getStatus().droppedRecords).toBe(0);

    const ownerLockPath = path.join(
      path.dirname(logger.getLogPath()),
      '.owner.lock',
    );
    compromiseByLockPath.get(ownerLockPath)?.(
      new Error('active fallback compromise'),
    );
    logger.raw('must-not-reach-file');
    await logger.flush();

    expect(readFileSync(logger.getLogPath(), 'utf8')).not.toContain(
      'must-not-reach-file',
    );
    expect(logger.getStatus()).toMatchObject({
      issues: expect.arrayContaining(['lease_compromised']),
      droppedRecords: 1,
    });
  });

  it('stops new mutations when the lifetime lease is compromised', async () => {
    let compromise: ((error: Error) => void) | undefined;
    const release = vi.fn(async () => {});
    const acquireLock = vi.fn(async (_target: string, options: unknown) => {
      compromise = (options as { onCompromised?: (error: Error) => void })
        .onCompromised;
      return release;
    });
    const logger = await createLogger({
      boundWorkspace: '/w',
      pid: 1,
      baseDir: tmp,
      stderr: () => {
        throw new Error('stderr unavailable');
      },
      acquireLock: acquireLock as never,
      fs: { ...fsPromises, chmod: async () => {} },
    });
    const before = readFileSync(logger.getLogPath(), 'utf8');
    expect(() => compromise?.(new Error('lease lost'))).not.toThrow();
    logger.raw('must-not-reach-file');
    await logger.flush();

    expect(readFileSync(logger.getLogPath(), 'utf8')).toBe(before);
    expect(logger.getStatus()).toMatchObject({
      health: 'degraded',
      issues: ['lease_compromised'],
      droppedRecords: 1,
    });
  });

  it('does not recreate the active file when the lease is compromised during rotation', async () => {
    let compromise: ((error: Error) => void) | undefined;
    let appendCalls = 0;
    const logger = await createLogger({
      boundWorkspace: '/w',
      pid: 1,
      baseDir: tmp,
      stderr: () => {},
      acquireLock: vi.fn(async (_target: string, options: unknown) => {
        compromise = (options as { onCompromised?: (error: Error) => void })
          .onCompromised;
        return async () => {};
      }) as never,
      fs: {
        ...fsPromises,
        chmod: async () => {},
        appendFile: async (...args) => {
          appendCalls += 1;
          return fsPromises.appendFile(...args);
        },
        rename: async (...args) => {
          await fsPromises.rename(...args);
          compromise?.(new Error('lease lost during rename'));
        },
      },
      policy: {
        maxBytes: 300,
        maxRecordBytes: 256,
        maxPendingBytes: 1_024,
      },
    });
    logger.info('rotation-trigger-' + 'x'.repeat(240));
    await logger.flush();

    expect(appendCalls).toBe(1);
    expect(existsSync(logger.getLogPath())).toBe(false);
    expect(readdirSync(path.join(tmp, 'daemon', 'archive'))).toHaveLength(1);
    expect(logger.getStatus()).toMatchObject({
      health: 'degraded',
      issues: ['lease_compromised'],
      droppedRecords: 1,
    });
  });

  it('returns from close at its deadline without releasing ownership early', async () => {
    let releaseAppend: (() => void) | undefined;
    let blockAppends = false;
    const gate = new Promise<void>((resolve) => {
      releaseAppend = resolve;
    });
    const releaseLease = vi.fn(async () => {});
    const logger = await createLogger({
      boundWorkspace: '/w',
      pid: 1,
      baseDir: tmp,
      stderr: () => {},
      acquireLock: vi.fn(async () => releaseLease) as never,
      fs: {
        ...fsPromises,
        chmod: async () => {},
        appendFile: async (...args) => {
          if (blockAppends) await gate;
          return fsPromises.appendFile(...args);
        },
      },
      policy: { closeDrainBudgetMs: 20 },
    });
    blockAppends = true;
    logger.info('blocked');
    await logger.close();
    expect(releaseLease).not.toHaveBeenCalled();

    releaseAppend?.();
    await logger.flush();
    await vi.waitFor(() => expect(releaseLease).toHaveBeenCalledOnce());
  });

  it('keeps close non-rejecting when stderr and lease release both fail', async () => {
    const logger = await createLogger({
      boundWorkspace: '/w',
      pid: 1,
      baseDir: tmp,
      stderr: () => {
        throw new Error('stderr unavailable');
      },
      acquireLock: vi.fn(async () => async () => {
        throw new Error('release failed');
      }) as never,
      fs: { ...fsPromises, chmod: async () => {} },
    });

    await expect(logger.close()).resolves.toBeUndefined();
  });
});

describe('initDaemonLogger fallback retention', () => {
  let tmp: string;
  beforeEach(() => {
    tmp = mkdtempSync(path.join(os.tmpdir(), 'daemon-log-fallback-'));
  });
  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  it('keeps all live fallback families and only the latest cleanly closed family', async () => {
    const stable = await createLogger({
      boundWorkspace: '/w',
      baseDir: tmp,
      runId: '11111111111111111111111111111111',
      stderr: () => {},
      policy: { stableAcquireBudgetMs: 0 },
    });
    const first = await createLogger({
      boundWorkspace: '/w',
      baseDir: tmp,
      runId: '22222222222222222222222222222222',
      stderr: () => {},
      policy: { stableAcquireBudgetMs: 0 },
    });
    const second = await createLogger({
      boundWorkspace: '/w',
      baseDir: tmp,
      runId: '33333333333333333333333333333333',
      stderr: () => {},
      policy: { stableAcquireBudgetMs: 0 },
    });
    expect(first.getStatus().mode).toBe('fallback');
    expect(second.getStatus().mode).toBe('fallback');
    if (process.platform !== 'win32') {
      expect(lstatSync(path.dirname(first.getLogPath())).mode & 0o777).toBe(
        0o700,
      );
      expect(
        lstatSync(path.join(path.dirname(first.getLogPath()), '.owner.lock'))
          .mode & 0o777,
      ).toBe(0o700);
      expect(lstatSync(first.getLogPath()).mode & 0o777).toBe(0o600);
    }

    await first.close();
    const runsDir = path.join(tmp, 'daemon', 'runs');
    expect(readdirSync(runsDir)).toEqual(
      expect.arrayContaining([
        'run-22222222222222222222222222222222',
        'run-33333333333333333333333333333333',
      ]),
    );
    await second.close();
    expect(
      readdirSync(runsDir).filter((name) => name.startsWith('run-')),
    ).toEqual(['run-33333333333333333333333333333333']);
    expect(readFileSync(path.join(runsDir, 'recent-fallback'), 'utf8')).toBe(
      'run-33333333333333333333333333333333\n',
    );
    await stable.close();
  });

  it('reclaims a stale fallback owner instead of treating it as live', async () => {
    const stable = await createLogger({
      boundWorkspace: '/w',
      baseDir: tmp,
      runId: '11111111111111111111111111111111',
      stderr: () => {},
      policy: { stableAcquireBudgetMs: 0 },
    });
    const runsDir = path.join(tmp, 'daemon', 'runs');
    const staleFamily = path.join(
      runsDir,
      'run-22222222222222222222222222222222',
    );
    const staleLock = path.join(staleFamily, '.owner.lock');
    await fsPromises.mkdir(staleLock, { recursive: true, mode: 0o700 });
    await fsPromises.writeFile(path.join(staleFamily, 'daemon.log'), 'old\n');
    const old = new Date(Date.now() - 10_000);
    await fsPromises.utimes(staleLock, old, old);

    const fallback = await createLogger({
      boundWorkspace: '/w',
      baseDir: tmp,
      runId: '33333333333333333333333333333333',
      stderr: () => {},
      policy: {
        stableAcquireBudgetMs: 0,
        lockStaleMs: 2_000,
        lockUpdateMs: 1_000,
      },
    });

    expect(fallback.getStatus().mode).toBe('fallback');
    expect(existsSync(staleLock)).toBe(false);
    await fallback.close();
    await stable.close();
  });

  it('refuses a new fallback family when cleanup fails', async () => {
    const stable = await createLogger({
      boundWorkspace: '/w',
      baseDir: tmp,
      runId: '11111111111111111111111111111111',
      stderr: () => {},
      policy: { stableAcquireBudgetMs: 0 },
    });
    const inactive = await createLogger({
      boundWorkspace: '/w',
      baseDir: tmp,
      runId: '22222222222222222222222222222222',
      stderr: () => {},
      policy: { stableAcquireBudgetMs: 0 },
    });
    await inactive.close();
    const extraDir = path.join(
      tmp,
      'daemon',
      'runs',
      'run-33333333333333333333333333333333',
    );
    await fsPromises.mkdir(extraDir, { mode: 0o700 });
    await fsPromises.writeFile(path.join(extraDir, 'daemon.log'), 'old\n');

    const logger = await createLogger({
      boundWorkspace: '/w',
      baseDir: tmp,
      runId: '44444444444444444444444444444444',
      stderr: () => {},
      policy: { stableAcquireBudgetMs: 0 },
      fs: {
        ...fsPromises,
        rm: async (target, options) => {
          if (String(target) === extraDir) throw new Error('cleanup failed');
          return fsPromises.rm(target, options);
        },
      },
    });
    expect(logger.getStatus()).toMatchObject({
      mode: 'stderr-only',
      health: 'degraded',
      issues: ['init_failed'],
    });
    expect(
      existsSync(
        path.join(
          tmp,
          'daemon',
          'runs',
          'run-44444444444444444444444444444444',
        ),
      ),
    ).toBe(false);
    await stable.close();
  });

  it('does not delete an existing live family when a run id collides', async () => {
    const stable = await createLogger({
      boundWorkspace: '/w',
      baseDir: tmp,
      runId: '11111111111111111111111111111111',
      stderr: () => {},
      policy: { stableAcquireBudgetMs: 0 },
    });
    const live = await createLogger({
      boundWorkspace: '/w',
      baseDir: tmp,
      runId: '22222222222222222222222222222222',
      stderr: () => {},
      policy: { stableAcquireBudgetMs: 0 },
    });
    const livePath = live.getLogPath();

    const collided = await createLogger({
      boundWorkspace: '/w',
      baseDir: tmp,
      runId: '22222222222222222222222222222222',
      stderr: () => {},
      policy: { stableAcquireBudgetMs: 0 },
    });

    expect(collided.getStatus()).toMatchObject({
      mode: 'stderr-only',
      health: 'degraded',
      issues: ['init_failed'],
    });
    expect(existsSync(path.dirname(livePath))).toBe(true);
    live.info('still owned');
    await live.flush();
    expect(readFileSync(livePath, 'utf8')).toContain('still owned');
    await live.close();
    await stable.close();
  });

  it('does not allocate a family after the maintenance lease is compromised', async () => {
    let acquireCalls = 0;
    const releaseMaintenance = vi.fn(async () => {});
    const logger = await createLogger({
      boundWorkspace: '/w',
      baseDir: tmp,
      runId: '11111111111111111111111111111111',
      stderr: () => {},
      policy: { stableAcquireBudgetMs: 0 },
      fs: { ...fsPromises, chmod: async () => {} },
      acquireLock: vi.fn(async (_target: string, options: unknown) => {
        acquireCalls += 1;
        if (acquireCalls === 1) {
          throw Object.assign(new Error('stable busy'), { code: 'ELOCKED' });
        }
        (options as { onCompromised: (error: Error) => void }).onCompromised(
          new Error('maintenance lost'),
        );
        return releaseMaintenance;
      }) as never,
    });

    expect(logger.getStatus()).toMatchObject({
      mode: 'stderr-only',
      health: 'degraded',
      issues: ['init_failed'],
    });
    expect(
      readdirSync(path.join(tmp, 'daemon', 'runs')).filter((name) =>
        name.startsWith('run-'),
      ),
    ).toEqual([]);
    expect(releaseMaintenance).toHaveBeenCalledOnce();
  });
});
