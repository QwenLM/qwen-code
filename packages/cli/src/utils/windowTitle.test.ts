/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { computeWindowTitle, writeTerminalTitle } from './windowTitle.js';

describe('computeWindowTitle', () => {
  let originalEnv: NodeJS.ProcessEnv;

  beforeEach(() => {
    originalEnv = process.env;
    vi.stubEnv('CLI_TITLE', undefined);
  });

  afterEach(() => {
    process.env = originalEnv;
  });

  it('should use default Qwen title when CLI_TITLE is not set', () => {
    const result = computeWindowTitle();
    expect(result).toBe('Qwen - qwen');
  });

  it('should use CLI_TITLE environment variable when set', () => {
    vi.stubEnv('CLI_TITLE', 'Custom Title');
    const result = computeWindowTitle();
    expect(result).toBe('Custom Title');
  });

  it('should use Qwen prefix with folder name when CLI_TITLE is not set', () => {
    const result = computeWindowTitle('my-project');
    expect(result).toBe('Qwen - my-project');
  });

  it('should prefer CLI_TITLE over folder name', () => {
    vi.stubEnv('CLI_TITLE', 'Custom Title');
    const result = computeWindowTitle('my-project');
    expect(result).toBe('Custom Title');
  });

  it('should remove C0 control characters from title', () => {
    vi.stubEnv('CLI_TITLE', 'Title\x1b[31m with \x07 control chars');
    const result = computeWindowTitle();
    // The \x1b[31m (ANSI escape sequence) and \x07 (bell character) should be removed
    expect(result).toBe('Title[31m with  control chars');
  });

  it('should remove C1 control characters from title', () => {
    vi.stubEnv('CLI_TITLE', 'Title\x9C with \x90 C1\x9F control');
    const result = computeWindowTitle();
    expect(result).toBe('Title with  C1 control');
  });
});

describe('writeTerminalTitle', () => {
  beforeEach(() => {
    vi.unstubAllEnvs();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('should write both common terminal title sequences with 80-char padding', () => {
    const write = vi.fn();

    writeTerminalTitle(write, 'Fix terminal title');

    const padded = 'Fix terminal title'.padEnd(80, ' ');
    expect(write).toHaveBeenCalledWith(
      `\x1b]0;${padded}\x07\x1b]2;${padded}\x07`,
    );
  });

  it('should pad short titles to 80 characters', () => {
    const write = vi.fn();

    writeTerminalTitle(write, 'qwen');

    const padded = 'qwen'.padEnd(80, ' ');
    expect(write).toHaveBeenCalledWith(
      `\x1b]0;${padded}\x07\x1b]2;${padded}\x07`,
    );
  });

  it('should only write OSC 2 inside tmux', () => {
    vi.stubEnv('TMUX', '/tmp/tmux-0/default');
    const write = vi.fn();

    writeTerminalTitle(write, 'test');

    const padded = 'test'.padEnd(80, ' ');
    expect(write).toHaveBeenCalledWith(`\x1b]2;${padded}\x07`);
  });

  it('should only write OSC 2 inside screen', () => {
    vi.stubEnv('STY', '12345.pts-0.host');
    const write = vi.fn();

    writeTerminalTitle(write, 'test');

    const padded = 'test'.padEnd(80, ' ');
    expect(write).toHaveBeenCalledWith(`\x1b]2;${padded}\x07`);
  });

  it('should truncate titles longer than 80 characters', () => {
    const write = vi.fn();
    const longTitle = 'A'.repeat(120);

    writeTerminalTitle(write, longTitle);

    const expected = 'A'.repeat(80);
    expect(write).toHaveBeenCalledWith(
      `\x1b]0;${expected}\x07\x1b]2;${expected}\x07`,
    );
  });

  it('should write empty OSC sequences without padding for empty title', () => {
    const write = vi.fn();

    writeTerminalTitle(write, '');

    expect(write).toHaveBeenCalledWith('\x1b]0;\x07\x1b]2;\x07');
  });

  it('should write empty OSC 2 sequence inside tmux for empty title', () => {
    vi.stubEnv('TMUX', '/tmp/tmux-0/default');
    const write = vi.fn();

    writeTerminalTitle(write, '');

    expect(write).toHaveBeenCalledWith('\x1b]2;\x07');
  });
});
