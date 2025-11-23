/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { createLogger } from './logger.js';

vi.mock('vscode', () => ({
  ExtensionMode: {
    Development: 1,
    Production: 2,
    Test: 3,
  },
}));

import * as vscode from 'vscode';

describe('logger', () => {
  let mockOutputChannel: vscode.OutputChannel;

  beforeEach(() => {
    mockOutputChannel = {
      appendLine: vi.fn(),
    } as unknown as vscode.OutputChannel;
  });

  it('should log messages when extension mode is Development', () => {
    // Create a proper mock context with configurable extensionMode
    const context = Object.create(null);
    Object.defineProperty(context, 'extensionMode', {
      value: vscode.ExtensionMode.Development,
      writable: true,
      configurable: true,
    });

    const log = createLogger(context, mockOutputChannel);
    const message = 'Test message';

    log(message);

    expect(mockOutputChannel.appendLine).toHaveBeenCalledWith(message);
  });

  it('should not log messages when extension mode is Production', () => {
    const context = Object.create(null);
    Object.defineProperty(context, 'extensionMode', {
      value: vscode.ExtensionMode.Production,
      writable: true,
      configurable: true,
    });

    const log = createLogger(context, mockOutputChannel);
    const message = 'Test message';

    log(message);

    expect(mockOutputChannel.appendLine).not.toHaveBeenCalled();
  });

  it('should not log messages when extension mode is Test', () => {
    const context = Object.create(null);
    Object.defineProperty(context, 'extensionMode', {
      value: vscode.ExtensionMode.Test,
      writable: true,
      configurable: true,
    });

    const log = createLogger(context, mockOutputChannel);
    const message = 'Test message';

    log(message);

    expect(mockOutputChannel.appendLine).not.toHaveBeenCalled();
  });
});
