/** @jsxImportSource @opentui/react */
// @vitest-environment jsdom
/**
 * @license
 * Copyright 2026 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Component tests for the OpenTUI help overlay (#10728 test-hardening
 * slice): the overlay is pure presentation fed by help-content.ts, so these
 * pin the tab bar, the tab bodies (general grid, built-in vs custom command
 * listings), the 18-line scroll window with its visible-range indicator,
 * and the always-rendered docs footer / key hints. Key handling itself
 * lives in the composer backend and is covered there.
 */

import { render, screen } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { SlashCommand } from '../commands/types.js';
import {
  HELP_COMMAND_LIST_VISIBLE_LINES,
  HELP_DOCS_URL,
  HELP_TABS,
} from './help-content.js';

const mocks = vi.hoisted(() => {
  async function buildJsxRuntime() {
    const React = await import('react');
    const jsx = (
      type: unknown,
      props: { children?: unknown; key?: React.Key } | null,
      key?: React.Key,
    ) => {
      const config = key === undefined ? props : { ...props, key };
      const children = (config?.children ?? null) as React.ReactNode;
      if (type === 'box' || type === 'text') {
        return React.createElement(
          type === 'box' ? 'div' : 'span',
          key === undefined ? null : { key },
          children,
        );
      }
      return React.createElement(
        type as React.ElementType,
        config as Record<string, unknown>,
        children,
      );
    };
    return { jsx, jsxs: jsx, jsxDEV: jsx, Fragment: React.Fragment };
  }
  return { buildJsxRuntime };
});

vi.mock('@opentui/react/jsx-runtime', () => mocks.buildJsxRuntime());
vi.mock('@opentui/react/jsx-dev-runtime', () => mocks.buildJsxRuntime());
vi.mock('./theme.js', () => ({
  C: new Proxy({}, { get: () => '#ffffff' }),
}));

import { HelpOverlay, helpScrollMax } from './help-overlay.js';

const command = (over: Partial<SlashCommand>): SlashCommand =>
  ({ ...over }) as SlashCommand;

const BUILT_INS: SlashCommand[] = [
  command({
    name: 'help',
    description: 'Show help',
    source: 'builtin-command',
  }),
  command({
    name: 'model',
    description: 'Switch the active model',
    argumentHint: '[name]',
    source: 'builtin-command',
  }),
  command({
    name: 'stats',
    description: 'Show session statistics',
    source: 'builtin-command',
  }),
];

const CUSTOM: SlashCommand[] = [
  command({
    name: 'deploy',
    description: 'Ship the current branch',
    source: 'skill-dir-command',
  }),
];

function renderOverlay(props: Partial<Parameters<typeof HelpOverlay>[0]> = {}) {
  return render(
    <HelpOverlay
      commands={BUILT_INS}
      tab="general"
      scroll={0}
      bodyRows={30}
      width={100}
      {...props}
    />,
  );
}

describe('HelpOverlay tab bar', () => {
  it('renders every tab label with the requested tab active', () => {
    renderOverlay({ tab: 'commands' });
    for (const { label } of HELP_TABS) {
      // Tab labels render padded (' general '); query the normalized form.
      expect(screen.getAllByText(label).length).toBeGreaterThan(0);
    }
    // The Qwen Code header stays next to the tab bar on every tab.
    expect(screen.getByText('Qwen Code')).toBeTruthy();
  });

  it('keeps the docs footer and key hints rendered on every tab', () => {
    for (const tab of HELP_TABS.map((t) => t.tab)) {
      const { unmount } = renderOverlay({ tab });
      expect(screen.getByText(HELP_DOCS_URL)).toBeTruthy();
      expect(
        screen.getByText('Tab/Shift+Tab to switch tabs · Esc to cancel'),
      ).toBeTruthy();
      unmount();
    }
  });
});

describe('HelpOverlay general tab', () => {
  it('shows the intro line and the shortcut grid from help-content', () => {
    renderOverlay();
    expect(screen.getByText(/makes edits with your permission/)).toBeTruthy();
    expect(screen.getByText('Shortcuts')).toBeTruthy();
    expect(screen.getByText('@')).toBeTruthy();
    expect(screen.getByText('Run shell commands')).toBeTruthy();
  });
});

describe('HelpOverlay commands tab', () => {
  it('lists built-in commands under a counted group header', () => {
    renderOverlay({ tab: 'commands', commands: [...BUILT_INS, ...CUSTOM] });
    // The group header and its count are sibling text runs in one line.
    expect(screen.getByText('Built-in Commands')).toBeTruthy();
    expect(screen.getByText('(3)')).toBeTruthy();
    expect(screen.getByText('/help')).toBeTruthy();
    expect(screen.getByText('Show help')).toBeTruthy();
    // argumentHint joins the signature line.
    expect(screen.getByText('/model [name]')).toBeTruthy();
    // Custom commands live on their own tab, never the built-in listing.
    expect(screen.queryByText('/deploy')).toBeNull();
  });

  it('shows the empty state when no commands match the tab', () => {
    renderOverlay({ tab: 'commands', commands: [] });
    expect(
      screen.getByText('No commands are currently available.'),
    ).toBeTruthy();
  });

  it('hides the scroll hint while the listing fits the window', () => {
    renderOverlay({ tab: 'commands' });
    expect(screen.queryByText(/Use ↑\/↓ to scroll/)).toBeNull();
    expect(helpScrollMax([])).toBe(0);
  });

  it('caps the listing to the scroll window and reports the visible range', () => {
    const many = Array.from({ length: 12 }, (_, i) =>
      command({
        name: `cmd${String(i + 1).padStart(2, '0')}`,
        description: `does thing ${i + 1}`,
        source: 'builtin-command',
      }),
    );
    const initial = renderOverlay({ tab: 'commands', commands: many });
    // 1 group header + 24 command lines = 25 lines > 18 visible rows.
    expect(screen.getByText(/Use ↑\/↓ to scroll \(1-9\/12\)/)).toBeTruthy();
    expect(screen.getByText('/cmd01')).toBeTruthy();
    expect(screen.queryByText('/cmd12')).toBeNull();
    initial.unmount();

    // Oversized scroll clamps to maxScroll (25 - 18 = 7), not past the end.
    renderOverlay({ tab: 'commands', commands: many, scroll: 10_000 });
    expect(screen.getByText(/Use ↑\/↓ to scroll \(4-12\/12\)/)).toBeTruthy();
    expect(screen.queryByText('/cmd01')).toBeNull();
    expect(screen.getByText('/cmd12')).toBeTruthy();
    expect(
      helpScrollMax([
        ...Array.from({ length: 30 }, () => ({
          type: 'signature' as const,
          text: 'x',
          meta: '',
        })),
      ]),
    ).toBe(30 - HELP_COMMAND_LIST_VISIBLE_LINES);
  });
});

describe('HelpOverlay custom-commands tab', () => {
  it('lists non-built-in commands in their own groups', () => {
    renderOverlay({
      tab: 'custom-commands',
      commands: [...BUILT_INS, ...CUSTOM],
    });
    expect(screen.getByText('Custom Commands')).toBeTruthy();
    expect(screen.getByText('(1)')).toBeTruthy();
    expect(screen.getByText('/deploy')).toBeTruthy();
    expect(screen.queryByText('/help')).toBeNull();
  });

  it('shows the empty state when only built-ins exist', () => {
    renderOverlay({ tab: 'custom-commands', commands: BUILT_INS });
    expect(
      screen.getByText('No custom commands are currently available.'),
    ).toBeTruthy();
  });
});
