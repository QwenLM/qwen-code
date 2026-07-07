/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  computeWindowTitle,
  writeTerminalTitle,
  formatSessionWindowTitle,
} from './windowTitle.js';

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

  it('should fall back to default when folderName is empty string', () => {
    const result = computeWindowTitle('');
    expect(result).toBe('Qwen - qwen');
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
    // Stub multiplexer env vars to ensure non-multiplexer path is taken
    vi.stubEnv('TMUX', undefined);
    vi.stubEnv('STY', undefined);
    vi.stubEnv('ZELLIJ', undefined);
    vi.stubEnv('DVTM', undefined);
    const write = vi.fn();

    writeTerminalTitle(write, 'Fix terminal title');

    const padded = 'Fix terminal title'.padEnd(80, ' ');
    expect(write).toHaveBeenCalledWith(
      `\x1b]0;${padded}\x07\x1b]2;${padded}\x07`,
    );
  });

  it('should pad short titles to 80 characters', () => {
    vi.stubEnv('TMUX', undefined);
    vi.stubEnv('STY', undefined);
    vi.stubEnv('ZELLIJ', undefined);
    vi.stubEnv('DVTM', undefined);
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

    expect(write).toHaveBeenCalledWith(`\x1b]2;test\x07`);
  });

  it('should only write OSC 2 inside screen', () => {
    vi.stubEnv('STY', '12345.pts-0.host');
    const write = vi.fn();

    writeTerminalTitle(write, 'test');

    expect(write).toHaveBeenCalledWith(`\x1b]2;test\x07`);
  });

  it('should only write OSC 2 inside Zellij', () => {
    vi.stubEnv('ZELLIJ', '1');
    const write = vi.fn();

    writeTerminalTitle(write, 'test');

    expect(write).toHaveBeenCalledWith(`\x1b]2;test\x07`);
  });

  it('should only write OSC 2 inside dvtm', () => {
    vi.stubEnv('DVTM', '1');
    const write = vi.fn();

    writeTerminalTitle(write, 'test');

    expect(write).toHaveBeenCalledWith(`\x1b]2;test\x07`);
  });

  it('should truncate titles longer than 80 characters', () => {
    vi.stubEnv('TMUX', undefined);
    vi.stubEnv('STY', undefined);
    vi.stubEnv('ZELLIJ', undefined);
    vi.stubEnv('DVTM', undefined);
    const write = vi.fn();
    const longTitle = 'A'.repeat(120);

    writeTerminalTitle(write, longTitle);

    const expected = 'A'.repeat(80);
    expect(write).toHaveBeenCalledWith(
      `\x1b]0;${expected}\x07\x1b]2;${expected}\x07`,
    );
  });

  it('should write empty OSC sequences without padding for empty title', () => {
    vi.stubEnv('TMUX', undefined);
    vi.stubEnv('STY', undefined);
    vi.stubEnv('ZELLIJ', undefined);
    vi.stubEnv('DVTM', undefined);
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

describe('formatSessionWindowTitle', () => {
  beforeEach(() => {
    vi.stubEnv('CLI_TITLE', undefined);
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('should return session name when set', () => {
    expect(formatSessionWindowTitle('Fix terminal title')).toBe(
      'Fix terminal title',
    );
  });

  it('should fall back to computeWindowTitle when sessionName is null', () => {
    expect(formatSessionWindowTitle(null, 'my-project')).toBe(
      'Qwen - my-project',
    );
  });

  it('should prefer CLI_TITLE over folder name when sessionName is null', () => {
    vi.stubEnv('CLI_TITLE', 'Custom Title');
    expect(formatSessionWindowTitle(null, 'my-project')).toBe('Custom Title');
  });

  it('should sanitize control characters from session name', () => {
    expect(formatSessionWindowTitle('Bad\x07Title')).toBe('BadTitle');
  });

  it('should use default title when sessionName is null and no folder', () => {
    expect(formatSessionWindowTitle(null)).toBe('Qwen - qwen');
  });
});
