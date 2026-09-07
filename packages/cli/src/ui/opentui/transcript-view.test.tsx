/**
 * @license
 * Copyright 2026 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */
// @vitest-environment jsdom

/**
 * Mount coverage for the transcript view's review-round behaviors: an
 * awaiting-approval card keeps its (capped) description — the confirmation
 * dialog does not carry the payload for every type, so an MCP call stays
 * approvable with its arguments on screen — and the `!` shell row carries
 * ink's `$ ` prefix.
 */

import { describe, it, expect, vi } from 'vitest';
import { render } from '@testing-library/react';
import { AgentStatus } from '@qwen-code/qwen-code-core';

// theme.ts builds a SyntaxStyle at module scope, which needs the OpenTUI
// native FFI — unavailable in the test runtime. Stub the graphics surface.
vi.mock('@opentui/core', () => ({
  SyntaxStyle: { fromStyles: () => ({}) },
  MouseButton: { LEFT: 0 },
}));

const mocks = vi.hoisted(() => {
  // The components carry the @opentui/react JSX import source; map its
  // primitive elements to DOM nodes so @testing-library/react can mount them.
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

import { OpenTuiTranscriptView } from './transcript-view.js';
import type { LiveToolItem } from './live-session-model.js';

const toolItem = (overrides: Partial<LiveToolItem> = {}): LiveToolItem => ({
  kind: 'tool',
  id: 't1',
  tool: 'run_shell_command',
  title: 'run_shell_command',
  output: '',
  done: false,
  ...overrides,
});

describe('OpenTuiTranscriptView', () => {
  it('keeps a pending MCP-shaped card description visible (R1-10)', () => {
    // An MCP confirmation dialog shows only the server and tool names — no
    // args — so the card is the only surface that carries the arguments.
    const { container } = render(
      <OpenTuiTranscriptView
        items={[
          toolItem({
            tool: 'mcp__fs__write_file',
            description: '{"path":"/x","content":"SECRET_PAYLOAD"}',
            confirm: 'pending',
          }),
        ]}
      />,
    );
    expect(container.textContent).toContain('SECRET_PAYLOAD');
    expect(container.textContent).toContain('awaiting approval');
  });

  it('keeps a long pending payload approvable and caps it once settled (R5-9)', () => {
    // The settled 5-row cap would hide exactly the tail of the payload the
    // user is being asked to approve, so a pending card budgets its own
    // (bounded) rows; the cap applies again once the call settles. Two
    // separate renders: siblings in one render would share the container and
    // defeat the absent assertion.
    const description =
      '{"path":"/x","content":"' + 'x'.repeat(600) + 'TAIL_MARKER"}';
    const pending = render(
      <OpenTuiTranscriptView
        items={[
          toolItem({
            tool: 'mcp__fs__write_file',
            description,
            confirm: 'pending',
          }),
        ]}
      />,
    );
    expect(pending.container.textContent).toContain('TAIL_MARKER');
    expect(pending.container.textContent).toContain('awaiting approval');
    pending.unmount();

    const settled = render(
      <OpenTuiTranscriptView
        items={[
          toolItem({
            tool: 'mcp__fs__write_file',
            description,
            confirm: 'approved',
          }),
        ]}
      />,
    );
    expect(settled.container.textContent).not.toContain('TAIL_MARKER');
    expect(settled.container.textContent).toContain('... last');
  });

  it('shows the description once approval resolves or the call is done', () => {
    const { container } = render(
      <OpenTuiTranscriptView
        items={[
          toolItem({ description: 'echo visible now', confirm: 'approved' }),
          toolItem({
            description: 'done shows too',
            confirm: 'pending',
            done: true,
          }),
        ]}
      />,
    );
    expect(container.textContent).toContain('echo visible now');
    expect(container.textContent).toContain('done shows too');
  });

  it('renders the ! shell row with the ink $ prefix', () => {
    const { container } = render(
      <OpenTuiTranscriptView
        items={[{ kind: 'user-shell', id: 's1', text: 'git status' }]}
      />,
    );
    expect(container.textContent).toContain('$ git status');
  });

  it('strips bidi overrides from arena file lists and group labels (R1-26)', () => {
    const { container } = render(
      <OpenTuiTranscriptView
        items={[
          {
            kind: 'arena-session',
            id: 'a1',
            sessionStatus: 'completed',
            task: 'do it',
            totalDurationMs: 2000,
            agents: [
              {
                label: 'a\u202eX',
                status: AgentStatus.COMPLETED,
                durationMs: 1200,
                totalTokens: 10,
                inputTokens: 4,
                outputTokens: 6,
                toolCalls: 2,
                successfulToolCalls: 2,
                failedToolCalls: 0,
                rounds: 1,
                modifiedFiles: ['a\u202eb.ts'],
              },
            ],
          },
        ]}
      />,
    );
    const text = container.textContent ?? '';
    expect(text).not.toContain('\u202e');
    expect(text).toContain('b.ts');
  });
});
