/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import {
  finalizeProgramStatus,
  releaseProgramStatus,
  reportProgramStatus,
  resendProgramStatus,
  resetProgramStatusForTest,
  restoreProgramStatus,
} from './program-status.js';
import { oscProgramStatus, oscProgramStatusClear } from './osc.js';

describe('program status reporter', () => {
  const write = vi.fn();
  let savedIsTTY: boolean | undefined;

  beforeEach(() => {
    savedIsTTY = process.stdout.isTTY;
    process.stdout.isTTY = true;
    write.mockReset();
    resetProgramStatusForTest();
  });
  afterEach(() => {
    process.stdout.isTTY = savedIsTTY as boolean;
  });

  it('writes a report once and skips unchanged ones', () => {
    reportProgramStatus({ state: 'working' }, write);
    reportProgramStatus({ state: 'working' }, write);
    reportProgramStatus({ state: 'done' }, write);
    expect(write.mock.calls).toEqual([
      [oscProgramStatus({ state: 'working' })],
      [oscProgramStatus({ state: 'done' })],
    ]);
  });

  it('writes nothing when stdout is not a TTY', () => {
    process.stdout.isTTY = false;
    reportProgramStatus({ state: 'working' }, write);
    releaseProgramStatus(write);
    restoreProgramStatus(write);
    finalizeProgramStatus(write);
    expect(write).not.toHaveBeenCalled();
  });

  it('retries after a failed write', () => {
    write.mockImplementationOnce(() => {
      throw new Error('EAGAIN');
    });
    reportProgramStatus({ state: 'working' }, write);
    reportProgramStatus({ state: 'working' }, write);
    expect(write).toHaveBeenCalledTimes(2);
  });

  it('clears on release and writes the latest record on restore', () => {
    reportProgramStatus({ state: 'working' }, write);
    releaseProgramStatus(write);
    reportProgramStatus({ state: 'blocked', kind: 'question' }, write);
    restoreProgramStatus(write);
    expect(write.mock.calls).toEqual([
      [oscProgramStatus({ state: 'working' })],
      [oscProgramStatusClear()],
      [oscProgramStatus({ state: 'blocked', kind: 'question' })],
    ]);
  });

  it('resend rewrites an unchanged record', () => {
    reportProgramStatus({ state: 'working' }, write);
    resendProgramStatus(write);
    expect(write).toHaveBeenCalledTimes(2);
  });

  it.each(['idle', 'working', 'blocked'] as const)(
    'clears a %s record on exit',
    (state) => {
      reportProgramStatus({ state }, write);
      finalizeProgramStatus(write);
      expect(write).toHaveBeenLastCalledWith(oscProgramStatusClear());
    },
  );

  it.each(['done', 'error'] as const)('keeps a %s record on exit', (state) => {
    reportProgramStatus({ state }, write);
    finalizeProgramStatus(write);
    expect(write).toHaveBeenCalledTimes(1);
  });
});
