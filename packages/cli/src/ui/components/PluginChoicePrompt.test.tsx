/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render } from 'ink-testing-library';
import { PluginChoicePrompt } from './PluginChoicePrompt.js';
import { useKeypress } from '../hooks/useKeypress.js';

vi.mock('../hooks/useKeypress.js', () => ({
  useKeypress: vi.fn(),
}));

const mockedUseKeypress = vi.mocked(useKeypress);

describe('PluginChoicePrompt', () => {
  const onSelect = vi.fn();
  const onCancel = vi.fn();
  const terminalWidth = 80;

  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('rendering', () => {
    it('renders marketplace name in title', () => {
      const { lastFrame } = render(
        <PluginChoicePrompt
          marketplaceName="test-marketplace"
          plugins={[{ name: 'plugin1' }]}
          onSelect={onSelect}
          onCancel={onCancel}
          terminalWidth={terminalWidth}
        />,
      );

      expect(lastFrame()).toContain('test-marketplace');
    });

    it('renders plugin names', () => {
      const { lastFrame } = render(
        <PluginChoicePrompt
          marketplaceName="test"
          plugins={[
            { name: 'plugin1', description: 'First plugin' },
            { name: 'plugin2', description: 'Second plugin' },
          ]}
          onSelect={onSelect}
          onCancel={onCancel}
          terminalWidth={terminalWidth}
        />,
      );

      expect(lastFrame()).toContain('plugin1');
      expect(lastFrame()).toContain('plugin2');
    });

    it('renders description for selected plugin only', () => {
      const { lastFrame } = render(
        <PluginChoicePrompt
          marketplaceName="test"
          plugins={[
            { name: 'plugin1', description: 'First plugin description' },
            { name: 'plugin2', description: 'Second plugin description' },
          ]}
          onSelect={onSelect}
          onCancel={onCancel}
          terminalWidth={terminalWidth}
        />,
      );

      // First plugin is selected by default, should show its description
      expect(lastFrame()).toContain('First plugin description');
    });

    it('renders help text', () => {
      const { lastFrame } = render(
        <PluginChoicePrompt
          marketplaceName="test"
          plugins={[{ name: 'plugin1' }]}
          onSelect={onSelect}
          onCancel={onCancel}
          terminalWidth={terminalWidth}
        />,
      );

      expect(lastFrame()).toContain('↑↓');
      expect(lastFrame()).toContain('Enter');
      expect(lastFrame()).toContain('Escape');
    });
  });

  describe('scrolling behavior', () => {
    it('does not show scroll indicators for small lists', () => {
      const { lastFrame } = render(
        <PluginChoicePrompt
          marketplaceName="test"
          plugins={[
            { name: 'plugin1' },
            { name: 'plugin2' },
            { name: 'plugin3' },
          ]}
          onSelect={onSelect}
          onCancel={onCancel}
          terminalWidth={terminalWidth}
        />,
      );

      expect(lastFrame()).not.toContain('more above');
      expect(lastFrame()).not.toContain('more below');
    });

    it('shows "more below" indicator for long lists', () => {
      const plugins = Array.from({ length: 15 }, (_, i) => ({
        name: `plugin${i + 1}`,
      }));

      const { lastFrame } = render(
        <PluginChoicePrompt
          marketplaceName="test"
          plugins={plugins}
          onSelect={onSelect}
          onCancel={onCancel}
          terminalWidth={terminalWidth}
        />,
      );

      // At the beginning, should show "more below" but not "more above"
      expect(lastFrame()).not.toContain('more above');
      expect(lastFrame()).toContain('more below');
    });

    it('shows progress indicator for long lists', () => {
      const plugins = Array.from({ length: 15 }, (_, i) => ({
        name: `plugin${i + 1}`,
      }));

      const { lastFrame } = render(
        <PluginChoicePrompt
          marketplaceName="test"
          plugins={plugins}
          onSelect={onSelect}
          onCancel={onCancel}
          terminalWidth={terminalWidth}
        />,
      );

      // Should show progress like "(1/15)"
      expect(lastFrame()).toContain('(1/15)');
    });
  });

  describe('keyboard navigation', () => {
    it('registers keypress handler', () => {
      render(
        <PluginChoicePrompt
          marketplaceName="test"
          plugins={[{ name: 'plugin1' }]}
          onSelect={onSelect}
          onCancel={onCancel}
          terminalWidth={terminalWidth}
        />,
      );

      expect(mockedUseKeypress).toHaveBeenCalledWith(expect.any(Function), {
        isActive: true,
      });
    });

    it('calls onCancel when escape is pressed', () => {
      render(
        <PluginChoicePrompt
          marketplaceName="test"
          plugins={[{ name: 'plugin1' }]}
          onSelect={onSelect}
          onCancel={onCancel}
          terminalWidth={terminalWidth}
        />,
      );

      const keypressHandler = mockedUseKeypress.mock.calls[0][0];
      keypressHandler({ name: 'escape', sequence: '\x1b' } as never);

      expect(onCancel).toHaveBeenCalled();
    });

    it('calls onSelect with plugin name when enter is pressed', () => {
      render(
        <PluginChoicePrompt
          marketplaceName="test"
          plugins={[{ name: 'test-plugin' }]}
          onSelect={onSelect}
          onCancel={onCancel}
          terminalWidth={terminalWidth}
        />,
      );

      const keypressHandler = mockedUseKeypress.mock.calls[0][0];
      keypressHandler({ name: 'return', sequence: '\r' } as never);

      expect(onSelect).toHaveBeenCalledWith('test-plugin');
    });

    it('calls onSelect with correct plugin when number key 1-9 is pressed', () => {
      render(
        <PluginChoicePrompt
          marketplaceName="test"
          plugins={[
            { name: 'plugin1' },
            { name: 'plugin2' },
            { name: 'plugin3' },
          ]}
          onSelect={onSelect}
          onCancel={onCancel}
          terminalWidth={terminalWidth}
        />,
      );

      const keypressHandler = mockedUseKeypress.mock.calls[0][0];
      keypressHandler({ name: '2', sequence: '2' } as never);

      expect(onSelect).toHaveBeenCalledWith('plugin2');
    });
  });

  describe('selection indicator', () => {
    it('shows selection indicator for first plugin by default', () => {
      const { lastFrame } = render(
        <PluginChoicePrompt
          marketplaceName="test"
          plugins={[{ name: 'plugin1' }, { name: 'plugin2' }]}
          onSelect={onSelect}
          onCancel={onCancel}
          terminalWidth={terminalWidth}
        />,
      );

      expect(lastFrame()).toContain('❯');
    });
  });
});
