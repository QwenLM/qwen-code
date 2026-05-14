/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/** @vitest-environment jsdom */

import React, { act } from 'react';
import { render } from 'ink-testing-library';
import { describe, it, expect, vi } from 'vitest';
import { Help } from './Help.js';
import type { SlashCommand } from '../commands/types.js';
import { CommandKind } from '../commands/types.js';
import type { HelpTab } from '../contexts/UIActionsContext.js';

const mockCommands: readonly SlashCommand[] = [
  {
    name: 'test',
    description: 'A test command',
    kind: CommandKind.BUILT_IN,
    source: 'builtin-command',
    sourceLabel: 'Built-in',
    supportedModes: ['interactive'],
    argumentHint: '[value]',
    altNames: ['alias-one', 'alias-two'],
  },
  {
    name: 'review',
    description: 'Review changed code',
    kind: CommandKind.SKILL,
    source: 'bundled-skill',
    sourceLabel: 'Skill',
    supportedModes: ['interactive', 'non_interactive', 'acp'],
    argumentHint: '[pr-number]',
    modelInvocable: true,
  },
  {
    name: 'custom',
    description: 'A custom command',
    kind: CommandKind.FILE,
    source: 'skill-dir-command',
    sourceLabel: 'Custom',
    sourceDetail: 'custom',
  },
  {
    name: 'plugin-cmd',
    description: 'A plugin command',
    kind: CommandKind.FILE,
    source: 'plugin-command',
    sourceLabel: 'Plugin: demo',
  },
  {
    name: 'mcp-prompt',
    description: 'An MCP prompt',
    kind: CommandKind.MCP_PROMPT,
    source: 'mcp-prompt',
    sourceLabel: 'MCP: demo',
  },
  {
    name: 'hidden',
    description: 'A hidden command',
    hidden: true,
    kind: CommandKind.BUILT_IN,
    source: 'builtin-command',
  },
  {
    name: 'parent',
    description: 'A parent command',
    kind: CommandKind.BUILT_IN,
    source: 'builtin-command',
    sourceLabel: 'Built-in',
    subCommands: [
      {
        name: 'visible-child',
        description: 'A visible child command',
        kind: CommandKind.BUILT_IN,
      },
      {
        name: 'hidden-child',
        description: 'A hidden child command',
        hidden: true,
        kind: CommandKind.BUILT_IN,
      },
    ],
  },
];

const keypressSubscribers = new Set<(key: KeypressTestKey) => void>();
type KeypressTestKey = {
  name: string;
  shift?: boolean;
};

vi.mock('../contexts/KeypressContext.js', () => ({
  useKeypressContext: () => ({
    subscribe: (handler: (key: KeypressTestKey) => void) => {
      keypressSubscribers.add(handler);
    },
    unsubscribe: (handler: (key: KeypressTestKey) => void) => {
      keypressSubscribers.delete(handler);
    },
  }),
}));

function sendKey(key: KeypressTestKey) {
  act(() => {
    for (const handler of keypressSubscribers) {
      handler(key);
    }
  });
}

const InteractiveHelpHarness = ({
  onClose,
  commands = mockCommands,
  initialTab = 'general',
}: {
  onClose: () => void;
  commands?: readonly SlashCommand[];
  initialTab?: HelpTab;
}) => {
  const [tab, setTab] = React.useState<HelpTab>(initialTab);
  return (
    <Help
      commands={commands}
      width={130}
      activeTab={tab}
      onTabChange={setTab}
      onClose={onClose}
      isInteractive
    />
  );
};

describe('Help Component', () => {
  it('renders Claude Code style tabs and the general page by default', () => {
    const { lastFrame } = render(<Help commands={mockCommands} width={100} />);
    const output = lastFrame();

    expect(output).toContain('Qwen Code');
    expect(output).toContain('general');
    expect(output).toContain('commands');
    expect(output).toContain('custom-commands');
    expect(output).toContain('Shortcuts');
    expect(output).toContain('Esc to cancel');
    expect(output).not.toContain('/help commands');
  });

  it('renders built-in commands in the commands tab without custom command clutter', () => {
    const { lastFrame } = render(
      <Help commands={mockCommands} width={110} activeTab="commands" />,
    );
    const output = lastFrame();

    expect(output).toContain('Built-in Commands');
    expect(output).toContain('/test [value]');
    expect(output).toContain('[interactive]');
    expect(output).toContain('/parent');
    expect(output).toContain('visible-child');
    expect(output).not.toContain('hidden-child');
    expect(output).not.toContain('/hidden');
    expect(output).not.toContain('/custom');
  });

  it('renders custom, skill, plugin, and MCP commands in the custom tab', () => {
    const { lastFrame } = render(
      <Help commands={mockCommands} width={130} activeTab="custom-commands" />,
    );
    const output = lastFrame();

    expect(output).toContain('Bundled Skills');
    expect(output).toContain('Custom Commands');
    expect(output).toContain('Plugin Commands');
    expect(output).toContain('MCP Commands');
    expect(output).toContain('/review [pr-number]');
    expect(output).toContain('[Skill]');
    expect(output).toContain('[all]');
    expect(output).toContain('[model]');
    expect(output).toContain('/custom');
    expect(output).toContain('[Custom]');
    expect(output).toContain('/plugin-cmd');
    expect(output).toContain('[Plugin]');
    expect(output).toContain('/mcp-prompt');
    expect(output).toContain('[MCP]');
    expect(output).not.toContain('/test');
  });

  it('switches tabs with Tab and Shift+Tab when interactive', () => {
    const onClose = vi.fn();
    const { lastFrame } = render(<InteractiveHelpHarness onClose={onClose} />);

    expect(lastFrame()).toContain('Shortcuts');

    sendKey({ name: 'tab' });
    expect(lastFrame()).toContain('Built-in Commands');

    sendKey({ name: 'tab' });
    expect(lastFrame()).toContain('Custom Commands');

    sendKey({ name: 'tab', shift: true });
    expect(lastFrame()).toContain('Built-in Commands');
  });

  it('scrolls long command lists with the up and down keys', () => {
    const manyCommands: SlashCommand[] = Array.from(
      { length: 12 },
      (_, index): SlashCommand => ({
        name: `cmd-${String(index).padStart(2, '0')}`,
        description: `Command ${index} description`,
        kind: CommandKind.BUILT_IN,
        source: 'builtin-command',
        sourceLabel: 'Built-in',
      }),
    );
    const { lastFrame } = render(
      <InteractiveHelpHarness
        onClose={vi.fn()}
        commands={manyCommands}
        initialTab="commands"
      />,
    );

    expect(lastFrame()).toContain('/cmd-00');
    expect(lastFrame()).not.toContain('/cmd-11');
    expect(lastFrame()).toContain('Use ↑/↓ to scroll');

    sendKey({ name: 'down' });
    sendKey({ name: 'down' });
    expect(lastFrame()).not.toContain('/cmd-00');

    sendKey({ name: 'pagedown' });
    expect(lastFrame()).toContain('/cmd-11');

    sendKey({ name: 'pageup' });
    expect(lastFrame()).toContain('/cmd-00');
  });

  it('resets scroll position when switching command tabs', () => {
    const mixedCommands: SlashCommand[] = [
      ...Array.from(
        { length: 12 },
        (_, index): SlashCommand => ({
          name: `builtin-${String(index).padStart(2, '0')}`,
          description: `Built-in ${index} description`,
          kind: CommandKind.BUILT_IN,
          source: 'builtin-command',
          sourceLabel: 'Built-in',
        }),
      ),
      ...Array.from(
        { length: 12 },
        (_, index): SlashCommand => ({
          name: `skill-${String(index).padStart(2, '0')}`,
          description: `Skill ${index} description`,
          kind: CommandKind.SKILL,
          source: 'bundled-skill',
          sourceLabel: 'Skill',
        }),
      ),
    ];
    const { lastFrame } = render(
      <InteractiveHelpHarness
        onClose={vi.fn()}
        commands={mixedCommands}
        initialTab="commands"
      />,
    );

    sendKey({ name: 'pagedown' });
    expect(lastFrame()).not.toContain('/builtin-00');

    sendKey({ name: 'tab' });
    expect(lastFrame()).toContain('/skill-00');
  });

  it('closes with Escape when interactive', () => {
    const onClose = vi.fn();
    render(<InteractiveHelpHarness onClose={onClose} />);

    sendKey({ name: 'escape' });

    expect(onClose).toHaveBeenCalledOnce();
  });
});
