/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import {
  isShellResultDisplay,
  mapShellResultText,
  type ShellResultDisplay,
} from './shell-result.js';
import { compactToolResultDisplayForRecording } from './toolResultDisplayCompaction.js';

const result: ShellResultDisplay = {
  type: 'shell_result',
  version: 1,
  text: 'display',
  output: '(empty)',
  directory: '/tmp',
  exitCode: 0,
  signal: null,
  pid: 123,
  error: null,
  outcome: 'completed',
  notices: [],
  truncated: false,
  outputFiles: ['/tmp/output.log'],
};

describe('structured shell result', () => {
  it('validates fields without interpreting output', () => {
    expect(isShellResultDisplay(result)).toBe(true);
    expect(isShellResultDisplay({ ...result, version: 2 })).toBe(false);
    expect(isShellResultDisplay({ ...result, outcome: ['completed'] })).toBe(
      false,
    );
    expect(isShellResultDisplay({ ...result, exitCode: '0' })).toBe(false);
    expect(compactToolResultDisplayForRecording(result)).toEqual(result);
  });
  it('projects only declared fields without mutating the input', () => {
    const source = { ...result, internalPayload: 'x'.repeat(200_000) };
    expect(mapShellResultText(source, (text) => text)).toEqual(result);
    expect(source.internalPayload.length).toBe(200_000);
  });
  it('bounds recorded text while preserving execution metadata and source', () => {
    const source = {
      ...result,
      output: 'x'.repeat(100_000),
      notices: ['n'.repeat(100_000)],
    };
    const compacted = compactToolResultDisplayForRecording(source);
    expect(isShellResultDisplay(compacted)).toBe(true);
    if (!isShellResultDisplay(compacted))
      throw new Error('lost structured result');
    expect(compacted.output.length).toBeLessThan(100_000);
    expect(compacted.notices[0].length).toBeLessThan(100_000);
    expect(compacted).toMatchObject({
      outcome: 'completed',
      exitCode: 0,
      outputFiles: result.outputFiles,
      truncated: true,
    });
    expect(source.output.length).toBe(100_000);
    expect(source.truncated).toBe(false);
  });
});
