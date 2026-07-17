/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import type * as vscode from 'vscode';
import { redactLogCredentials } from '@qwen-code/acp-bridge/logRedaction';
import { createLogger, isLogLevel, logger, resetLoggerSink } from './logger.js';

function createOutputChannel() {
  const appendLine = vi.fn();
  return {
    appendLine,
    outputChannel: { appendLine } as unknown as vscode.OutputChannel,
  };
}

describe('logger', () => {
  afterEach(() => {
    resetLoggerSink();
  });

  it('formats errors and objects without exposing sensitive fields', () => {
    const { appendLine, outputChannel } = createOutputChannel();
    createLogger(outputChannel);
    const details: Record<string, unknown> = {
      apiKey: 'secret',
      count: 2n,
    };
    details['self'] = details;

    logger.error('Request failed:', new Error('boom'), details);

    const line = vi.mocked(appendLine).mock.calls[0][0] as string;
    expect(line).toContain('[ERROR] Request failed: Error: boom');
    expect(line).toContain('"apiKey":"<redacted>"');
    expect(line).toContain('"count":"2n"');
    expect(line).toContain('"self":"[Circular]"');
    expect(line).not.toContain('secret');
  });

  it('redacts credentials from the final rendered line', () => {
    const { appendLine, outputChannel } = createOutputChannel();
    createLogger(outputChannel, redactLogCredentials);

    logger.info(
      'ACP stderr:',
      new Error('Authorization: Bearer live-token-1234567890'),
    );

    const line = vi.mocked(appendLine).mock.calls[0][0] as string;
    expect(line).toContain('Authorization: <redacted>');
    expect(line).not.toContain('live-token-1234567890');
  });

  it('restores console logging when the output channel is disposed', () => {
    const { outputChannel } = createOutputChannel();
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    createLogger(outputChannel);

    resetLoggerSink();
    logger.warn('late shutdown warning');

    expect(warn).toHaveBeenCalledWith('late shutdown warning');
  });

  it('guards log levels from webview messages', () => {
    expect(isLogLevel('error')).toBe(true);
    expect(isLogLevel('trace')).toBe(false);
    expect(isLogLevel(undefined)).toBe(false);
  });

  it('falls back to console when the output channel write fails', () => {
    const outputChannel = {
      appendLine: vi.fn(() => {
        throw new Error('disposed');
      }),
    } as unknown as vscode.OutputChannel;
    const error = vi
      .spyOn(console, 'error')
      .mockImplementation(() => undefined);
    createLogger(outputChannel);

    logger.error('late failure');

    expect(error).toHaveBeenCalledWith('late failure');
  });
});
