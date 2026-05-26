/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { render } from 'ink-testing-library';
import { HooksConfigSource, HookType } from '@qwen-code/qwen-code-core';
import { HandlerListBody } from './HandlerListBody.js';
import type { HookConfigDisplayInfo } from './types.js';

vi.mock('../../../i18n/index.js', () => ({
  t: vi.fn((key: string) => key),
}));

vi.mock('../../hooks/useTerminalSize.js', () => ({
  useTerminalSize: vi.fn(() => ({ columns: 120, rows: 24 })),
}));

vi.mock('../../semantic-colors.js', () => ({
  theme: {
    text: { primary: 'white', secondary: 'gray', accent: 'cyan' },
  },
}));

function commandConfig(
  command = '/cmd.sh',
  async = false,
): HookConfigDisplayInfo {
  return {
    config: { type: HookType.Command, command, async },
    source: HooksConfigSource.User,
    sourceDisplay: 'User Settings',
    enabled: true,
  };
}

function httpConfig(
  overrides: Partial<{ name: string; url: string }> = {},
): HookConfigDisplayInfo {
  return {
    config: {
      type: HookType.Http,
      url: overrides.url ?? 'https://example.test/hook',
      ...(overrides.name ? { name: overrides.name } : {}),
    } as HookConfigDisplayInfo['config'],
    source: HooksConfigSource.User,
    sourceDisplay: 'User Settings',
    enabled: true,
  };
}

function functionConfig(
  overrides: Partial<{ name: string; id: string }> = {},
): HookConfigDisplayInfo {
  return {
    config: {
      type: HookType.Function,
      callback: async () => undefined,
      errorMessage: 'fn failed',
      id: overrides.id ?? 'fn-id',
      ...(overrides.name ? { name: overrides.name } : {}),
    } as HookConfigDisplayInfo['config'],
    source: HooksConfigSource.User,
    sourceDisplay: 'User Settings',
    enabled: true,
  };
}

function promptConfig(
  overrides: Partial<{ name: string; prompt: string }> = {},
): HookConfigDisplayInfo {
  return {
    config: {
      type: HookType.Prompt,
      prompt: overrides.prompt ?? 'short prompt',
      ...(overrides.name ? { name: overrides.name } : {}),
    } as HookConfigDisplayInfo['config'],
    source: HooksConfigSource.User,
    sourceDisplay: 'User Settings',
    enabled: true,
  };
}

describe('HandlerListBody', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('describeHook (rendered as the row label)', () => {
    it('renders the command path for command hooks', () => {
      const { lastFrame } = render(
        <HandlerListBody
          configs={[commandConfig('/check.sh')]}
          selectedIndex={0}
        />,
      );
      const out = lastFrame() ?? '';
      expect(out).toContain('[command]');
      expect(out).toContain('/check.sh');
    });

    it('marks async command hooks with " async" in the type column', () => {
      const { lastFrame } = render(
        <HandlerListBody
          configs={[commandConfig('/bg.sh', true)]}
          selectedIndex={0}
        />,
      );
      expect(lastFrame() ?? '').toContain('[command async]');
    });

    it('prefers the http hook name over the URL', () => {
      const { lastFrame } = render(
        <HandlerListBody
          configs={[httpConfig({ name: 'webhook-A', url: 'https://x' })]}
          selectedIndex={0}
        />,
      );
      const out = lastFrame() ?? '';
      expect(out).toContain('[http]');
      expect(out).toContain('webhook-A');
      expect(out).not.toContain('https://x');
    });

    it('falls back to the http URL when name is missing', () => {
      const { lastFrame } = render(
        <HandlerListBody
          configs={[httpConfig({ url: 'https://example.test/hook' })]}
          selectedIndex={0}
        />,
      );
      expect(lastFrame() ?? '').toContain('https://example.test/hook');
    });

    it('prefers the function hook name over the id', () => {
      const { lastFrame } = render(
        <HandlerListBody
          configs={[functionConfig({ name: 'fn-name', id: 'fn-id' })]}
          selectedIndex={0}
        />,
      );
      const out = lastFrame() ?? '';
      expect(out).toContain('[function]');
      expect(out).toContain('fn-name');
      expect(out).not.toContain('fn-id');
    });

    it('falls back to function id, then to "function-hook" placeholder', () => {
      const withId = render(
        <HandlerListBody
          configs={[functionConfig({ id: 'only-id' })]}
          selectedIndex={0}
        />,
      );
      expect(withId.lastFrame() ?? '').toContain('only-id');

      const noNameNoId = render(
        <HandlerListBody
          configs={[
            {
              config: {
                type: HookType.Function,
                callback: async () => undefined,
                errorMessage: 'fn failed',
              } as HookConfigDisplayInfo['config'],
              source: HooksConfigSource.User,
              sourceDisplay: 'User Settings',
              enabled: true,
            },
          ]}
          selectedIndex={0}
        />,
      );
      expect(noNameNoId.lastFrame() ?? '').toContain('function-hook');
    });

    it('truncates long prompt text with "..." and keeps short prompts intact', () => {
      const long = 'a'.repeat(80);
      const { lastFrame: longFrame } = render(
        <HandlerListBody
          configs={[promptConfig({ prompt: long })]}
          selectedIndex={0}
        />,
      );
      const longOut = longFrame() ?? '';
      expect(longOut).toContain('a'.repeat(50) + '...');
      expect(longOut).not.toContain('a'.repeat(51));

      const { lastFrame: shortFrame } = render(
        <HandlerListBody
          configs={[promptConfig({ prompt: 'fits' })]}
          selectedIndex={0}
        />,
      );
      const shortOut = shortFrame() ?? '';
      expect(shortOut).toContain('fits');
      expect(shortOut).not.toContain('...');
    });

    it('prefers the prompt name over the prompt text', () => {
      const { lastFrame } = render(
        <HandlerListBody
          configs={[
            promptConfig({ name: 'classifier', prompt: 'should not appear' }),
          ]}
          selectedIndex={0}
        />,
      );
      const out = lastFrame() ?? '';
      expect(out).toContain('classifier');
      expect(out).not.toContain('should not appear');
    });
  });

  describe('source column', () => {
    it('appends the extension name for Extensions-source configs', () => {
      const config: HookConfigDisplayInfo = {
        config: { type: HookType.Command, command: '/ext.sh' },
        source: HooksConfigSource.Extensions,
        sourceDisplay: 'my-extension',
        enabled: true,
      };

      const { lastFrame } = render(
        <HandlerListBody configs={[config]} selectedIndex={0} />,
      );

      const out = lastFrame() ?? '';
      expect(out).toContain('Extensions');
      expect(out).toContain('my-extension');
    });

    it('uses the long "Session (temporary)" label for session-source configs', () => {
      const config: HookConfigDisplayInfo = {
        config: { type: HookType.Command, command: '/sess.sh' },
        source: HooksConfigSource.Session,
        sourceDisplay: 'Session (temporary)',
        enabled: true,
      };

      const { lastFrame } = render(
        <HandlerListBody configs={[config]} selectedIndex={0} />,
      );

      expect(lastFrame() ?? '').toContain('Session (temporary)');
    });
  });

  it('renders numbered rows and footer hint, places arrow on selected', () => {
    const configs = [commandConfig('/first.sh'), commandConfig('/second.sh')];
    const { lastFrame } = render(
      <HandlerListBody configs={configs} selectedIndex={1} />,
    );
    const out = lastFrame() ?? '';

    expect(out).toContain('1.');
    expect(out).toContain('2.');
    expect(out).toContain('Configured hooks:');
    expect(out).toContain('Enter to select · Esc to go back');

    const arrowLine = out.split('\n').find((line) => line.includes('❯'));
    expect(arrowLine).toBeDefined();
    expect(arrowLine).toContain('/second.sh');
  });
});
