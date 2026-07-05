/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import { beforeEach, describe, expect, it } from 'vitest';
import { setLanguageAsync } from '../i18n/index.js';
import { createSlashCommandFromDefinition } from './command-factory.js';

describe('createSlashCommandFromDefinition', () => {
  beforeEach(async () => {
    await setLanguageAsync('en');
  });

  it('marks custom file commands with stable source detail', () => {
    const command = createSlashCommandFromDefinition(
      '/workspace/.qwen/commands/review.toml',
      '/workspace/.qwen/commands',
      {
        prompt: 'Review the current changes',
      },
      undefined,
      '.toml',
    );

    expect(command.source).toBe('skill-dir-command');
    expect(command.sourceLabel).toBe('Custom');
    expect(command.sourceDetail).toBe('custom');
  });

  it('marks extension commands with stable source detail', () => {
    const command = createSlashCommandFromDefinition(
      '/workspace/.qwen/extensions/demo/commands/review.md',
      '/workspace/.qwen/extensions/demo/commands',
      {
        prompt: 'Review the current changes',
      },
      'demo',
      '.md',
    );

    expect(command.source).toBe('plugin-command');
    expect(command.extensionName).toBe('demo');
    expect(command.sourceLabel).toBe('Extension: demo');
    expect(command.sourceDetail).toBe('extension');
  });
});
