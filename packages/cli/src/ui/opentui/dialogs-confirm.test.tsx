/**
 * @license
 * Copyright 2026 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */
// @vitest-environment jsdom

/**
 * Tests for the tool-confirmation dialog: outcome-option construction and
 * the settle paths of {@link OpenTuiToolConfirmation} — Esc cancels, Enter
 * commits the highlighted outcome, ask_user_question answers flow through the
 * payload, a question with no options settles as cancel, and a settled call
 * can never settle twice.
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
    keyboardHandlers: [] as Array<(key: unknown) => void>,
    dimensions: { width: 110, height: 40 },
  };
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
  return { state, buildJsxRuntime };
});

vi.mock('@opentui/react', () => ({
  useKeyboard: (handler: (key: unknown) => void) => {
    mocks.state.keyboardHandlers.push(handler);
  },
  useTerminalDimensions: () => mocks.state.dimensions,
}));
vi.mock('@opentui/react/jsx-runtime', () => mocks.buildJsxRuntime());
vi.mock('@opentui/react/jsx-dev-runtime', () => mocks.buildJsxRuntime());

import {
  ToolConfirmationOutcome,
  type ToolCallConfirmationDetails,
  type ToolConfirmationPayload,
} from '@qwen-code/qwen-code-core';
import {
  buildOutcomeOptions,
  OpenTuiToolConfirmation,
} from './dialogs-confirm.js';

const onConfirmNoop = async () => {};

const execDetails = (
  hideAlwaysAllow?: boolean,
): ToolCallConfirmationDetails => ({
  type: 'exec',
  title: 'Run command',
  onConfirm: onConfirmNoop,
  hideAlwaysAllow,
  command: 'ls -la',
  rootCommand: 'ls',
});

const askDetails = (
  options?: Array<{ label: string; description: string }>,
  onConfirm: (
    outcome: ToolConfirmationOutcome,
    payload?: ToolConfirmationPayload,
  ) => Promise<void> = async () => {},
): ToolCallConfirmationDetails => ({
  type: 'ask_user_question',
  title: 'A question',
  questions: [
    {
      question: 'Pick one',
      header: 'Choice',
      options: options ?? [{ label: 'A', description: 'option a' }],
    },
  ],
  onConfirm,
});

describe('buildOutcomeOptions', () => {
  it('offers allow-once, both always-allow rows, and cancel by default', () => {
    const values = buildOutcomeOptions(execDetails()).map((o) => o.value);
    expect(values).toEqual([
      ToolConfirmationOutcome.ProceedOnce,
      ToolConfirmationOutcome.ProceedAlwaysProject,
      ToolConfirmationOutcome.ProceedAlwaysUser,
      ToolConfirmationOutcome.Cancel,
    ]);
  });

  it('drops the always-allow rows when hideAlwaysAllow is set', () => {
    const values = buildOutcomeOptions(execDetails(true)).map((o) => o.value);
    expect(values).toEqual([
      ToolConfirmationOutcome.ProceedOnce,
      ToolConfirmationOutcome.Cancel,
    ]);
  });

  it('handles details without the hideAlwaysAllow field at all', () => {
    // ask_user_question has no hideAlwaysAllow — reading it unguarded is a
    // type error and would misrender the dialog for every question card.
    const values = buildOutcomeOptions(askDetails()).map((o) => o.value);
    expect(values).toContain(ToolConfirmationOutcome.ProceedOnce);
    expect(values).toContain(ToolConfirmationOutcome.Cancel);
  });
});

describe('OpenTuiToolConfirmation', () => {
  function press(key: { name: string; sequence?: string; ctrl?: boolean }) {
    act(() => {
      for (const handler of mocks.state.keyboardHandlers) handler(key);
    });
  }

  beforeEach(() => {
    mocks.state.keyboardHandlers = [];
    mocks.state.dimensions = { width: 110, height: 40 };
  });

  it('settles Cancel on Esc exactly once, whatever arrives afterwards', () => {
    const onConfirm = vi.fn(async () => {});
    const onSettled = vi.fn();
    render(
      <OpenTuiToolConfirmation
        call={{
          callId: 'call-1',
          name: 'run_shell_command',
          confirmationDetails: { ...execDetails(), onConfirm },
        }}
        onSettled={onSettled}
      />,
    );
    press({ name: 'escape' });
    press({ name: 'return', sequence: '\r' });
    press({ name: 'escape' });
    expect(onConfirm).toHaveBeenCalledTimes(1);
    expect(onConfirm).toHaveBeenCalledWith(
      ToolConfirmationOutcome.Cancel,
      undefined,
    );
    expect(onSettled).toHaveBeenCalledTimes(1);
  });

  it('commits the highlighted outcome on Enter', () => {
    const onConfirm = vi.fn(async () => {});
    render(
      <OpenTuiToolConfirmation
        call={{
          callId: 'call-1',
          name: 'run_shell_command',
          confirmationDetails: { ...execDetails(), onConfirm },
        }}
        onSettled={() => {}}
      />,
    );
    press({ name: 'return', sequence: '\r' });
    expect(onConfirm).toHaveBeenCalledTimes(1);
    expect(onConfirm).toHaveBeenCalledWith(
      ToolConfirmationOutcome.ProceedOnce,
      undefined,
    );
  });

  it('answers an ask_user_question as ProceedOnce with the answers payload', () => {
    const onConfirm = vi.fn<
      (
        outcome: ToolConfirmationOutcome,
        payload?: ToolConfirmationPayload,
      ) => Promise<void>
    >(async () => {});
    render(
      <OpenTuiToolConfirmation
        call={{
          callId: 'call-1',
          name: 'ask_user_question',
          confirmationDetails: askDetails(undefined, onConfirm),
        }}
        onSettled={() => {}}
      />,
    );
    press({ name: 'return', sequence: '\r' });
    expect(onConfirm).toHaveBeenCalledTimes(1);
    const [outcome, payload] = onConfirm.mock.calls[0];
    expect(outcome).toBe(ToolConfirmationOutcome.ProceedOnce);
    expect(payload).toEqual({ answers: { '0': 'A' } });
  });

  it('settles Cancel when a question offers no options (nothing to answer)', () => {
    const onConfirm = vi.fn(async () => {});
    render(
      <OpenTuiToolConfirmation
        call={{
          callId: 'call-1',
          name: 'ask_user_question',
          confirmationDetails: askDetails([], onConfirm),
        }}
        onSettled={() => {}}
      />,
    );
    expect(onConfirm).toHaveBeenCalledTimes(1);
    expect(onConfirm).toHaveBeenCalledWith(
      ToolConfirmationOutcome.Cancel,
      undefined,
    );
  });

  it('renders the ink question line for MCP tool confirmations', () => {
    const { container } = render(
      <OpenTuiToolConfirmation
        call={{
          callId: 'call-1',
          name: 'mcp__external-context__context_remember',
          confirmationDetails: {
            type: 'mcp',
            title: 'Confirm MCP Tool Execution',
            serverName: 'external-context',
            toolName: 'context_remember',
            toolDisplayName: 'Context Remember',
            onConfirm: onConfirmNoop,
          },
        }}
        onSettled={() => {}}
      />,
    );
    // The question line carries the raw toolName; the accent line below it
    // carries the human display name — kept distinct so this test pins both.
    expect(container.textContent).toContain(
      'Allow execution of MCP tool "context_remember" from server "external-context"?',
    );
    expect(container.textContent).toContain('Context Remember');
  });

  it('keeps the head of a long info body and expands it on ctrl-s', () => {
    const lines = [
      'BODY_TOP',
      ...Array.from(
        { length: 24 },
        (_, index) => `body-line-${index.toString().padStart(2, '0')}`,
      ),
      'BODY_TAIL',
    ];
    const { container } = render(
      <OpenTuiToolConfirmation
        call={{
          callId: 'call-1',
          name: 'hook_gate',
          confirmationDetails: {
            type: 'info',
            title: 'Save this content?',
            prompt: lines.join('\n'),
            onConfirm: onConfirmNoop,
          },
        }}
        onSettled={() => {}}
      />,
    );
    const collapsed = container.textContent ?? '';
    expect(collapsed).toContain('BODY_TOP');
    expect(collapsed).toContain('... last 7 lines hidden ...');
    expect(collapsed).toContain('Press ctrl-s to show more lines');
    expect(collapsed).not.toContain('BODY_TAIL');

    press({ name: 's', ctrl: true });
    const expanded = container.textContent ?? '';
    expect(expanded).toContain('BODY_TAIL');
    // The expanded tail window (20 rows at height 40) still drops 6 of the
    // 26 rows, and the label is the only trace of them on the alt screen.
    // A tail window hides the HEAD rows, so the label says "first" (R5-1).
    expect(expanded).toContain('... first 6 lines hidden ...');
    expect(expanded).not.toContain('Press ctrl-s to show more lines');
  });

  it('ignores ctrl-s on a body that already fits', () => {
    // At height 24 the expanded tail window caps at 4 rows — smaller than
    // this fitting body — so ctrl-s must do nothing instead of dropping the
    // head rows.
    mocks.state.dimensions = { width: 110, height: 24 };
    const lines = Array.from(
      { length: 17 },
      (_, index) => `SHORT_BODY_${index.toString().padStart(2, '0')}`,
    );
    const { container } = render(
      <OpenTuiToolConfirmation
        call={{
          callId: 'call-1',
          name: 'hook_gate',
          confirmationDetails: {
            type: 'info',
            title: 'Approve this call?',
            prompt: lines.join('\n'),
            onConfirm: onConfirmNoop,
          },
        }}
        onSettled={() => {}}
      />,
    );
    expect(container.textContent).toContain('SHORT_BODY_00');

    press({ name: 's', ctrl: true });
    expect(container.textContent).toContain('SHORT_BODY_00');
    expect(container.textContent).toContain('SHORT_BODY_16');
  });

  it('caps a single-line JSON payload by its wrapped height', () => {
    const prompt =
      'Save this exact content to the bound Mem0 repository memory?\n' +
      JSON.stringify(`CONFIRM_TOP ${'x'.repeat(3000)} CONFIRM_TAIL`);
    const { container } = render(
      <OpenTuiToolConfirmation
        call={{
          callId: 'call-1',
          name: 'hook_gate',
          confirmationDetails: {
            type: 'info',
            title: 'Save this content?',
            prompt,
            renderPromptAsPlainText: true,
            onConfirm: onConfirmNoop,
          },
        }}
        onSettled={() => {}}
      />,
    );
    const collapsed = container.textContent ?? '';
    expect(collapsed).toContain('CONFIRM_TOP');
    expect(collapsed).toContain('lines hidden');
    expect(collapsed).toContain('Press ctrl-s to show more lines');
    expect(collapsed).not.toContain('CONFIRM_TAIL');

    press({ name: 's', ctrl: true });
    const expanded = container.textContent ?? '';
    // The expanded tail window surfaces the end of the payload (the alt-screen
    // viewport has no scrollback, so the tail must be on screen); the rows it
    // still drops are labeled, not silently discarded.
    expect(expanded).toContain('CONFIRM_TAIL');
    expect(expanded).toMatch(/first \d+ lines hidden/);
    expect(expanded).not.toContain('Press ctrl-s to show more lines');
  });

  it('keeps the collapsed view when expansion would show fewer rows', () => {
    // At height 24 the expanded tail window caps at 4 rows while the collapsed
    // head keeps 19 — expansion would strictly shrink the view, so ctrl-s
    // must not engage even though the body overflows.
    mocks.state.dimensions = { width: 110, height: 24 };
    const lines = Array.from(
      { length: 30 },
      (_, index) => `OVERFLOW_LINE_${index.toString().padStart(2, '0')}`,
    );
    const { container } = render(
      <OpenTuiToolConfirmation
        call={{
          callId: 'call-1',
          name: 'hook_gate',
          confirmationDetails: {
            type: 'info',
            title: 'Approve this call?',
            prompt: lines.join('\n'),
            onConfirm: onConfirmNoop,
          },
        }}
        onSettled={() => {}}
      />,
    );
    expect(container.textContent).toContain('OVERFLOW_LINE_00');
    // The handler refuses ctrl-s here, so the hint must not be offered —
    // a box may not advertise lines the key cannot reveal (R5-2).
    expect(container.textContent).not.toContain(
      'Press ctrl-s to show more lines',
    );

    press({ name: 's', ctrl: true });
    expect(container.textContent).toContain('OVERFLOW_LINE_00');
    expect(container.textContent).toContain('lines hidden');
  });
});
