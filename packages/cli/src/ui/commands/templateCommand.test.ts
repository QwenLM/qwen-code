/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { type CommandContext } from './types.js';
import { createMockCommandContext } from '../../test-utils/mockCommandContext.js';
import { MessageType } from '../types.js';
import { CommandKind } from './types.js';

// Mock the core module
const mockGenerateFiles = vi.fn().mockReturnValue([
  { path: 'Button.tsx', content: 'export const Button = () => null;' },
  { path: 'Button.test.tsx', content: 'describe("Button", () => {});' },
]);

vi.mock('@qwen-code/qwen-code-core', () => ({
  ModeTemplateManager: class {
    private templates: Map<string, unknown> = new Map();
    registerTemplate(t: { id: string }) {
      this.templates.set(t.id, t);
    }
    getAllTemplates() {
      return Array.from(this.templates.values()).concat([
        {
          id: 'react-component',
          name: 'React Component',
          description: 'A React component',
          icon: '⚛️',
          category: 'react',
          variables: [
            { name: 'name', default: 'Component', description: 'Name' },
          ],
          files: [
            { path: '{{name}}.tsx', content: '', description: 'Component' },
          ],
        },
        {
          id: 'test-suite',
          name: 'Test Suite',
          description: 'A test suite',
          icon: '🧪',
          category: 'test',
          variables: [],
          files: [{ path: 'test.ts', content: '', description: 'Test' }],
        },
      ]);
    }
    getTemplate(id: string) {
      return this.getAllTemplates().find((t: { id: string }) => t.id === id);
    }
    generateFiles = mockGenerateFiles;
    addBuiltInTemplates() {}
  },
  toPascalCase: (name: string) => name.charAt(0).toUpperCase() + name.slice(1),
  toCamelCase: (name: string) => name.charAt(0).toLowerCase() + name.slice(1),
}));

// Import after mocking
const { templateCommand } = await import('./templateCommand.js');

describe('templateCommand', () => {
  let mockContext: CommandContext;

  beforeEach(() => {
    mockContext = createMockCommandContext({
      ui: {
        addItem: vi.fn(),
      },
    } as unknown as CommandContext);
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  describe('command properties', () => {
    it('should have the correct name', () => {
      expect(templateCommand.name).toBe('template');
    });

    it('should have altNames', () => {
      expect(templateCommand.altNames).toContain('tpl');
    });

    it('should have correct kind', () => {
      expect(templateCommand.kind).toBe(CommandKind.BUILT_IN);
    });

    it('should have a description', () => {
      expect(templateCommand.description).toBeTruthy();
    });
  });

  describe('main action', () => {
    it('should show help when run with no args', async () => {
      if (!templateCommand.action) {
        throw new Error('Template command has no action');
      }

      await templateCommand.action(mockContext, '');

      expect(mockContext.ui.addItem).toHaveBeenCalledWith(
        expect.objectContaining({
          type: MessageType.TEXT,
          text: expect.stringContaining('**Mode Templates**'),
        }),
        expect.any(Number),
      );
    });

    it('should list templates with "list" arg', async () => {
      if (!templateCommand.action) {
        throw new Error('Template command has no action');
      }

      await templateCommand.action(mockContext, 'list');

      expect(mockContext.ui.addItem).toHaveBeenCalledWith(
        expect.objectContaining({
          type: MessageType.TEXT,
          text: expect.stringContaining('**Available Templates:**'),
        }),
        expect.any(Number),
      );
    });

    it('should list templates with "ls" arg', async () => {
      if (!templateCommand.action) {
        throw new Error('Template command has no action');
      }

      await templateCommand.action(mockContext, 'ls');

      expect(mockContext.ui.addItem).toHaveBeenCalledWith(
        expect.objectContaining({
          type: MessageType.TEXT,
          text: expect.stringContaining('**Available Templates:**'),
        }),
        expect.any(Number),
      );
    });

    it('should show error for unknown template in show', async () => {
      if (!templateCommand.action) {
        throw new Error('Template command has no action');
      }

      await templateCommand.action(mockContext, 'show nonexistent');

      expect(mockContext.ui.addItem).toHaveBeenCalledWith(
        expect.objectContaining({
          type: MessageType.TEXT,
          text: expect.stringContaining('Template not found'),
        }),
        expect.any(Number),
      );
    });

    it('should show template details for valid template', async () => {
      if (!templateCommand.action) {
        throw new Error('Template command has no action');
      }

      await templateCommand.action(mockContext, 'show react-component');

      expect(mockContext.ui.addItem).toHaveBeenCalledWith(
        expect.objectContaining({
          type: MessageType.TEXT,
          text: expect.stringContaining('React Component'),
        }),
        expect.any(Number),
      );
    });

    it('should show error for unknown template in generate', async () => {
      if (!templateCommand.action) {
        throw new Error('Template command has no action');
      }

      await templateCommand.action(mockContext, 'generate nonexistent');

      expect(mockContext.ui.addItem).toHaveBeenCalledWith(
        expect.objectContaining({
          type: MessageType.TEXT,
          text: expect.stringContaining('Template not found'),
        }),
        expect.any(Number),
      );
    });

    it('should handle template ID directly', async () => {
      if (!templateCommand.action) {
        throw new Error('Template command has no action');
      }

      await templateCommand.action(mockContext, 'test-suite');

      expect(mockContext.ui.addItem).toHaveBeenCalledWith(
        expect.objectContaining({
          type: MessageType.TEXT,
          text: expect.stringContaining('Test Suite'),
        }),
        expect.any(Number),
      );
    });

    it('should show error for unknown subcommand', async () => {
      if (!templateCommand.action) {
        throw new Error('Template command has no action');
      }

      await templateCommand.action(mockContext, 'unknowncommand');

      expect(mockContext.ui.addItem).toHaveBeenCalledWith(
        expect.objectContaining({
          type: MessageType.TEXT,
          text: expect.stringContaining('Unknown command'),
        }),
        expect.any(Number),
      );
    });
  });

  describe('subCommands', () => {
    describe('list subcommand', () => {
      it('should list templates', async () => {
        const listCmd = templateCommand.subCommands?.find(
          (sc) => sc.name === 'list',
        );
        if (!listCmd?.action) {
          throw new Error('List subcommand has no action');
        }

        await listCmd.action(mockContext, '');

        expect(mockContext.ui.addItem).toHaveBeenCalledWith(
          expect.objectContaining({
            type: MessageType.TEXT,
            text: expect.stringContaining('react-component'),
          }),
          expect.any(Number),
        );
      });
    });

    describe('show subcommand', () => {
      it('should show usage when no template specified', async () => {
        const showCmd = templateCommand.subCommands?.find(
          (sc) => sc.name === 'show',
        );
        if (!showCmd?.action) {
          throw new Error('Show subcommand has no action');
        }

        await showCmd.action(mockContext, '');

        expect(mockContext.ui.addItem).toHaveBeenCalledWith(
          expect.objectContaining({
            type: MessageType.TEXT,
            text: expect.stringContaining('Usage'),
          }),
          expect.any(Number),
        );
      });

      it('should show template details', async () => {
        const showCmd = templateCommand.subCommands?.find(
          (sc) => sc.name === 'show',
        );
        if (!showCmd?.action) {
          throw new Error('Show subcommand has no action');
        }

        await showCmd.action(mockContext, 'react-component');

        expect(mockContext.ui.addItem).toHaveBeenCalledWith(
          expect.objectContaining({
            type: MessageType.TEXT,
            text: expect.stringContaining('React Component'),
          }),
          expect.any(Number),
        );
      });
    });
  });
});
