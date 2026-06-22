/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it, vi } from 'vitest';
import type { LspClient } from '@qwen-code/qwen-code-core';
import { createMockCommandContext } from '../../test-utils/mockCommandContext.js';
import { MessageType } from '../types.js';
import { lspCommand } from './lspCommand.js';

const createConfig = ({
  enabled = true,
  client,
}: {
  enabled?: boolean;
  client?: Partial<LspClient>;
}) => ({
  isLspEnabled: vi.fn().mockReturnValue(enabled),
  getLspClient: vi.fn().mockReturnValue(client),
});

describe('lspCommand', () => {
  it('returns an error when config is unavailable in non-interactive mode', async () => {
    if (!lspCommand.action) {
      throw new Error('lspCommand must have an action');
    }
    const context = createMockCommandContext({
      executionMode: 'non_interactive',
      services: { config: null },
    });

    const result = await lspCommand.action(context, '');

    expect(result).toEqual({
      type: 'message',
      messageType: 'error',
      content: 'Config not available.',
    });
    expect(context.ui.addItem).not.toHaveBeenCalled();
  });

  it('returns disabled guidance in non-interactive mode', async () => {
    if (!lspCommand.action) {
      throw new Error('lspCommand must have an action');
    }
    const context = createMockCommandContext({
      executionMode: 'non_interactive',
      services: {
        config: createConfig({ enabled: false }) as unknown as never,
      },
    });

    const result = await lspCommand.action(context, '');

    expect(result).toMatchObject({
      type: 'message',
      messageType: 'info',
      content: expect.stringContaining('--experimental-lsp'),
    });
    expect(context.ui.addItem).not.toHaveBeenCalled();
  });

  it('returns guidance when LSP is enabled but no client is connected', async () => {
    if (!lspCommand.action) {
      throw new Error('lspCommand must have an action');
    }
    const context = createMockCommandContext({
      executionMode: 'non_interactive',
      services: {
        config: createConfig({ client: undefined }) as unknown as never,
      },
    });

    const result = await lspCommand.action(context, '');

    expect(result).toMatchObject({
      type: 'message',
      messageType: 'info',
      content: expect.stringContaining('QWEN_RUNTIME_DIR'),
    });
    expect(context.ui.addItem).not.toHaveBeenCalled();
  });

  it('handles clients that do not expose server status', async () => {
    if (!lspCommand.action) {
      throw new Error('lspCommand must have an action');
    }
    const context = createMockCommandContext({
      executionMode: 'non_interactive',
      services: {
        config: createConfig({ client: {} }) as unknown as never,
      },
    });

    const result = await lspCommand.action(context, '');

    expect(result).toEqual({
      type: 'message',
      messageType: 'info',
      content: 'LSP is enabled, but server status is unavailable.',
    });
    expect(context.ui.addItem).not.toHaveBeenCalled();
  });

  it('reports when no LSP servers are configured', async () => {
    if (!lspCommand.action) {
      throw new Error('lspCommand must have an action');
    }
    const context = createMockCommandContext({
      executionMode: 'non_interactive',
      services: {
        config: createConfig({
          client: { getServerStatus: vi.fn().mockReturnValue([]) },
        }) as unknown as never,
      },
    });

    const result = await lspCommand.action(context, '');

    expect(result).toMatchObject({
      type: 'message',
      messageType: 'info',
      content: expect.stringContaining('No LSP servers configured'),
    });
    expect(context.ui.addItem).not.toHaveBeenCalled();
  });

  it('renders mixed server status without emoji in non-interactive mode', async () => {
    if (!lspCommand.action) {
      throw new Error('lspCommand must have an action');
    }
    const context = createMockCommandContext({
      executionMode: 'non_interactive',
      services: {
        config: createConfig({
          client: {
            getServerStatus: vi.fn().mockReturnValue([
              {
                name: 'clangd',
                status: 'READY',
                command: 'clangd',
                languages: ['c', 'cpp'],
              },
              {
                name: 'pyright',
                status: 'FAILED',
                command: 'pyright-langserver',
                languages: ['python'],
                error: 'startup failed',
              },
            ]),
          },
        }) as unknown as never,
      },
    });

    const result = await lspCommand.action(context, '');

    expect(result).toMatchObject({
      type: 'message',
      messageType: 'info',
      content: expect.stringContaining('**LSP Server Status**'),
    });
    if (!result || result.type !== 'message') {
      throw new Error('Expected message result');
    }
    expect(result.content).toContain('| clangd | `clangd` | c, cpp | READY |');
    expect(result.content).toContain(
      '| pyright | `pyright-langserver` | python | FAILED - startup failed |',
    );
    expect(result.content).not.toMatch(/[✅⏳❌⚪❓]/u);
    expect(context.ui.addItem).not.toHaveBeenCalled();
  });

  it('adds the rendered status to history in interactive mode', async () => {
    if (!lspCommand.action) {
      throw new Error('lspCommand must have an action');
    }
    const context = createMockCommandContext({
      services: {
        config: createConfig({
          client: {
            getServerStatus: vi.fn().mockReturnValue([
              {
                name: 'clangd',
                status: 'READY',
                command: 'clangd',
                languages: ['cpp'],
              },
            ]),
          },
        }) as unknown as never,
      },
    });

    const result = await lspCommand.action(context, '');

    expect(result).toBeUndefined();
    expect(context.ui.addItem).toHaveBeenCalledWith(
      {
        type: MessageType.INFO,
        text: expect.stringContaining('| clangd | `clangd` | cpp | READY |'),
      },
      expect.any(Number),
    );
  });
});
