/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const { showInformationMessage, openExternal, writeText, parseUri } =
  vi.hoisted(() => ({
    showInformationMessage: vi.fn(),
    openExternal: vi.fn(),
    writeText: vi.fn(),
    parseUri: vi.fn((value: string) => ({ value })),
  }));

vi.mock('vscode', () => ({
  window: {
    showInformationMessage,
  },
  env: {
    openExternal,
    clipboard: {
      writeText,
    },
  },
  Uri: {
    parse: parseUri,
  },
}));

describe('handleAuthenticateUpdate', () => {
  beforeEach(() => {
    vi.resetModules();
    vi.clearAllMocks();
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('opens the authentication link in the browser when requested', async () => {
    showInformationMessage
      .mockResolvedValueOnce('Open in Browser')
      .mockResolvedValueOnce(undefined);

    const { handleAuthenticateUpdate } = await import(
      './authNotificationHandler.js'
    );

    handleAuthenticateUpdate({
      _meta: {
        authUri: 'https://auth.example.com/login',
      },
    });
    await Promise.resolve();

    expect(parseUri).toHaveBeenCalledWith('https://auth.example.com/login');
    expect(openExternal).toHaveBeenCalledWith({
      value: 'https://auth.example.com/login',
    });
    expect(writeText).not.toHaveBeenCalled();
    expect(showInformationMessage).toHaveBeenNthCalledWith(
      2,
      'Opening authentication page in your browser...',
    );
  });

  it('copies the authentication link when requested', async () => {
    showInformationMessage
      .mockResolvedValueOnce('Copy Link')
      .mockResolvedValueOnce(undefined);

    const { handleAuthenticateUpdate } = await import(
      './authNotificationHandler.js'
    );

    handleAuthenticateUpdate({
      _meta: {
        authUri: 'https://auth.example.com/login',
      },
    });
    await Promise.resolve();

    expect(writeText).toHaveBeenCalledWith('https://auth.example.com/login');
    expect(openExternal).not.toHaveBeenCalled();
    expect(showInformationMessage).toHaveBeenNthCalledWith(
      2,
      'Authentication link copied to clipboard!',
    );
  });
});
