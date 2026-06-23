/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, vi } from 'vitest';
import { configCommand } from './config-command.js';
import { CommandKind } from './types.js';
import type { CommandContext } from './types.js';

function createMockContext(mergedSettings: Record<string, unknown> = {}) {
  const setValueMock = vi.fn();
  const mockSettings = {
    merged: mergedSettings,
    setValue: setValueMock,
  };

  const ctx = {
    services: {
      settings: mockSettings,
      config: null,
      logger: null,
    },
  } as unknown as CommandContext;

  return { ctx, setValueMock };
}

describe('configCommand', () => {
  it('is a built-in command available in all execution modes', () => {
    expect(configCommand.name).toBe('config');
    expect(configCommand.kind).toBe(CommandKind.BUILT_IN);
    expect(configCommand.supportedModes).toEqual([
      'interactive',
      'non_interactive',
      'acp',
    ]);
  });

  it('has correct metadata', () => {
    expect(configCommand.argumentHint).toBe('<key>[=<value>] or --help');
    expect(configCommand.description).toBeTruthy();
  });

  describe('set boolean value', () => {
    it('sets a boolean setting to true', async () => {
      const { ctx, setValueMock } = createMockContext({
        general: { vimMode: false },
      });
      const result = await configCommand.action!(ctx, 'general.vimMode=true');

      expect(result).toEqual({
        type: 'message',
        messageType: 'info',
        content: expect.stringContaining('general.vimMode'),
      });
      expect(setValueMock).toHaveBeenCalledWith(
        'User',
        'general.vimMode',
        true,
      );
    });

    it('sets a boolean setting to false', async () => {
      const { ctx, setValueMock } = createMockContext({
        general: { vimMode: true },
      });
      const result = await configCommand.action!(ctx, 'general.vimMode=false');

      expect(result).toEqual({
        type: 'message',
        messageType: 'info',
        content: expect.stringContaining('false'),
      });
      expect(setValueMock).toHaveBeenCalledWith(
        'User',
        'general.vimMode',
        false,
      );
    });
  });

  describe('toggle boolean', () => {
    it('toggles a boolean from false to true', async () => {
      const { ctx, setValueMock } = createMockContext({
        general: { vimMode: false },
      });
      const result = await configCommand.action!(ctx, 'general.vimMode');

      expect(result).toEqual({
        type: 'message',
        messageType: 'info',
        content: expect.stringContaining('true'),
      });
      expect(setValueMock).toHaveBeenCalledWith(
        'User',
        'general.vimMode',
        true,
      );
    });

    it('toggles a boolean from true to false', async () => {
      const { ctx, setValueMock } = createMockContext({
        general: { vimMode: true },
      });
      const result = await configCommand.action!(ctx, 'general.vimMode');

      expect(result).toEqual({
        type: 'message',
        messageType: 'info',
        content: expect.stringContaining('false'),
      });
      expect(setValueMock).toHaveBeenCalledWith(
        'User',
        'general.vimMode',
        false,
      );
    });

    it('toggles undefined boolean to true', async () => {
      const { ctx } = createMockContext({});
      const result = await configCommand.action!(ctx, 'general.vimMode');

      expect(result).toEqual({
        type: 'message',
        messageType: 'info',
        content: expect.stringContaining('true'),
      });
    });
  });

  describe('invalid boolean value', () => {
    it('returns error for invalid boolean value', async () => {
      const { ctx } = createMockContext({});
      const result = await configCommand.action!(ctx, 'general.vimMode=yes');

      expect(result).toEqual({
        type: 'message',
        messageType: 'error',
        content: expect.stringContaining('Invalid boolean'),
      });
    });
  });

  describe('enum settings', () => {
    it('sets a valid enum value', async () => {
      const { ctx, setValueMock } = createMockContext({});
      const result = await configCommand.action!(
        ctx,
        'tools.approvalMode=auto',
      );

      expect(result).toEqual({
        type: 'message',
        messageType: 'info',
        content: expect.stringContaining('auto'),
      });
      expect(setValueMock).toHaveBeenCalledWith(
        'User',
        'tools.approvalMode',
        'auto',
      );
    });

    it('returns error for invalid enum value', async () => {
      const { ctx } = createMockContext({});
      const result = await configCommand.action!(
        ctx,
        'tools.approvalMode=invalid_mode',
      );

      expect(result).toEqual({
        type: 'message',
        messageType: 'error',
        content: expect.stringContaining('Invalid enum value'),
      });
    });

    it('returns error when toggling enum', async () => {
      const { ctx } = createMockContext({});
      const result = await configCommand.action!(ctx, 'tools.approvalMode');

      expect(result).toEqual({
        type: 'message',
        messageType: 'error',
        content: expect.stringContaining('Cannot toggle'),
      });
    });
  });

  describe('string settings', () => {
    it('sets a string value', async () => {
      const { ctx, setValueMock } = createMockContext({});
      const result = await configCommand.action!(
        ctx,
        'general.preferredEditor=vim',
      );

      expect(result).toEqual({
        type: 'message',
        messageType: 'info',
        content: expect.stringContaining('vim'),
      });
      expect(setValueMock).toHaveBeenCalledWith(
        'User',
        'general.preferredEditor',
        'vim',
      );
    });

    it('returns error when toggling string', async () => {
      const { ctx } = createMockContext({});
      const result = await configCommand.action!(
        ctx,
        'general.preferredEditor',
      );

      expect(result).toEqual({
        type: 'message',
        messageType: 'error',
        content: expect.stringContaining('Cannot toggle'),
      });
    });
  });

  describe('number settings', () => {
    it('sets a number value', async () => {
      const { ctx, setValueMock } = createMockContext({});
      const result = await configCommand.action!(
        ctx,
        'general.sessionRecapAwayThresholdMinutes=10',
      );

      expect(result).toEqual({
        type: 'message',
        messageType: 'info',
        content: expect.stringContaining('10'),
      });
      expect(setValueMock).toHaveBeenCalledWith(
        'User',
        'general.sessionRecapAwayThresholdMinutes',
        10,
      );
    });

    it('returns error for invalid number value', async () => {
      const { ctx } = createMockContext({});
      const result = await configCommand.action!(
        ctx,
        'general.sessionRecapAwayThresholdMinutes=abc',
      );

      expect(result).toEqual({
        type: 'message',
        messageType: 'error',
        content: expect.stringContaining('Invalid number'),
      });
    });

    it('returns error when toggling number', async () => {
      const { ctx } = createMockContext({});
      const result = await configCommand.action!(
        ctx,
        'general.sessionRecapAwayThresholdMinutes',
      );

      expect(result).toEqual({
        type: 'message',
        messageType: 'error',
        content: expect.stringContaining('Cannot toggle'),
      });
    });
  });

  describe('array/object settings', () => {
    it('returns error for object settings', async () => {
      const { ctx } = createMockContext({});
      const result = await configCommand.action!(ctx, 'mcpServers={"test":{}}');

      expect(result).toEqual({
        type: 'message',
        messageType: 'error',
        content: expect.stringContaining('settings.json'),
      });
    });
  });

  describe('unknown keys', () => {
    it('returns error for unknown key', async () => {
      const { ctx } = createMockContext({});
      const result = await configCommand.action!(ctx, 'nonexistent.key=value');

      expect(result).toEqual({
        type: 'message',
        messageType: 'error',
        content: expect.stringContaining('Unknown setting key'),
      });
    });

    it('suggests closest key for typo', async () => {
      const { ctx } = createMockContext({});
      const result = await configCommand.action!(ctx, 'general.vimMod=true');

      expect(result).toEqual({
        type: 'message',
        messageType: 'error',
        content: expect.stringContaining('Did you mean'),
      });
    });
  });

  describe('--help', () => {
    it('lists all settings with --help', async () => {
      const { ctx } = createMockContext({});
      const result = await configCommand.action!(ctx, '--help');

      expect(result).toEqual({
        type: 'message',
        messageType: 'info',
        content: expect.stringContaining('Available settings'),
      });
    });

    it('lists all settings with -h', async () => {
      const { ctx } = createMockContext({});
      const result = await configCommand.action!(ctx, '-h');

      expect(result).toEqual({
        type: 'message',
        messageType: 'info',
        content: expect.stringContaining('Available settings'),
      });
    });

    it('lists all settings when no args provided', async () => {
      const { ctx } = createMockContext({});
      const result = await configCommand.action!(ctx, '');

      expect(result).toEqual({
        type: 'message',
        messageType: 'info',
        content: expect.stringContaining('Available settings'),
      });
    });
  });

  describe('restart warning', () => {
    it('shows restart warning for settings that require restart', async () => {
      const { ctx } = createMockContext({});
      const result = await configCommand.action!(
        ctx,
        'proxy=http://localhost:8080',
      );

      expect(result).toEqual({
        type: 'message',
        messageType: 'info',
        content: expect.stringContaining('requires a restart'),
      });
    });
  });

  describe('completion', () => {
    it('provides completions for partial key', async () => {
      const { ctx } = createMockContext({});
      const completions = await configCommand.completion!(ctx, 'general.vim');

      expect(completions).toBeTruthy();
      expect(completions!.length).toBeGreaterThan(0);
      expect(
        completions!.some((c) =>
          typeof c === 'string'
            ? c.includes('vimMode')
            : c.value.includes('vimMode'),
        ),
      ).toBe(true);
    });

    it('returns null when completing after = sign', async () => {
      const { ctx } = createMockContext({});
      const completions = await configCommand.completion!(
        ctx,
        'general.vimMode=',
      );

      expect(completions).toBeNull();
    });
  });
});
