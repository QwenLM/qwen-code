/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  closeFleetLogFd,
  describeWorkerExit,
  FLEET_LOG_TAIL_BYTES,
  isFleetDebugEnabled,
  openFleetLogFd,
  readFleetLogTail,
} from './fleet-debug.js';

let tempDir: string;

beforeEach(() => {
  tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'fleet-debug-'));
});

afterEach(() => {
  fs.rmSync(tempDir, { recursive: true, force: true });
});

describe('isFleetDebugEnabled', () => {
  it('treats unset, empty and 0 as disabled', () => {
    expect(isFleetDebugEnabled({})).toBe(false);
    expect(isFleetDebugEnabled({ QWEN_FLEET_DEBUG: '' })).toBe(false);
    expect(isFleetDebugEnabled({ QWEN_FLEET_DEBUG: '0' })).toBe(false);
  });

  it('treats any other value as enabled', () => {
    expect(isFleetDebugEnabled({ QWEN_FLEET_DEBUG: '1' })).toBe(true);
    expect(isFleetDebugEnabled({ QWEN_FLEET_DEBUG: 'true' })).toBe(true);
  });
});

describe('openFleetLogFd', () => {
  it('creates the directory, truncates and seeds a header', () => {
    const logPath = path.join(tempDir, 'nested', 'worker.log');
    fs.mkdirSync(path.dirname(logPath), { recursive: true });
    fs.writeFileSync(logPath, 'stale output from an earlier run');

    const fd = openFleetLogFd(logPath, { sessionId: 'agent-1' });
    expect(fd).toBeTypeOf('number');
    closeFleetLogFd(fd);

    const contents = fs.readFileSync(logPath, 'utf8');
    expect(contents).not.toContain('stale output');
    expect(contents).toContain('log opened');
    expect(contents).toContain('sessionId=agent-1');
  });

  it('returns undefined rather than throwing when the log cannot be opened', () => {
    // A directory in place of the log file: open() fails, and Fleet must still
    // be able to spawn the worker.
    const logPath = path.join(tempDir, 'worker.log');
    fs.mkdirSync(logPath);
    expect(openFleetLogFd(logPath)).toBeUndefined();
  });
});

describe('readFleetLogTail', () => {
  it('returns undefined for a missing or empty log', async () => {
    await expect(
      readFleetLogTail(path.join(tempDir, 'absent.log')),
    ).resolves.toBeUndefined();
    const empty = path.join(tempDir, 'empty.log');
    fs.writeFileSync(empty, '');
    await expect(readFleetLogTail(empty)).resolves.toBeUndefined();
  });

  it('returns the whole log when it is small', async () => {
    const logPath = path.join(tempDir, 'worker.log');
    fs.writeFileSync(logPath, 'Error: no auth configured\n');
    await expect(readFleetLogTail(logPath)).resolves.toBe(
      'Error: no auth configured',
    );
  });

  it('keeps the tail, not the head, of an oversized log', async () => {
    const logPath = path.join(tempDir, 'worker.log');
    fs.writeFileSync(
      logPath,
      `${'x'.repeat(FLEET_LOG_TAIL_BYTES * 2)}THE-ACTUAL-ERROR`,
    );
    const tail = await readFleetLogTail(logPath);
    expect(tail).toContain('THE-ACTUAL-ERROR');
    expect(tail?.startsWith('…')).toBe(true);
    expect(tail!.length).toBeLessThanOrEqual(FLEET_LOG_TAIL_BYTES + 1);
  });
});

describe('describeWorkerExit', () => {
  it('names the exit code and always names the log path', () => {
    const message = describeWorkerExit(3, '/jobs/a/worker.log');
    expect(message).toContain('exit code 3');
    expect(message).toContain('/jobs/a/worker.log');
  });

  it('reports a signal kill distinctly from a zero exit', () => {
    expect(describeWorkerExit(null, '/jobs/a/worker.log')).toContain(
      'terminated by signal',
    );
  });

  it('keeps the first line self-sufficient so a one-line UI stays useful', () => {
    const message = describeWorkerExit(1, '/jobs/a/worker.log', 'boom');
    const [firstLine] = message.split('\n');
    expect(firstLine).toContain('exit code 1');
    expect(firstLine).toContain('/jobs/a/worker.log');
    expect(message).toContain('boom');
  });
});
