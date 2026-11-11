/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CliArgs } from '../config/config.js';
import type { StartupMode } from './determineStartupMode.js';
import { shouldEagerPreloadInteractiveUI } from './startupPreload.js';

describe('shouldEagerPreloadInteractiveUI', () => {
  let stdinIsTTYDescriptor: PropertyDescriptor | undefined;
  let stdoutIsTTYDescriptor: PropertyDescriptor | undefined;

  const interactiveMode: StartupMode = { kind: 'interactive' };

  function argv(overrides: Partial<CliArgs> = {}): CliArgs {
    return {
      prompt: undefined,
      promptInteractive: undefined,
      query: undefined,
      model: undefined,
      debug: undefined,
      permissionMode: undefined,
      allowedMcpServerNames: undefined,
      tools: undefined,
      extensions: undefined,
      listExtensions: undefined,
      continue: undefined,
      forkSession: undefined,
      resume: undefined,
      remote: undefined,
      remoteSession: undefined,
      listSessions: undefined,
      listModels: undefined,
      deleteSession: undefined,
      addDir: undefined,
      screenReader: undefined,
      alternateBuffer: undefined,
      outputFormat: undefined,
      inputFormat: undefined,
      print: undefined,
      fakeResponses: undefined,
      recordResponses: undefined,
      rawOutput: undefined,
      acceptRawOutputRisk: undefined,
      isCommand: undefined,
      ...overrides,
    } as CliArgs;
  }

  beforeEach(() => {
    vi.stubEnv('CI', '');
    vi.stubEnv('GITHUB_ACTIONS', '');
    stdinIsTTYDescriptor = Object.getOwnPropertyDescriptor(
      process.stdin,
      'isTTY',
    );
    stdoutIsTTYDescriptor = Object.getOwnPropertyDescriptor(
      process.stdout,
      'isTTY',
    );
    Object.defineProperty(process.stdin, 'isTTY', {
      configurable: true,
      value: true,
    });
    Object.defineProperty(process.stdout, 'isTTY', {
      configurable: true,
      value: true,
    });
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    restoreProperty(process.stdin, 'isTTY', stdinIsTTYDescriptor);
    restoreProperty(process.stdout, 'isTTY', stdoutIsTTYDescriptor);
  });

  function restoreProperty(
    target: object,
    key: PropertyKey,
    descriptor: PropertyDescriptor | undefined,
  ): void {
    if (descriptor) {
      Object.defineProperty(target, key, descriptor);
      return;
    }

    Reflect.deleteProperty(target, key);
  }

  it('allows early preload for an ordinary TUI startup', () => {
    expect(
      shouldEagerPreloadInteractiveUI(interactiveMode, argv()),
    ).toBe(true);
  });

  it.each([
    ['--prompt', { prompt: 'hello' }],
    ['--print', { print: true }],
    ['stream-json input', { inputFormat: 'stream-json' }],
    ['--list-sessions', { listSessions: true }],
    ['--list-extensions', { listExtensions: true }],
    ['--list-models', { listModels: true }],
    ['--delete-session', { deleteSession: '1' }],
    ['--output-format=json', { outputFormat: 'json' }],
    ['--output-format=stream-json', { outputFormat: 'stream-json' }],
    ['--raw-output', { rawOutput: true }],
    ['--accept-raw-output-risk', { acceptRawOutputRisk: true }],
    ['--include-partial-messages', { includePartialMessages: true }],
    ['--replay-user-messages', { replayUserMessages: true }],
    ['--headless-fast-hooks', { headlessFastHooks: true }],
  ] as const)('blocks early preload for %s', (_name, overrides) => {
    expect(
      shouldEagerPreloadInteractiveUI(interactiveMode, argv(overrides)),
    ).toBe(false);
  });

  it('blocks early preload when stdout is not a TTY', () => {
    Object.defineProperty(process.stdout, 'isTTY', {
      configurable: true,
      value: false,
    });

    expect(
      shouldEagerPreloadInteractiveUI(interactiveMode, argv()),
    ).toBe(false);
  });

  it('blocks early preload for non-interactive startup modes', () => {
    expect(
      shouldEagerPreloadInteractiveUI(
        { kind: 'headless' },
        argv(),
      ),
    ).toBe(false);
  });
});
