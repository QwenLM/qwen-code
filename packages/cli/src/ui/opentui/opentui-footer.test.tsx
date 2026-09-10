/**
 * @license
 * Copyright 2026 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */
// @vitest-environment jsdom

/**
 * Tests for the restored OpenTUI footer + responding indicator: the status-line
 * render, the responding spinner that shows only while a turn is in flight, and
 * the loading phrases resolved through the shared locale-aware cycler.
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
    /** Stands in for a loaded locale's WITTY_LOADING_PHRASES array. */
    localePhrases: [] as string[],
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

// The phrases come from the active locale through the shared cycler; this lets
// a test load one without booting the whole i18n layer.
vi.mock('../../i18n/index.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../i18n/index.js')>();
  return {
    ...actual,
    ta: (key: string) =>
      key === 'WITTY_LOADING_PHRASES' && mocks.state.localePhrases.length > 0
        ? mocks.state.localePhrases
        : actual.ta(key),
  };
});

import { ApprovalMode } from '@qwen-code/qwen-code-core';
import type { Config } from '@qwen-code/qwen-code-core';
import { WITTY_LOADING_PHRASES } from '../hooks/usePhraseCycler.js';
import { OpenTuiFooter, OpenTuiLoadingIndicator } from './opentui-footer.js';

function fakeConfig(overrides: Partial<Config> = {}): Config {
  return {
    getTargetDir: () => '/home/user/projects/qwen-code',
    getModel: () => 'qwen3-coder-plus',
    getContentGeneratorConfig: () => ({ contextWindowSize: 1_000_000 }),
    ...overrides,
  } as unknown as Config;
}

describe('OpenTuiLoadingIndicator', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    mocks.state.localePhrases = [];
    mocks.state.dimensions = { width: 110, height: 40 };
  });

  it('renders nothing when not streaming', () => {
    const { container } = render(<OpenTuiLoadingIndicator streaming={false} />);
    expect(container.textContent).toBe('');
  });

  it('shows the spinner row with an esc-to-cancel hint while streaming', () => {
    const { container } = render(<OpenTuiLoadingIndicator streaming />);
    expect(container.textContent).toContain('esc to cancel');
    expect(container.textContent).toContain('(0s');
  });

  it('ticks the elapsed counter once per second', () => {
    const { container } = render(<OpenTuiLoadingIndicator streaming />);
    act(() => {
      vi.advanceTimersByTime(3000);
    });
    expect(container.textContent).toContain('(3s');
  });

  it('takes its phrase from the shared cycler fallback list', () => {
    const { container } = render(<OpenTuiLoadingIndicator streaming />);
    expect(container.textContent).toContain(WITTY_LOADING_PHRASES[0]);
  });

  it('takes its phrase from the active locale when one is loaded', () => {
    mocks.state.localePhrases = ['正在努力搬砖，请稍候...'];
    const { container } = render(<OpenTuiLoadingIndicator streaming />);
    expect(container.textContent).toContain('正在努力搬砖，请稍候...');
  });

  it('truncates a long phrase on a narrow terminal, keeping the cancel hint', () => {
    mocks.state.dimensions = { width: 40, height: 40 };
    mocks.state.localePhrases = ['正在努力搬砖，请稍候，马上就好，别催我'];
    const { container } = render(<OpenTuiLoadingIndicator streaming />);
    const text = container.textContent ?? '';
    expect(text).toContain('esc to cancel');
    expect(text).toContain('…');
    expect(text).not.toContain('别催我');
  });
});

describe('OpenTuiFooter', () => {
  beforeEach(() => {
    mocks.state.promptTokens = 0;
    mocks.state.gitBranch = 'main';
    mocks.state.dimensions = { width: 110, height: 40 };
  });

  it('truncates the status row to the terminal width instead of wrapping', () => {
    mocks.state.dimensions = { width: 40, height: 40 };
    mocks.state.gitBranch = 'a-very-long-branch-name-that-cannot-fit';
    const { container } = render(
      <OpenTuiFooter config={fakeConfig()} streaming={false} />,
    );
    const line = (container.textContent ?? '').trim();
    expect(line.length).toBeLessThanOrEqual(40);
    expect(line.endsWith('…')).toBe(true);
    expect(line).not.toContain('qwen3-coder-plus');
  });

  it('renders the project name, git branch and model', () => {
    const { container } = render(
      <OpenTuiFooter config={fakeConfig()} streaming={false} />,
    );
    const text = container.textContent ?? '';
    expect(text).toContain('qwen-code');
    expect(text).toContain('qwen3-coder-plus');
    expect(text).toContain('git:(main)');
  });

  it('omits the git segment outside a repository', () => {
    mocks.state.gitBranch = undefined;
    const { container } = render(
      <OpenTuiFooter config={fakeConfig()} streaming={false} />,
    );
    expect(container.textContent).not.toContain('git:(');
  });

  it('leaves out the hint row when nothing is live to report', () => {
    const { container } = render(
      <OpenTuiFooter config={fakeConfig()} streaming={false} />,
    );
    expect(container.textContent).not.toContain('Enter to steer');
    expect(container.textContent).not.toContain('queued');
  });

  it('labels the mode from the shared mapping, not a local table', () => {
    const { container, rerender } = render(
      <OpenTuiFooter
        config={fakeConfig()}
        streaming
        approvalMode={ApprovalMode.AUTO_EDIT}
      />,
    );
    const text = container.textContent ?? '';
    expect(text).toContain('auto-accept edits');
    expect(text).not.toContain('Auto-edit mode');
    // shift+tab is not bound to cycle modes in this renderer, so ink's
    // `(shift + tab to cycle)` suffix would be a dead affordance here.
    expect(text).not.toContain('shift + tab');

    rerender(
      <OpenTuiFooter
        config={fakeConfig()}
        streaming
        approvalMode={ApprovalMode.YOLO}
      />,
    );
    expect(container.textContent).toContain('YOLO mode');
  });

  it('orders the hint row as steer, mode, queue', () => {
    const { container } = render(
      <OpenTuiFooter
        config={fakeConfig()}
        streaming
        queueLength={2}
        approvalMode={ApprovalMode.AUTO}
      />,
    );
    expect(container.textContent).toContain(
      'Enter to steer · Ctrl+Q to queue · Auto mode · ⏳ 2 queued',
    );
  });

  it('shows the context indicator only after tokens are used', () => {
    const { container, rerender } = render(
      <OpenTuiFooter config={fakeConfig()} streaming={false} />,
    );
    expect(container.textContent).not.toContain('% context used');

    mocks.state.promptTokens = 50_000;
    rerender(<OpenTuiFooter config={fakeConfig()} streaming={false} />);
    expect(container.textContent).toContain('5.0% context used');
  });

  it('reports over-limit usage as >100 like the ink indicator', () => {
    mocks.state.promptTokens = 1_500_000;
    const { container } = render(
      <OpenTuiFooter config={fakeConfig()} streaming={false} />,
    );
    expect(container.textContent).toContain('>100% context used');
  });

  it('shortens the usage label below 100 columns', () => {
    mocks.state.dimensions = { width: 90, height: 40 };
    mocks.state.promptTokens = 50_000;
    const { container } = render(
      <OpenTuiFooter config={fakeConfig()} streaming={false} />,
    );
    expect(container.textContent).toContain('5.0% used');
    expect(container.textContent).not.toContain('% context used');
  });

  it('adds the steer hint and the queue badge while streaming', () => {
    const { container } = render(
      <OpenTuiFooter config={fakeConfig()} streaming queueLength={2} />,
    );
    const text = container.textContent ?? '';
    expect(text).toContain('Enter to steer');
    expect(text).toContain('2 queued');
  });

  it('shows the queue badge on its own when queued but idle', () => {
    const { container } = render(
      <OpenTuiFooter config={fakeConfig()} streaming={false} queueLength={1} />,
    );
    const text = container.textContent ?? '';
    expect(text).toContain('1 queued');
    expect(text).not.toContain('Enter to steer');
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
