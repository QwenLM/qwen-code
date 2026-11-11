/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { ENV_AGENT_SDK_ENTRYPOINT } from "@qwen-code/core";

import { afterEach, describe, expect, it, vi } from 'vitest';
import type { CliArgs } from '../config/config.js';
import { determineStartupMode as resolveStartupMode } from './determineStartupMode.js';

const DEFAULT_CLI_ARGS = {
  query: undefined,
  model: undefined,
  debug: undefined,
  prompt: undefined,
  promptInteractive: undefined,
  permissionMode: undefined,
  allowedMcpServerNames: undefined,
  tools: undefined,
  extensions: undefined,
  listExtensions: undefined,
  resume: undefined,
  listSessions: undefined,
  listModels: undefined,
  deleteSession: undefined,
  addDir: undefined,
  screenReader: undefined,
  alternateBuffer: undefined,
  outputFormat: undefined,
  inputFormat: undefined,
  fakeResponses: undefined,
  recordResponses: undefined,
  rawOutput: undefined,
  acceptRawOutputRisk: undefined,
} satisfies CliArgs;

function determine(argv: Partial<CliArgs> = {}) {
  return resolveStartupMode({ ...DEFAULT_CLI_ARGS, ...argv });
}

describe('determineStartupMode', () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('treats bare as a headless mode, not an SDK worker signal', () => {
    expect(determine({ bare: true, print: true })).toStrictEqual({
      kind: 'headless',
    });
  });

  it('detects the product daemon mode from the product-supplied flag', () => {
    expect(determine({ sdk: true })).toStrictEqual({
      kind: 'daemon',
    });
  });

  it('lets the open-source CLI ignore the legacy SDK entrypoint env', () => {
    vi.stubEnv(ENV_AGENT_SDK_ENTRYPOINT, '/tmp/sdk-entrypoint');
    expect(
      determine({
        print: true,
        inputFormat: 'stream-json',
        outputFormat: 'stream-json',
      }),
    ).toStrictEqual({ kind: 'headless' });
  });

  it('detects headless stream-json input as a documented headless mode', () => {
    expect(
      determine({
        print: true,
        inputFormat: 'stream-json',
        outputFormat: 'stream-json',
      }),
    ).toStrictEqual({ kind: 'headless' });
    expect(determine({ inputFormat: 'stream-json' })).toStrictEqual({
      kind: 'headless',
    });
  });

  it('detects ACP mode from --acp', () => {
    expect(determine({ acp: true })).toStrictEqual({ kind: 'acp' });
  });

  it('detects headless mode from --print', () => {
    expect(determine({ print: true })).toStrictEqual({ kind: 'headless' });
  });

  it('detects headless mode from legacy --prompt', () => {
    expect(determine({ prompt: 'hello' })).toStrictEqual({ kind: 'headless' });
  });

  it('defaults to interactive mode when stdio is attached to a TTY', () => {
    vi.stubEnv('CI', 'false');
    vi.stubEnv('GITHUB_ACTIONS', 'false');
    const stdinIsTTY = process.stdin.isTTY;
    const stdoutIsTTY = process.stdout.isTTY;
    Object.defineProperty(process.stdin, 'isTTY', {
      configurable: true,
      value: true,
    });
    Object.defineProperty(process.stdout, 'isTTY', {
      configurable: true,
      value: true,
    });

    try {
      expect(determine({})).toStrictEqual({ kind: 'interactive' });
    } finally {
      Object.defineProperty(process.stdin, 'isTTY', {
        configurable: true,
        value: stdinIsTTY,
      });
      Object.defineProperty(process.stdout, 'isTTY', {
        configurable: true,
        value: stdoutIsTTY,
      });
    }
  });

  it('detects a default invocation with non-TTY stdin as headless', () => {
    vi.stubEnv('CI', 'false');
    vi.stubEnv('GITHUB_ACTIONS', 'false');
    const stdinIsTTY = process.stdin.isTTY;
    const stdoutIsTTY = process.stdout.isTTY;
    Object.defineProperty(process.stdin, 'isTTY', {
      configurable: true,
      value: false,
    });
    Object.defineProperty(process.stdout, 'isTTY', {
      configurable: true,
      value: true,
    });

    try {
      expect(determine({})).toStrictEqual({ kind: 'headless' });
    } finally {
      Object.defineProperty(process.stdin, 'isTTY', {
        configurable: true,
        value: stdinIsTTY,
      });
      Object.defineProperty(process.stdout, 'isTTY', {
        configurable: true,
        value: stdoutIsTTY,
      });
    }
  });

  it('prioritizes daemon over ACP and headless modes', () => {
    vi.stubEnv(ENV_AGENT_SDK_ENTRYPOINT, 'sdk-ts');
    expect(
      determine({
        sdk: true,
        acp: true,
        print: true,
        inputFormat: 'stream-json',
        outputFormat: 'stream-json',
      }),
    ).toStrictEqual({ kind: 'daemon' });
  });

  it('prioritizes ACP over stream-json input', () => {
    vi.stubEnv(ENV_AGENT_SDK_ENTRYPOINT, '/tmp/sdk-entrypoint');
    expect(
      determine({
        acp: true,
        print: true,
        inputFormat: 'stream-json',
        outputFormat: 'stream-json',
      }),
    ).toStrictEqual({ kind: 'acp' });
  });

  it('prioritizes headless over interactive', () => {
    expect(determine({ print: true })).toStrictEqual({ kind: 'headless' });
    expect(determine({ prompt: '/help' })).toStrictEqual({ kind: 'headless' });
  });
});
