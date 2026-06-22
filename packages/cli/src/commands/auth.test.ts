/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import yargs from 'yargs';
import { authCommand, buildRemovalNotice, printRemovalNotice } from './auth.js';

describe('auth command', () => {
  const originalNoColor = process.env['NO_COLOR'];
  const originalIsTTY = process.stdout.isTTY;

  beforeEach(() => {
    process.env['NO_COLOR'] = '1';
    Object.defineProperty(process.stdout, 'isTTY', {
      value: false,
      configurable: true,
    });
  });

  afterEach(() => {
    if (originalNoColor === undefined) {
      delete process.env['NO_COLOR'];
    } else {
      process.env['NO_COLOR'] = originalNoColor;
    }
    Object.defineProperty(process.stdout, 'isTTY', {
      value: originalIsTTY,
      configurable: true,
    });
    vi.restoreAllMocks();
  });

  it('builds a removal notice with migration paths and no ANSI in non-TTY', () => {
    const notice = buildRemovalNotice();

    expect(notice).toContain('qwen auth has been removed');
    expect(notice).toContain('/auth');
    expect(notice).toContain('/doctor');
    expect(notice).toContain('BAILIAN_CODING_PLAN_API_KEY');
    expect(notice).toContain('https://coding.dashscope.aliyuncs.com/v1');
    expect(notice).toContain('https://coding-intl.dashscope.aliyuncs.com/v1');
    expect(notice).toContain('OPENROUTER_API_KEY');
    expect(notice).not.toContain('\x1b[');
    expect(notice).not.toContain('v0.15.8');
  });

  it('writes the notice before exiting', () => {
    const exit = vi.spyOn(process, 'exit').mockImplementation((() => {
      throw new Error('exit');
    }) as never);
    const write = vi.spyOn(process.stdout, 'write').mockImplementation(((
      _chunk: unknown,
      callback?: () => void,
    ) => {
      callback?.();
      return true;
    }) as never);

    expect(() => printRemovalNotice()).toThrow('exit');

    expect(write).toHaveBeenCalledWith(
      expect.any(String),
      expect.any(Function),
    );
    expect(exit).toHaveBeenCalledWith(0);
  });

  it.each([
    ['auth'],
    ['auth status'],
    ['auth api-key'],
    ['auth qwen-oauth'],
    ['auth openrouter --key test-key'],
    ['auth coding-plan --region china --key sk-sp-test'],
    ['auth --key test-key'],
  ])('routes `%s` to the removal notice', async (command) => {
    const exit = vi
      .spyOn(process, 'exit')
      .mockImplementation((() => undefined) as never);
    const write = vi.spyOn(process.stdout, 'write').mockImplementation(((
      _chunk: unknown,
      callback?: () => void,
    ) => {
      callback?.();
      return true;
    }) as never);

    await yargs(command.split(' '))
      .scriptName('qwen')
      .command(authCommand)
      .strict()
      .fail((message, error) => {
        throw error ?? new Error(message);
      })
      .parseAsync();

    expect(write).toHaveBeenCalledWith(
      expect.any(String),
      expect.any(Function),
    );
    expect(exit).toHaveBeenCalledWith(0);
  });
});
