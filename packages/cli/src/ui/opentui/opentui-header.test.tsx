/**
 * @license
 * Copyright 2026 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */
// @vitest-environment jsdom

/**
 * Tests for the restored OpenTUI header banner: it renders the title, model and
 * directory, and suppresses itself in screen-reader mode or when `ui.hideBanner`
 * is set — the same conditions the ink AppHeader honours.
 */

import { describe, it, expect, vi } from 'vitest';
import { render } from '@testing-library/react';

// theme.ts builds a SyntaxStyle at module scope, which needs the OpenTUI
// native FFI — unavailable in the test runtime. Stub the graphics surface.
vi.mock('@opentui/core', () => ({
  SyntaxStyle: { fromStyles: () => ({}) },
  MouseButton: { LEFT: 0 },
}));

const mocks = vi.hoisted(() => {
  const state = { dimensions: { width: 110, height: 40 } };
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
  return { state, buildJsxRuntime };
});

vi.mock('@opentui/react', () => ({
  useTerminalDimensions: () => mocks.state.dimensions,
}));
vi.mock('@opentui/react/jsx-runtime', () => mocks.buildJsxRuntime());
vi.mock('@opentui/react/jsx-dev-runtime', () => mocks.buildJsxRuntime());

import type { Config } from '@qwen-code/qwen-code-core';
import type { LoadedSettings } from '../../config/settings.js';
import { OpenTuiBanner } from './opentui-header.js';

function fakeConfig(overrides: Partial<Config> = {}): Config {
  return {
    getScreenReader: () => false,
    getCliVersion: () => '9.9.9-test',
    getContentGeneratorConfig: () => ({ contextWindowSize: 1_000_000 }),
    getModelDisplayName: () => 'qwen3-coder-plus',
    getTargetDir: () => '/home/user/projects/qwen-code',
    ...overrides,
  } as unknown as Config;
}

function fakeSettings(ui: Record<string, unknown> = {}): LoadedSettings {
  return {
    merged: { ui },
    isTrusted: true,
    system: { settings: {} },
    workspace: { settings: {} },
    user: { settings: {} },
    systemDefaults: { settings: {} },
  } as unknown as LoadedSettings;
}

describe('OpenTuiBanner', () => {
  it('renders the title, model and project directory', () => {
    const { container } = render(
      <OpenTuiBanner config={fakeConfig()} settings={fakeSettings()} />,
    );
    const text = container.textContent ?? '';
    expect(text).toContain('>_ Qwen Code');
    expect(text).toContain('qwen3-coder-plus');
    expect(text).toContain('qwen-code');
  });

  it('renders the version reported by the config with a v prefix', () => {
    const { container } = render(
      <OpenTuiBanner config={fakeConfig()} settings={fakeSettings()} />,
    );
    expect(container.textContent).toContain('(v9.9.9-test)');
  });

  it('shows a non-semver version as-is instead of prefixing it', () => {
    const { container } = render(
      <OpenTuiBanner
        config={fakeConfig({
          getCliVersion: () => 'nightly',
        } as Partial<Config>)}
        settings={fakeSettings()}
      />,
    );
    expect(container.textContent).toContain('(nightly)');
  });

  it('falls back to unknown rather than an empty label', () => {
    const { container } = render(
      <OpenTuiBanner
        config={fakeConfig({
          getCliVersion: () => undefined,
        } as Partial<Config>)}
        settings={fakeSettings()}
      />,
    );
    const text = container.textContent ?? '';
    expect(text).toContain('(unknown)');
    expect(text).not.toContain('()');
  });

  it('suppresses the banner when ui.hideBanner is set', () => {
    const { container } = render(
      <OpenTuiBanner
        config={fakeConfig()}
        settings={fakeSettings({ hideBanner: true })}
      />,
    );
    expect(container.textContent).toBe('');
  });

  it('suppresses the banner in screen-reader mode', () => {
    const { container } = render(
      <OpenTuiBanner
        config={fakeConfig({ getScreenReader: () => true } as Partial<Config>)}
        settings={fakeSettings()}
      />,
    );
    expect(container.textContent).toBe('');
  });
});
