/**
 * @license
 * Copyright 2025 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, vi } from 'vitest';
import { agentsCommand } from './agentsCommand.js';
import type { CommandContext } from './types.js';
import { MessageType } from '../types.js';

function createMockContext(
  overrides?: Partial<CommandContext>,
): CommandContext {
  return {
    services: {
      agentContext: {
        config: {
          getAgentRegistry: vi.fn().mockReturnValue({
            reload: vi.fn().mockResolvedValue(undefined),
            getAllDiscoveredAgentNames: vi
              .fn()
              .mockReturnValue(['agent-a', 'agent-b']),
            getLoadErrors: vi.fn().mockReturnValue([]),
          }),
        },
      } as unknown as CommandContext['services']['agentContext'],
      settings: {} as unknown as CommandContext['services']['settings'],
      logger: {} as unknown as CommandContext['services']['logger'],
    },
    ui: {
      addItem: vi.fn(),
      clear: vi.fn(),
      setDebugMessage: vi.fn(),
      pendingItem: null,
      setPendingItem: vi.fn(),
      loadHistory: vi.fn(),
      removeComponent: vi.fn(),
    },
    ...overrides,
  } as unknown as CommandContext;
}

describe('agentsCommand', () => {
  it('should return agentBrowser dialog action when no args', async () => {
    const context = createMockContext();
    const result = await agentsCommand.action!(context, '');

    expect(result).toEqual({
      type: 'dialog',
      dialog: 'agentBrowser',
    });
  });

  it('should have subCommands (reload)', () => {
    expect(agentsCommand.subCommands).toBeDefined();
    expect(agentsCommand.subCommands).toHaveLength(1);
    expect(agentsCommand.subCommands![0].name).toBe('reload');
  });

  it('should have correct name and description', () => {
    expect(agentsCommand.name).toBe('agents');
    expect(agentsCommand.description).toBe('Manage agents');
  });

  it('should reload agents for /agents reload', async () => {
    const context = createMockContext();
    await agentsCommand.action!(context, 'reload');

    const registry = context.services.agentContext!.config.getAgentRegistry();
    expect(registry.reload).toHaveBeenCalled();
    expect(context.ui.addItem).toHaveBeenCalledWith(
      expect.objectContaining({
        type: MessageType.INFO,
        text: expect.stringContaining('2 agent(s) discovered'),
      }),
      expect.any(Number),
    );
  });

  it('should show warning when /agents reload has load errors', async () => {
    const context = createMockContext();
    const registry = context.services.agentContext!.config.getAgentRegistry();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (registry.getLoadErrors as any).mockReturnValue([
      {
        filePath: '/tmp/bad-agent.md',
        message: 'missing required field: description',
        configType: 'agent',
        source: 'project',
      },
      {
        filePath: '/tmp/legacy-agent.md',
        message: 'using fallback parser',
        configType: 'agent',
        source: 'user',
        severity: 'warning',
      },
    ]);

    await agentsCommand.action!(context, 'reload');

    expect(context.ui.addItem).toHaveBeenCalledWith(
      expect.objectContaining({
        type: MessageType.WARNING,
        text: expect.stringContaining(
          '1 error, 1 warning loading agent configs',
        ),
      }),
      expect.any(Number),
    );
    expect(context.ui.addItem).toHaveBeenCalledWith(
      expect.objectContaining({
        text: expect.stringContaining('Use /agents to see details.'),
      }),
      expect.any(Number),
    );
  });

  it('should show error when agent context is not available', async () => {
    const context = createMockContext({
      services: {
        agentContext: null,
        settings: {} as unknown as CommandContext['services']['settings'],
        logger: {} as unknown as CommandContext['services']['logger'],
      },
    });
    await agentsCommand.action!(context, 'reload');

    expect(context.ui.addItem).toHaveBeenCalledWith(
      expect.objectContaining({
        type: MessageType.ERROR,
        text: 'Agent context is not available.',
      }),
    );
  });

  it('should handle reload errors gracefully', async () => {
    const context = createMockContext();
    const registry = context.services.agentContext!.config.getAgentRegistry();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (registry.reload as any).mockRejectedValue(new Error('disk error'));

    await agentsCommand.action!(context, 'reload');

    expect(context.ui.addItem).toHaveBeenCalledWith(
      expect.objectContaining({
        type: MessageType.ERROR,
        text: expect.stringContaining('disk error'),
      }),
      expect.any(Number),
    );
  });
});
