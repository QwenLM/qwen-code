/**
 * @license
 * Copyright 2026 Qmode
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { enhanceCommand } from './enhanceCommand.js';
import { CommandKind, type CommandContext } from './types.js';

describe('enhanceCommand', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('command definition', () => {
    it('should have correct name', () => {
      expect(enhanceCommand.name).toBe('enhance');
    });

    it('should have altNames', () => {
      expect(enhanceCommand.altNames).toEqual(['improve', 'refine']);
    });

    it('should have correct kind', () => {
      expect(enhanceCommand.kind).toBe(CommandKind.BUILT_IN);
    });

    it('should not be hidden', () => {
      expect(enhanceCommand.hidden).toBe(false);
    });

    it('should have description', () => {
      expect(enhanceCommand.description).toBeDefined();
      expect(enhanceCommand.description.length).toBeGreaterThan(0);
    });
  });

  describe('action', () => {
    const mockContext = {
      services: {
        config: {
          getProjectRoot: () => '/test/project',
        },
      },
      ui: {
        setPendingItem: vi.fn(),
        setDebugMessage: vi.fn(),
      },
      session: {},
    };

    it('should show help when no args provided', async () => {
      const result = await enhanceCommand.action?.(
        mockContext as unknown as CommandContext,
        '',
      );

      expect(result).toEqual({
        type: 'message',
        messageType: 'info',
        content: expect.stringContaining('Prompt Enhancer'),
      });
    });

    it('should show help for --help flag', async () => {
      const result = await enhanceCommand.action?.(
        mockContext as unknown as CommandContext,
        '--help',
      );

      expect(result).toEqual({
        type: 'message',
        messageType: 'info',
        content: expect.stringContaining('Usage'),
      });
    });

    it('should show error for empty prompt after flag parsing', async () => {
      const result = await enhanceCommand.action?.(
        mockContext as unknown as CommandContext,
        '--level minimal',
      );

      expect(result).toEqual({
        type: 'message',
        messageType: 'error',
        content: expect.stringContaining('Error'),
      });
    });

    it('should handle --level flag', async () => {
      const result = await enhanceCommand.action?.(
        mockContext as unknown as CommandContext,
        '--level minimal Test prompt',
      );

      expect(result).toBeDefined();
    });

    it('should handle --preview flag', async () => {
      const result = await enhanceCommand.action?.(
        mockContext as unknown as CommandContext,
        '--preview Test prompt',
      );

      expect(result).toBeDefined();
    });
  });

  describe('completion', () => {
    it('should provide completion suggestions', async () => {
      const completions = await enhanceCommand.completion?.(
        {} as unknown as CommandContext,
        '--',
      );

      expect(completions).toBeDefined();
      expect(Array.isArray(completions)).toBe(true);

      if (completions) {
        const values = completions.map((c: string | { value: string }) =>
          typeof c === 'string' ? c : c.value,
        );
        expect(values).toContain('--help');
        expect(values).toContain('--preview');
        expect(values).toContain('--level minimal');
        expect(values).toContain('--level standard');
        expect(values).toContain('--level maximal');
      }
    });

    it('should include descriptions for completions', async () => {
      const completions = await enhanceCommand.completion?.(
        {} as unknown as CommandContext,
        '',
      );

      if (completions && completions.length > 0) {
        expect(completions[0]).toHaveProperty('value');
        expect(completions[0]).toHaveProperty('description');
      }
    });
  });
});
