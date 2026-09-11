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
  type Config,
  type ToolCallConfirmationDetails,
  type ToolConfirmationPayload,
  type ToolExecuteConfirmationDetails,
  type ToolPlanConfirmationDetails,
} from '@qwen-code/qwen-code-core';
import {
  buildConfirmationPrompt,
  OpenTuiToolConfirmation,
} from './dialogs-confirm.js';
import {
  DIALOG_EXPANDED_RESERVE_ROWS,
  PENDING_CARD_VIEWPORT_RESERVE_ROWS,
} from './messages.js';

const onConfirmNoop = async () => {};

/** The dialog only ever asks the config whether the folder is trusted. */
const fakeConfig = (isTrustedFolder: boolean): Config =>
  ({ isTrustedFolder: () => isTrustedFolder }) as unknown as Config;

const trustedConfig = fakeConfig(true);

const execDetails = (
  hideAlwaysAllow?: boolean,
): ToolExecuteConfirmationDetails => ({
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

const planDetails = (prePlanMode?: string): ToolPlanConfirmationDetails => ({
  type: 'plan',
  title: 'Approve this plan?',
  plan: 'step one',
  prePlanMode,
  onConfirm: onConfirmNoop,
});

describe('buildConfirmationPrompt', () => {
  it('names the granted scope in the exec always-allow rows', () => {
    const prompt = buildConfirmationPrompt(
      { ...execDetails(), permissionRules: ['Bash(touch *)'] },
      true,
    );
    expect(prompt.question).toBe("Allow execution of: 'ls'?");
    expect(prompt.options.map((o) => o.label)).toEqual([
      'Yes, allow once',
      "Always allow run 'touch *' commands in this project",
      "Always allow run 'touch *' commands for this user",
      'No, suggest changes (esc)',
    ]);
    expect(prompt.options.map((o) => o.value)).toEqual([
      ToolConfirmationOutcome.ProceedOnce,
      ToolConfirmationOutcome.ProceedAlwaysProject,
      ToolConfirmationOutcome.ProceedAlwaysUser,
      ToolConfirmationOutcome.Cancel,
    ]);
  });

  it('falls back to the unscoped labels when no rules are supplied', () => {
    const labels = buildConfirmationPrompt(execDetails(), true).options.map(
      (o) => o.label,
    );
    expect(labels).toContain('Always allow in this project');
    expect(labels).toContain('Always allow for this user');
  });

  it('drops the always-allow rows in an untrusted folder', () => {
    // Granting a durable rule for a workspace the user has not trusted is not
    // a decision the dialog may offer — ink gates these the same way.
    const values = buildConfirmationPrompt(
      { ...execDetails(), permissionRules: ['Bash(touch *)'] },
      false,
    ).options.map((o) => o.value);
    expect(values).toEqual([
      ToolConfirmationOutcome.ProceedOnce,
      ToolConfirmationOutcome.Cancel,
    ]);
  });

  it('drops the always-allow rows when hideAlwaysAllow is set', () => {
    const values = buildConfirmationPrompt(execDetails(true), true).options.map(
      (o) => o.value,
    );
    expect(values).toEqual([
      ToolConfirmationOutcome.ProceedOnce,
      ToolConfirmationOutcome.Cancel,
    ]);
  });

  it('offers edit a session-wide allow-always, not a persisted rule', () => {
    const prompt = buildConfirmationPrompt(
      {
        type: 'edit',
        title: 'Confirm Edit',
        fileName: 'a.txt',
        filePath: '/w/a.txt',
        fileDiff: '',
        originalContent: null,
        newContent: 'x',
        onConfirm: onConfirmNoop,
      },
      true,
    );
    expect(prompt.question).toBe('Apply this change?');
    expect(prompt.options.map((o) => o.value)).toEqual([
      ToolConfirmationOutcome.ProceedOnce,
      ToolConfirmationOutcome.ProceedAlways,
      ToolConfirmationOutcome.Cancel,
    ]);
  });

  it('offers the plan outcomes, including restoring the previous mode', () => {
    const prompt = buildConfirmationPrompt(planDetails('auto_edit'), true);
    expect(prompt.question).toBe('Approve this plan?');
    expect(prompt.options.map((o) => o.value)).toEqual([
      ToolConfirmationOutcome.RestorePrevious,
      ToolConfirmationOutcome.ProceedAlways,
      ToolConfirmationOutcome.ProceedOnce,
      ToolConfirmationOutcome.Cancel,
    ]);
    expect(prompt.options[0].label).toBe(
      'Yes, restore previous mode (auto_edit)',
    );
    expect(prompt.options[3].label).toBe('No, keep planning (esc)');
  });

  it('defaults the plan restore label when no previous mode is recorded', () => {
    expect(buildConfirmationPrompt(planDetails(), true).options[0].label).toBe(
      'Yes, restore previous mode (default)',
    );
  });

  it('suppresses only on an explicit hideAlwaysAllow true', () => {
    const values = buildConfirmationPrompt(
      { ...execDetails(), hideAlwaysAllow: false },
      true,
    ).options.map((o) => o.value);
    expect(values).toContain(ToolConfirmationOutcome.ProceedAlwaysProject);
  });

  it('offers to leave AUTO mode when the classifier was unavailable', () => {
    const values = buildConfirmationPrompt(
      {
        ...execDetails(),
        autoModeFallback: {
          reason: 'classifier_unavailable',
          message: 'classifier down',
        },
      },
      false,
    ).options.map((o) => o.value);
    expect(values).toEqual([
      ToolConfirmationOutcome.ProceedOnce,
      ToolConfirmationOutcome.ProceedOnceAndSwitchToDefault,
      ToolConfirmationOutcome.Cancel,
    ]);
  });

  it('does not offer the AUTO-mode switch for an unrelated fallback reason', () => {
    const values = buildConfirmationPrompt(
      {
        ...execDetails(),
        autoModeFallback: { reason: 'total_denial', message: 'too many' },
      },
      false,
    ).options.map((o) => o.value);
    expect(values).not.toContain(
      ToolConfirmationOutcome.ProceedOnceAndSwitchToDefault,
    );
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
        config={trustedConfig}
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
        config={trustedConfig}
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
        config={trustedConfig}
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
        config={trustedConfig}
        onSettled={() => {}}
      />,
    );
    expect(onConfirm).toHaveBeenCalledTimes(1);
    expect(onConfirm).toHaveBeenCalledWith(
      ToolConfirmationOutcome.Cancel,
      undefined,
    );
  });

  it('renders the ink question line and labeled body for MCP confirmations', () => {
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
        config={trustedConfig}
        onSettled={() => {}}
      />,
    );
    const text = container.textContent ?? '';
    expect(text).toContain(
      'Allow execution of MCP tool "context_remember" from server "external-context"?',
    );
    expect(text).toContain('MCP Server: external-context');
    expect(text).toContain('Tool: context_remember');
  });

  it('renders the exec question line and numbered, scoped options', () => {
    const { container } = render(
      <OpenTuiToolConfirmation
        call={{
          callId: 'call-1',
          name: 'run_shell_command',
          confirmationDetails: {
            ...execDetails(),
            rootCommand: 'touch',
            command: 'touch marker',
            permissionRules: ['Bash(touch *)'],
          },
        }}
        config={trustedConfig}
        onSettled={() => {}}
      />,
    );
    const text = container.textContent ?? '';
    expect(text).toContain("Allow execution of: 'touch'?");
    // Numbered rows, and the scope the user is actually granting.
    expect(text).toContain('1.');
    expect(text).toContain('4.');
    expect(text).toContain(
      "Always allow run 'touch *' commands in this project",
    );
    expect(text).toContain('No, suggest changes (esc)');
  });

  it('never renders the always-allow rows in an untrusted folder', () => {
    const { container } = render(
      <OpenTuiToolConfirmation
        call={{
          callId: 'call-1',
          name: 'run_shell_command',
          confirmationDetails: {
            ...execDetails(),
            permissionRules: ['Bash(touch *)'],
          },
        }}
        config={fakeConfig(false)}
        onSettled={() => {}}
      />,
    );
    const text = container.textContent ?? '';
    expect(text).toContain('Yes, allow once');
    expect(text).not.toContain('Always allow');
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
        config={trustedConfig}
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
        config={trustedConfig}
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
        config={trustedConfig}
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
        config={trustedConfig}
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

  it('windows a long edit diff to the collapsed body cap (R1-8)', () => {
    // DiffBody reads the same CONFIRMATION_BODY_MAX_ROWS as TextBody, but no
    // render in this tree carried a non-empty fileDiff — a cap mutation at
    // the DiffBody site survived the whole suite. Thirty context lines under
    // the mandatory @@ hunk header render 30 logical lines, so the window
    // hides 11 and keeps the tail.
    const fileDiff = [
      '--- a/a.txt',
      '+++ b/a.txt',
      '@@ -1,30 +1,30 @@',
      ...Array.from(
        { length: 30 },
        (_, i) => ` line-${String(i).padStart(2, '0')}`,
      ),
    ].join('\n');
    const { container } = render(
      <OpenTuiToolConfirmation
        call={{
          callId: 'call-1',
          name: 'edit',
          confirmationDetails: {
            type: 'edit',
            title: 'Confirm Edit',
            fileName: 'a.txt',
            filePath: '/w/a.txt',
            fileDiff,
            originalContent: null,
            newContent: 'x',
            onConfirm: onConfirmNoop,
          },
        }}
        config={trustedConfig}
        onSettled={() => {}}
      />,
    );
    const text = container.textContent ?? '';
    expect(text).toContain('... 11 earlier lines hidden ...');
    expect(text).toContain('line-29');
    expect(text).not.toContain('line-00');
  });

  it('keeps the dialog reserves ahead of the rows a real render produces (R1-9)', () => {
    // The reserves are hand-accounted sums; the only honest pin is a render.
    // The jsdom harness drops layout props, so count the structural rows
    // (one per span, with each DialogSelect row's three spans counting once)
    // and add the chrome the harness cannot show: the frame's border and
    // padding (4), the body box's margins (2), and the footer's margin (1).
    // The above-card share of DIALOG_EXPANDED_RESERVE_ROWS (banner, notices,
    // prompt echo ≈ 12) is not reachable from a single-component render —
    // only the dialog's own chrome is pinned here.
    const INVISIBLE_CHROME_ROWS = 7;
    const countRows = (container: HTMLElement): number => {
      const spans = [...container.querySelectorAll('span')];
      const optionNumbers = spans.filter((span) =>
        /^\d+\.$/.test(span.textContent ?? ''),
      ).length;
      return spans.length - 2 * optionNumbers;
    };
    const renderInfoDialog = (prompt: string): number => {
      const { container, unmount } = render(
        <OpenTuiToolConfirmation
          call={{
            callId: 'call-1',
            name: 'hook_gate',
            confirmationDetails: {
              type: 'info',
              title: 'Save this content?',
              prompt,
              onConfirm: onConfirmNoop,
            },
          }}
          config={trustedConfig}
          onSettled={() => {}}
        />,
      );
      const rows = countRows(container);
      unmount();
      return rows;
    };

    // Worst-case collapsed body: past the cap, so the hidden-tail label and
    // the ctrl-s hint rows render too (19 + 2 = 21 body rows).
    const collapsedRows =
      renderInfoDialog(
        Array.from({ length: 26 }, (_, i) => `line-${i}`).join('\n'),
      ) + INVISIBLE_CHROME_ROWS;
    expect(collapsedRows).toBeLessThanOrEqual(
      PENDING_CARD_VIEWPORT_RESERVE_ROWS,
    );

    // The chrome is the whole dialog minus its one-row body.
    const chromeRows = renderInfoDialog('fits') - 1 + INVISIBLE_CHROME_ROWS;
    expect(chromeRows).toBeLessThanOrEqual(DIALOG_EXPANDED_RESERVE_ROWS);
  });
});
