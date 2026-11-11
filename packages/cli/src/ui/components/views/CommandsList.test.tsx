/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { renderWithProviders } from '../../../test-utils/render.js';
import { describe, it, expect } from 'vitest';
import { CommandsList } from './CommandsList.js';
import { CommandKind, type SlashCommand } from '../../commands/types.js';
import { createMockSettings } from '../../../test-utils/settings.js';
import { CommandDescriptionContext } from '../../contexts/CommandDescriptionContext.js';

describe('CommandsList Component', () => {
  it('passes product keys to the description resolver', async () => {
    const keys = { upgrade: 'product.upgrade' };
    const rendered = await renderWithProviders(
      <CommandDescriptionContext.Provider value={keys}>
        <CommandsList />
      </CommandDescriptionContext.Provider>,
      {
        settings: createMockSettings({ ui: { language: 'zh-CN' } }),
        uiState: {
          slashCommands: [
            {
              name: 'upgrade',
              description: 'Original upgrade',
              kind: CommandKind.BUILT_IN,
            },
          ],
        },
      },
    );
    expect(rendered.lastFrame()).toContain('product.upgrade');
    rendered.unmount();
  });
  it('should render "No commands available." when there are no commands', async () => {
    const { lastFrame, unmount } = await renderWithProviders(<CommandsList />, {
      uiState: { slashCommands: [] },
    });

    expect(lastFrame()).toContain('No commands available.');

    unmount();
  });

  it('should render built-in command names', async () => {
    const commands: SlashCommand[] = [
      {
        name: 'help',
        description: 'Show help',
        kind: CommandKind.BUILT_IN,
      },
    ];

    const { lastFrame, unmount } = await renderWithProviders(<CommandsList />, {
      uiState: { slashCommands: commands },
    });

    expect(lastFrame()).toContain('/help');

    unmount();
  });

  it('should render displayName for MCP prompt commands instead of the internal name', async () => {
    const commands: SlashCommand[] = [
      {
        name: 'mcp__server__prompt',
        displayName: 'server:prompt (MCP)',
        description: 'An MCP prompt',
        kind: CommandKind.MCP_PROMPT,
      },
    ];

    const { lastFrame, unmount } = await renderWithProviders(<CommandsList />, {
      uiState: { slashCommands: commands },
    });
    const output = lastFrame();

    expect(output).toContain('/server:prompt (MCP)');
    expect(output).not.toContain('mcp__server__prompt');

    unmount();
  });

  it('should fall back to name for MCP prompt commands without displayName', async () => {
    const commands: SlashCommand[] = [
      {
        name: 'mcp__server__prompt',
        description: 'An MCP prompt',
        kind: CommandKind.MCP_PROMPT,
      },
    ];

    const { lastFrame, unmount } = await renderWithProviders(<CommandsList />, {
      uiState: { slashCommands: commands },
    });

    expect(lastFrame()).toContain('/mcp__server__prompt');

    unmount();
  });

  it('localizes built-in UI while preserving external command text', async () => {
    const commands: SlashCommand[] = [
      {
        name: 'help',
        description: 'Show application help and keyboard shortcuts',
        kind: CommandKind.BUILT_IN,
      },
      {
        name: 'deploy',
        description: 'Provided by a plugin',
        kind: CommandKind.PLUGIN,
      },
    ];

    const { lastFrame, unmount } = await renderWithProviders(<CommandsList />, {
      settings: createMockSettings({ ui: { language: 'zh-CN' } }),
      uiState: { slashCommands: commands },
    });
    const output = lastFrame();

    expect(output).toContain('命令');
    expect(output).toContain('内置 (1)');
    expect(output).toContain('显示应用帮助和键盘快捷键');
    expect(output).toContain('/help');
    expect(output).toContain('Esc 返回');
    expect(output).not.toContain('Esc back');
    unmount();
  });
});
