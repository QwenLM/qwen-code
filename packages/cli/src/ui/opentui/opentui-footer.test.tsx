/**
 * @license
 * Copyright 2026 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */
// @vitest-environment jsdom

/**
 * Tests for the restored OpenTUI footer + loading indicator: the approval-mode
 * label mapping, the status-line render, and the responding spinner that shows
 * only while a turn is in flight.
 */

import { beforeEach, describe, it, expect, vi } from 'vitest';
import { act, render } from '@testing-library/react';

// theme.ts builds a SyntaxStyle at module scope, which needs the OpenTUI
// native FFI — unavailable in the test runtime. Stub the graphics surface.
vi.mock('@opentui/core', () => ({
  SyntaxStyle: { fromStyles: () => ({}) },
  MouseButton: { LEFT: 0 },
}));

const mocks = vi.hoisted(() => {
  const state = {
    dimensions: { width: 110, height: 40 },
    gitBranch: 'main' as string | undefined,
    promptTokens: 0,
  };
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

vi.mock('../hooks/useGitBranchName.js', () => ({
  useGitBranchName: () => mocks.state.gitBranch,
}));

vi.mock('@qwen-code/qwen-code-core', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('@qwen-code/qwen-code-core')>();
  return {
    ...actual,
    uiTelemetryService: {
      getLastPromptTokenCount: () => mocks.state.promptTokens,
    },
  };
});

import type { Config } from '@qwen-code/qwen-code-core';
import {
  approvalModeLabel,
  OpenTuiFooter,
  OpenTuiLoadingIndicator,
} from './opentui-footer.js';

function fakeConfig(overrides: Partial<Config> = {}): Config {
  return {
    getTargetDir: () => '/home/user/projects/qwen-code',
    getModel: () => 'qwen3-coder-plus',
    getContentGeneratorConfig: () => ({ contextWindowSize: 1_000_000 }),
    ...overrides,
  } as unknown as Config;
}

describe('approvalModeLabel', () => {
  it.each([
    ['yolo', 'YOLO'],
    ['auto', 'Auto'],
    ['auto-edit', 'Auto-edit'],
    ['accepting-edits', 'Auto-edit'],
    ['plan', 'Plan'],
    ['', 'Default'],
    ['unknown-mode', 'Default'],
  ])('maps %s to %s', (input, expected) => {
    expect(approvalModeLabel(input)).toBe(expected);
  });
});

describe('OpenTuiLoadingIndicator', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  it('renders nothing when not streaming', () => {
    const { container } = render(<OpenTuiLoadingIndicator streaming={false} />);
    expect(container.textContent).toBe('');
  });

  it('shows the spinner row with an Esc-to-cancel hint while streaming', () => {
    const { container } = render(<OpenTuiLoadingIndicator streaming />);
    expect(container.textContent).toContain('Esc to cancel');
    expect(container.textContent).toContain('(0s');
  });

  it('ticks the elapsed counter once per second', () => {
    const { container } = render(<OpenTuiLoadingIndicator streaming />);
    act(() => {
      vi.advanceTimersByTime(3000);
    });
    expect(container.textContent).toContain('(3s');
  });
});

describe('OpenTuiFooter', () => {
  it('renders the project name, model and approval-mode row', () => {
    const { container } = render(
      <OpenTuiFooter config={fakeConfig()} streaming={false} />,
    );
    const text = container.textContent ?? '';
    expect(text).toContain('qwen-code');
    expect(text).toContain('qwen3-coder-plus');
    expect(text).toContain('git:(main)');
    expect(text).toContain('Default mode');
    expect(text).toContain('(shift + tab to cycle)');
  });

  it('shows the context indicator only after tokens are used', () => {
    mocks.state.promptTokens = 0;
    const { container, rerender } = render(
      <OpenTuiFooter config={fakeConfig()} streaming={false} />,
    );
    expect(container.textContent).not.toContain('Context');

    mocks.state.promptTokens = 50_000;
    rerender(<OpenTuiFooter config={fakeConfig()} streaming={false} />);
    expect(container.textContent).toContain('Context');
    expect(container.textContent).toContain('5% used');
  });

  it('adds the steer hint and the queue badge while streaming', () => {
    const { container } = render(
      <OpenTuiFooter
        config={fakeConfig()}
        streaming
        approvalMode={'yolo' as never}
        queueLength={2}
      />,
    );
    const text = container.textContent ?? '';
    expect(text).toContain('Enter to steer');
    expect(text).toContain('YOLO mode');
    expect(text).toContain('2 queued');
  });

  it('includes the session name when one is set', () => {
    const { container } = render(
      <OpenTuiFooter
        config={fakeConfig()}
        streaming={false}
        sessionName="my-session"
      />,
    );
    expect(container.textContent).toContain('my-session');
  });
});
