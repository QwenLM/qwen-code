/**
 * @license
 * Copyright 2026 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import { afterEach, expect, it, vi } from 'vitest';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { cleanup } from 'ink-testing-library';
import { renderWithProviders, withProviders } from '../../test-utils/render.js';
import { themeManager } from '../themes/theme-manager.js';
import { MarkdownDisplay } from './MarkdownDisplay.js';
import { UserMessage } from '../components/messages/ConversationMessages.js';

const codeBranch = vi.hoisted(() => ({ isolate: false }));
vi.mock('./pending-rendered-height.js', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('./pending-rendered-height.js')>();
  return {
    ...actual,
    fitPendingSlice: (...args: Parameters<typeof actual.fitPendingSlice>) =>
      codeBranch.isolate
        ? { keptLines: args[0].length, renderedHeight: 0 }
        : actual.fitPendingSlice(...args),
  };
});

const originalTheme = themeManager.getActiveTheme().name;
// pnpm gives Ink its own Chalk instance; its color level controls painted boxes.
const requireFromInk = createRequire(
  createRequire(import.meta.url).resolve('ink'),
);
const chalk: { level: number } = (
  await import(pathToFileURL(requireFromInk.resolve('chalk')).href)
).default;
const originalLevel = chalk.level;

afterEach(() => {
  cleanup();
  themeManager.setActiveTheme(originalTheme);
  chalk.level = originalLevel;
  codeBranch.isolate = false;
});

it.each([1, 3])(
  'PR17541 R1-11 paints the actual pending code branch at %i rows and after commit',
  (height) => {
    chalk.level = 3;
    // Isolate the code block's own budget from Markdown's earlier pre-slice.
    codeBranch.isolate = true;
    themeManager.setActiveTheme('Qwen Dark');
    const tree = (isPending: boolean) => (
      <MarkdownDisplay
        text={
          '```text\nBRANCH_LINE_1\nBRANCH_LINE_2\nBRANCH_LINE_3\nBRANCH_LAST'
        }
        isPending={isPending}
        contentWidth={60}
        availableTerminalHeight={height}
      />
    );
    const view = renderWithProviders(tree(true));
    expect(view.lastFrame()).toContain('\x1b[48;2;28;28;28m');
    expect(view.lastFrame()).not.toContain('BRANCH_LAST');
    expect(view.lastFrame()).toContain(
      height === 1 ? 'code is being written' : 'BRANCH_LINE_1',
    );
    view.rerender(withProviders(tree(false)));
    expect(view.lastFrame()).toContain('\x1b[48;2;28;28;28m');
    expect(view.lastFrame()).toContain('BRANCH_LAST');
    view.unmount();
  },
);

it('paints the real public pending pre-slice and then the complete committed block', () => {
  chalk.level = 3;
  themeManager.setActiveTheme('Qwen Dark');
  const text =
    '```text\n' +
    Array.from({ length: 30 }, (_, index) => `PUBLIC_LINE_${index}`).join('\n');
  const tree = (isPending: boolean) => (
    <MarkdownDisplay
      text={text}
      isPending={isPending}
      contentWidth={60}
      availableTerminalHeight={8}
    />
  );
  const view = renderWithProviders(tree(true));
  expect(view.lastFrame()).toContain('PUBLIC_LINE_0');
  expect(view.lastFrame()).not.toContain('PUBLIC_LINE_29');
  expect(view.lastFrame()).toContain('\x1b[48;2;28;28;28m');
  view.rerender(withProviders(tree(false)));
  expect(view.lastFrame()).toContain('PUBLIC_LINE_29');
  expect(view.lastFrame()).toContain('\x1b[48;2;28;28;28m');
  view.unmount();
});

it('PR17541 R1-11 paints the configured user-message surface', () => {
  chalk.level = 3;
  themeManager.setActiveTheme('Qwen Dark');
  const view = renderWithProviders(<UserMessage text="SURFACE_USER_WITNESS" />);
  expect(view.lastFrame()).toContain('\x1b[48;2;36;36;36m');
  view.unmount();
});
