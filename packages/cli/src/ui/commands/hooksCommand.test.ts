/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { vi, describe, it, expect, beforeEach } from 'vitest';
import { hooksCommand } from './hooksCommand.js';
import { createMockCommandContext } from '../../test-utils/mockCommandContext.js';

describe('hooksCommand', () => {
  let mockContext: ReturnType<typeof createMockCommandContext>;
  let mockConfig: {
    getHookSystem: ReturnType<typeof vi.fn>;
  };

  beforeEach(() => {
    vi.clearAllMocks();

    mockConfig = {
      getHookSystem: vi.fn().mockReturnValue({
        getRegistry: vi.fn().mockReturnValue({
          getAllHooks: vi.fn().mockReturnValue([]),
        }),
      }),
    };

    mockContext = createMockCommandContext({
      services: {
        config: mockConfig,
      },
    });
  });

  describe('basic functionality', () => {
    it('should open hooks management dialog in interactive mode', async () => {
      const result = await hooksCommand.action!(mockContext, '');

      expect(result).toEqual({
        type: 'dialog',
        dialog: 'hooks',
      });
    });

    it('should open hooks management dialog even if config is not available', async () => {
      const contextWithoutConfig = createMockCommandContext({
        services: {
          config: null,
        },
      });

      const result = await hooksCommand.action!(contextWithoutConfig, '');

      expect(result).toEqual({
        type: 'dialog',
        dialog: 'hooks',
      });
    });

    it('should open hooks management dialog even if hook system is not available', async () => {
      mockConfig.getHookSystem = vi.fn().mockReturnValue(null);

      const result = await hooksCommand.action!(mockContext, '');

      expect(result).toEqual({
        type: 'dialog',
        dialog: 'hooks',
      });
    });
  });

  describe('non-interactive list output', () => {
    function makeContext(opts: {
      configHooks: Array<{
        eventName: string;
        matcher?: string;
        source: string;
        config: {
          type: string;
          command?: string;
          url?: string;
          name?: string;
        };
      }>;
      sessionHooks?: Array<{
        eventName: string;
        matcher?: string;
        config: { type: string; command?: string; name?: string };
      }>;
    }) {
      const sessionConfig = {
        getHookSystem: vi.fn().mockReturnValue({
          getRegistry: vi.fn().mockReturnValue({
            getAllHooks: vi.fn().mockReturnValue(opts.configHooks),
          }),
          getSessionHooksManager: vi.fn().mockReturnValue({
            getAllSessionHooks: vi
              .fn()
              .mockReturnValue(opts.sessionHooks ?? []),
          }),
        }),
        getSessionId: vi.fn().mockReturnValue('sid'),
      };
      return createMockCommandContext({
        executionMode: 'non_interactive',
        services: { config: sessionConfig },
      });
    }

    it('groups hooks under matcher headings', async () => {
      const ctx = makeContext({
        configHooks: [
          {
            eventName: 'PreToolUse',
            matcher: 'Bash',
            source: 'user',
            config: { type: 'command', command: '/check-bash.sh' },
          },
          {
            eventName: 'PreToolUse',
            matcher: 'Edit|Write',
            source: 'project',
            config: { type: 'command', command: '/format.sh' },
          },
        ],
      });

      const result = await hooksCommand.action!(ctx, '');
      expect(result).toBeDefined();
      const content = (result as { content: string }).content;

      expect(content).toContain('### PreToolUse');
      expect(content).toContain('#### Matcher: Bash');
      expect(content).toContain('/check-bash.sh');
      expect(content).toContain('#### Matcher: Edit|Write');
      expect(content).toContain('/format.sh');
    });

    it('renders missing matcher as *', async () => {
      const ctx = makeContext({
        configHooks: [
          {
            eventName: 'PreToolUse',
            source: 'user',
            config: { type: 'command', command: '/anything.sh' },
          },
        ],
      });

      const result = await hooksCommand.action!(ctx, '');
      const content = (result as { content: string }).content;

      expect(content).toContain('#### Matcher: *');
      expect(content).toContain('/anything.sh');
    });

    it('does not emit a Matcher heading for non-matcher events like Stop', async () => {
      const ctx = makeContext({
        configHooks: [
          {
            eventName: 'Stop',
            source: 'user',
            config: { type: 'command', command: '/stop-hook.sh' },
          },
        ],
      });

      const result = await hooksCommand.action!(ctx, '');
      const content = (result as { content: string }).content;

      expect(content).toContain('### Stop');
      expect(content).not.toContain('Matcher:');
      expect(content).toContain('/stop-hook.sh');
    });

    it('preserves registration order for non-matcher events with ignored matchers', async () => {
      const ctx = makeContext({
        configHooks: [
          {
            eventName: 'Stop',
            matcher: 'A',
            source: 'user',
            config: { type: 'command', command: '/first.sh' },
          },
          {
            eventName: 'Stop',
            matcher: 'B',
            source: 'user',
            config: { type: 'command', command: '/second.sh' },
          },
          {
            eventName: 'Stop',
            matcher: 'A',
            source: 'user',
            config: { type: 'command', command: '/third.sh' },
          },
        ],
      });

      const result = await hooksCommand.action!(ctx, '');
      const content = (result as { content: string }).content;

      expect(content).not.toContain('Matcher:');
      expect(content.indexOf('/first.sh')).toBeLessThan(
        content.indexOf('/second.sh'),
      );
      expect(content.indexOf('/second.sh')).toBeLessThan(
        content.indexOf('/third.sh'),
      );
    });

    it('groups session hooks by their matcher alongside config hooks', async () => {
      const ctx = makeContext({
        configHooks: [
          {
            eventName: 'PreToolUse',
            matcher: 'Bash',
            source: 'user',
            config: { type: 'command', command: '/persistent.sh' },
          },
        ],
        sessionHooks: [
          {
            eventName: 'PreToolUse',
            matcher: 'Bash',
            config: { type: 'command', command: '/session.sh' },
          },
        ],
      });

      const result = await hooksCommand.action!(ctx, '');
      const content = (result as { content: string }).content;

      const matcherOccurrences = content.match(/#### Matcher: Bash/g) ?? [];
      expect(matcherOccurrences).toHaveLength(1);
      expect(content).toContain('/persistent.sh');
      expect(content).toContain('/session.sh');
    });
  });
});
