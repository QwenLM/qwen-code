/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it, vi } from 'vitest';
import { directoryCommand } from './directoryCommand.js';
import { createMockCommandContext } from '../../test-utils/mockCommandContext.js';

const addSubcommand = directoryCommand.subCommands![0]!;
const showSubcommand = directoryCommand.subCommands![1]!;

describe('directoryCommand', () => {
  it('declares acp in supportedModes for parent and subcommands', () => {
    expect(directoryCommand.supportedModes).toEqual(['interactive', 'acp']);
    expect(addSubcommand.supportedModes).toEqual(['interactive', 'acp']);
    expect(showSubcommand.supportedModes).toEqual(['interactive', 'acp']);
  });

  it('add subcommand has argumentHint', () => {
    expect(addSubcommand.argumentHint).toBe('<path>[,<path>,...]');
  });

  it('returns usage hint when invoked without a subcommand', async () => {
    const context = createMockCommandContext();
    const result = await directoryCommand.action?.(context, '');
    expect(result).toEqual({
      type: 'message',
      messageType: 'info',
      content: expect.stringContaining('/directory add'),
    });
  });

  describe('show', () => {
    it('returns error when config is null', async () => {
      const context = createMockCommandContext({ services: { config: null } });
      const result = await showSubcommand.action?.(context, '');
      expect(result).toEqual({
        type: 'message',
        messageType: 'error',
        content: expect.stringContaining('Configuration'),
      });
    });

    it('returns directory list', async () => {
      const context = createMockCommandContext({
        services: {
          config: {
            getWorkspaceContext: vi.fn().mockReturnValue({
              getDirectories: vi
                .fn()
                .mockReturnValue(['/home/user/project', '/tmp/extra']),
            }),
          },
        },
      });
      const result = await showSubcommand.action?.(context, '');
      expect(result).toEqual({
        type: 'message',
        messageType: 'info',
        content: expect.stringContaining('/home/user/project'),
      });
      expect((result as { content: string }).content).toContain('/tmp/extra');
    });
  });

  describe('add', () => {
    it('returns error when config is null', async () => {
      const context = createMockCommandContext({ services: { config: null } });
      const result = await addSubcommand.action?.(context, '/some/path');
      expect(result).toEqual({
        type: 'message',
        messageType: 'error',
        content: expect.stringContaining('Configuration'),
      });
    });

    it('returns error when no paths provided', async () => {
      const context = createMockCommandContext({
        services: {
          config: {
            getWorkspaceContext: vi.fn().mockReturnValue({
              getDirectories: vi.fn().mockReturnValue([]),
            }),
          },
        },
      });
      const result = await addSubcommand.action?.(context, '');
      expect(result).toEqual({
        type: 'message',
        messageType: 'error',
        content: expect.stringContaining('at least one path'),
      });
    });

    it('returns error on restrictive sandbox', async () => {
      const context = createMockCommandContext({
        services: {
          config: {
            isRestrictiveSandbox: vi.fn().mockReturnValue(true),
            getWorkspaceContext: vi.fn().mockReturnValue({
              getDirectories: vi.fn().mockReturnValue([]),
            }),
          },
        },
      });
      const result = await addSubcommand.action?.(context, '/some/path');
      expect(result).toEqual({
        type: 'message',
        messageType: 'error',
        content: expect.stringContaining('restrictive sandbox'),
      });
    });

    it('returns info on successful directory add', async () => {
      let directories = ['/home/user/project'];
      const context = createMockCommandContext({
        services: {
          config: {
            isRestrictiveSandbox: vi.fn().mockReturnValue(false),
            getWorkspaceContext: vi.fn().mockReturnValue({
              getDirectories: vi
                .fn()
                .mockImplementation(() => [...directories]),
              addDirectory: vi.fn().mockImplementation((dir: string) => {
                directories = [...directories, dir];
              }),
            }),
            shouldLoadMemoryFromIncludeDirectories: vi
              .fn()
              .mockReturnValue(false),
            getGeminiClient: vi.fn().mockReturnValue(null),
          },
          settings: {
            workspace: {
              originalSettings: { context: { includeDirectories: [] } },
            },
            setValue: vi.fn(),
          },
        },
      });
      const result = await addSubcommand.action?.(context, '/tmp/new-dir');
      expect(result).toEqual({
        type: 'message',
        messageType: 'info',
        content: expect.stringContaining('Successfully added directories'),
      });
    });

    it('returns info when directory already exists', async () => {
      const existingDirs = ['/home/user/project'];
      const context = createMockCommandContext({
        services: {
          config: {
            isRestrictiveSandbox: vi.fn().mockReturnValue(false),
            getWorkspaceContext: vi.fn().mockReturnValue({
              getDirectories: vi.fn().mockReturnValue(existingDirs),
              addDirectory: vi.fn(),
            }),
            shouldLoadMemoryFromIncludeDirectories: vi
              .fn()
              .mockReturnValue(false),
            getGeminiClient: vi.fn().mockReturnValue(null),
          },
          settings: {
            workspace: {
              originalSettings: { context: { includeDirectories: [] } },
            },
            setValue: vi.fn(),
          },
        },
      });
      const result = await addSubcommand.action?.(
        context,
        '/home/user/project',
      );
      expect(result).toEqual({
        type: 'message',
        messageType: 'info',
        content: expect.stringContaining('already in workspace'),
      });
    });

    it('returns error when addDirectory throws', async () => {
      const context = createMockCommandContext({
        services: {
          config: {
            isRestrictiveSandbox: vi.fn().mockReturnValue(false),
            getWorkspaceContext: vi.fn().mockReturnValue({
              getDirectories: vi.fn().mockReturnValue([]),
              addDirectory: vi.fn().mockImplementation(() => {
                throw new Error('Permission denied');
              }),
            }),
            shouldLoadMemoryFromIncludeDirectories: vi
              .fn()
              .mockReturnValue(false),
            getGeminiClient: vi.fn().mockReturnValue(null),
          },
          settings: {
            workspace: {
              originalSettings: { context: { includeDirectories: [] } },
            },
            setValue: vi.fn(),
          },
        },
      });
      const result = await addSubcommand.action?.(context, '/restricted/path');
      expect(result).toEqual({
        type: 'message',
        messageType: 'error',
        content: expect.stringContaining('Permission denied'),
      });
    });
  });
});
