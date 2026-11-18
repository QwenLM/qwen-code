/**
 * @license
 * Copyright 2026 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import { afterEach, expect, it } from 'vitest';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { cleanup } from 'ink-testing-library';
import { renderWithProviders, withProviders } from '../../test-utils/render.js';
import { themeManager } from '../themes/theme-manager.js';
import { MarkdownDisplay } from './MarkdownDisplay.js';
import { UserMessage } from '../components/messages/ConversationMessages.js';

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
});

it('PR17541 R1-11 paints the configured code surface before and after streaming commits', () => {
  chalk.level = 3;
  themeManager.setActiveTheme('Qwen Dark');
  const tree = (isPending: boolean) => (
    <MarkdownDisplay
      text={'```text\nSURFACE_CODE_WITNESS\n```\n\n'}
      isPending={isPending}
      contentWidth={60}
      availableTerminalHeight={20}
    />
  );
  const view = renderWithProviders(tree(true));
  expect(view.lastFrame()).toContain('\x1b[48;2;28;28;28m');
  view.rerender(withProviders(tree(false)));
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
