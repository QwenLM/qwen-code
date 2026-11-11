/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import { existsSync } from 'node:fs';
import {
  isCommandStyleUserPromptText,
  isPathLikeCommandStyleText,
  isSlashCommandStyleUserPromptText,
} from './commandStyleText.js';

vi.mock('node:fs', () => ({
  existsSync: vi.fn(() => false),
}));

const mockedExistsSync = vi.mocked(existsSync);

describe('commandStyleText', () => {
  beforeEach(() => {
    mockedExistsSync.mockReset();
    mockedExistsSync.mockReturnValue(false);
  });

  it('treats nested absolute paths and comments as plain text', () => {
    expect(isSlashCommandStyleUserPromptText('/Users/me/project 这里面有啥')).toBe(
      false,
    );
    expect(isSlashCommandStyleUserPromptText('/etc/hosts')).toBe(false);
    expect(isSlashCommandStyleUserPromptText('// comment')).toBe(false);
    expect(isSlashCommandStyleUserPromptText('/* comment */')).toBe(false);
  });

  it('treats an existing root entry as a path after discovery settles', () => {
    mockedExistsSync.mockReturnValue(true);

    expect(isPathLikeCommandStyleText('/tmp 里面有什么')).toBe(true);
    expect(
      isSlashCommandStyleUserPromptText('/tmp 里面有什么', {
        commandCatalogReady: true,
      }),
    ).toBe(false);
  });

  it('keeps an existing root entry command-like while discovery is pending', () => {
    mockedExistsSync.mockReturnValue(true);

    expect(
      isSlashCommandStyleUserPromptText('/tmp', {
        commandCatalogReady: false,
      }),
    ).toBe(true);
  });

  it('gives a registered command precedence over an existing root path', () => {
    mockedExistsSync.mockReturnValue(true);

    expect(
      isSlashCommandStyleUserPromptText('/tmp', {
        isKnownCommand: true,
        commandCatalogReady: true,
      }),
    ).toBe(true);
  });

  it('keeps known and unknown command-shaped input command-like', () => {
    expect(isSlashCommandStyleUserPromptText('/clear')).toBe(true);
    expect(isSlashCommandStyleUserPromptText('/unknown value')).toBe(true);
    expect(isSlashCommandStyleUserPromptText('/')).toBe(true);
  });

  it('lets the loaded catalog resolve custom names before lexical fallback', () => {
    expect(
      isSlashCommandStyleUserPromptText('/中文命令', {
        commandCatalogReady: false,
      }),
    ).toBe(true);
    expect(
      isSlashCommandStyleUserPromptText('/中文命令', {
        isKnownCommand: true,
        commandCatalogReady: true,
      }),
    ).toBe(true);
    expect(
      isSlashCommandStyleUserPromptText('/中文命令', {
        commandCatalogReady: true,
      }),
    ).toBe(false);
  });

  it('supports question-mark commands without applying path rules', () => {
    expect(isCommandStyleUserPromptText('?help')).toBe(true);
    expect(isCommandStyleUserPromptText('?/etc/hosts')).toBe(true);
    expect(isCommandStyleUserPromptText('/etc/hosts')).toBe(false);
    expect(isCommandStyleUserPromptText('hello')).toBe(false);
  });
});
