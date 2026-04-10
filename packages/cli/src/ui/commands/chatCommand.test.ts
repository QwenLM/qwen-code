/**
 * @license
 * Copyright 2025 Qwen Code
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { chatCommand } from './chatCommand.js';
import { parseSlashCommand } from '../../utils/commands.js';
import type { CommandContext } from './types.js';

// Mock the chat index functions
vi.mock('@qwen-code/qwen-code-core', () => ({
  saveSessionToIndex: vi.fn().mockResolvedValue(undefined),
  deleteSessionFromIndex: vi.fn().mockResolvedValue(true),
  getSessionIdByName: vi.fn().mockResolvedValue('test-session-id-12345'),
  listNamedSessions: vi.fn().mockResolvedValue({
    'test-session-1': 'test-session-id-1',
    'test-session-2': 'test-session-id-2',
  }),
}));

describe('chatCommand', () => {
  describe('command structure', () => {
    it('should have correct name', () => {
      expect(chatCommand.name).toBe('chat');
    });

    it('should have subcommands', () => {
      expect(chatCommand.subCommands).toBeDefined();
      expect(chatCommand.subCommands).toHaveLength(4);
    });

    it('should have save, list, resume, and delete subcommands', () => {
      const subCommandNames = chatCommand.subCommands?.map((cmd) => cmd.name);
      expect(subCommandNames).toContain('save');
      expect(subCommandNames).toContain('list');
      expect(subCommandNames).toContain('resume');
      expect(subCommandNames).toContain('delete');
    });
  });

  describe('command parsing', () => {
    const commands = [chatCommand];

    it('should parse /chat list correctly', () => {
      const result = parseSlashCommand('/chat list', commands);
      expect(result.commandToExecute?.name).toBe('list');
      expect(result.args).toBe('');
      expect(result.canonicalPath).toEqual(['chat', 'list']);
    });

    it('should parse /chat save my-session correctly', () => {
      const result = parseSlashCommand('/chat save my-session', commands);
      expect(result.commandToExecute?.name).toBe('save');
      expect(result.args).toBe('my-session');
      expect(result.canonicalPath).toEqual(['chat', 'save']);
    });

    it('should parse /chat resume my-session correctly', () => {
      const result = parseSlashCommand('/chat resume my-session', commands);
      expect(result.commandToExecute?.name).toBe('resume');
      expect(result.args).toBe('my-session');
      expect(result.canonicalPath).toEqual(['chat', 'resume']);
    });

    it('should parse /chat delete my-session correctly', () => {
      const result = parseSlashCommand('/chat delete my-session', commands);
      expect(result.commandToExecute?.name).toBe('delete');
      expect(result.args).toBe('my-session');
      expect(result.canonicalPath).toEqual(['chat', 'delete']);
    });
  });

  describe('save subcommand', () => {
    const mockContext: CommandContext = {
      services: {
        config: {
          getSessionId: () => 'current-session-id-12345',
        } as any,
      } as any,
      ui: {} as any,
      executionMode: 'non_interactive',
    };

    it('should return error when no name provided', async () => {
      const saveCommand = chatCommand.subCommands?.find(
        (cmd) => cmd.name === 'save',
      );
      const result = await saveCommand?.action!(mockContext, '');

      expect(result).toEqual({
        type: 'message',
        messageType: 'error',
        content: expect.stringContaining('Please provide a name'),
      });
    });

    it('should save session when name provided', async () => {
      const saveCommand = chatCommand.subCommands?.find(
        (cmd) => cmd.name === 'save',
      );
      const result = await saveCommand?.action!(mockContext, 'my-test-session');

      expect(result).toEqual({
        type: 'message',
        messageType: 'info',
        content: expect.stringContaining('Session saved as'),
      });
    });
  });

  describe('list subcommand', () => {
    it('should list all saved sessions', async () => {
      const listCommand = chatCommand.subCommands?.find(
        (cmd) => cmd.name === 'list',
      );
      const result = await listCommand?.action!(undefined as any, '');

      expect(result).toEqual({
        type: 'message',
        messageType: 'info',
        content: expect.stringContaining('Saved sessions'),
      });
    });
  });

  describe('resume subcommand', () => {
    it('should return error when no name provided', async () => {
      const resumeCommand = chatCommand.subCommands?.find(
        (cmd) => cmd.name === 'resume',
      );
      const result = await resumeCommand?.action!(undefined as any, '');

      expect(result).toEqual({
        type: 'message',
        messageType: 'error',
        content: expect.stringContaining('Please provide a name'),
      });
    });

    it('should find session by name', async () => {
      const resumeCommand = chatCommand.subCommands?.find(
        (cmd) => cmd.name === 'resume',
      );
      const result = await resumeCommand?.action!(
        undefined as any,
        'test-session-1',
      );

      expect(result).toEqual({
        type: 'message',
        messageType: 'info',
        content: expect.stringContaining('Found session'),
      });
    });
  });

  describe('delete subcommand', () => {
    it('should return error when no name provided', async () => {
      const deleteCommand = chatCommand.subCommands?.find(
        (cmd) => cmd.name === 'delete',
      );
      const result = await deleteCommand?.action!(undefined as any, '');

      expect(result).toEqual({
        type: 'message',
        messageType: 'error',
        content: expect.stringContaining('Please provide a name'),
      });
    });

    it('should delete session by name', async () => {
      const deleteCommand = chatCommand.subCommands?.find(
        (cmd) => cmd.name === 'delete',
      );
      const result = await deleteCommand?.action!(
        undefined as any,
        'test-session-1',
      );

      expect(result).toEqual({
        type: 'message',
        messageType: 'info',
        content: expect.stringContaining('deleted'),
      });
    });
  });
});
