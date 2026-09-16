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

import { afterEach, beforeEach, describe, it, expect, vi } from 'vitest';
import { act, render } from '@testing-library/react';

// theme.ts builds a SyntaxStyle at module scope, which needs the OpenTUI
// native FFI — unavailable in the test runtime. Stub the graphics surface.
vi.mock('@opentui/core', () => ({
  SyntaxStyle: { fromStyles: () => ({}) },
  MouseButton: { LEFT: 0 },
  decodePasteBytes: (bytes: Uint8Array) => Buffer.from(bytes).toString('utf8'),
}));

const mocks = vi.hoisted(() => {
  const state = {
    keyboardHandlers: [] as Array<(key: unknown) => void>,
    pasteHandlers: [] as Array<(event: unknown) => void>,
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
        // `bg` is the one style prop carried through: the dialog gives a
        // background colour to exactly one cell, the software cursor.
        const bg = (config as { bg?: string }).bg;
        return React.createElement(
          type === 'box' ? 'div' : 'span',
          {
            ...(key === undefined ? null : { key }),
            ...(bg === undefined ? null : { 'data-bg': bg }),
          },
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

vi.mock('@opentui/react', async () => {
  const React = await import('react');
  // Mount-stable registration: the wrapper is registered once per consumer and
  // always invokes the latest handler closure — the real renderer's semantics —
  // so a re-render cannot multiply the deliveries of a single key event.
  const useStableHandler = (
    handlers: Array<(event: unknown) => void>,
    handler: (event: unknown) => void,
  ) => {
    const ref = React.useRef(handler);
    ref.current = handler;
    React.useEffect(() => {
      const fn = (event: unknown) => ref.current(event);
      handlers.push(fn);
      return () => {
        const index = handlers.indexOf(fn);
        if (index >= 0) handlers.splice(index, 1);
      };
    }, [handlers]);
  };
  return {
    useKeyboard: (handler: (key: unknown) => void) =>
      useStableHandler(mocks.state.keyboardHandlers, handler),
    usePaste: (handler: (event: unknown) => void) =>
      useStableHandler(mocks.state.pasteHandlers, handler),
    useTerminalDimensions: () => mocks.state.dimensions,
  };
});
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
  multiSelect?: boolean,
): ToolCallConfirmationDetails => ({
  type: 'ask_user_question',
  title: 'A question',
  questions: [
    {
      question: 'Pick one',
      header: 'Choice',
      multiSelect,
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
    mocks.state.pasteHandlers = [];
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

  describe('ask_user_question flow', () => {
    const twoOptions = [
      { label: 'A', description: 'the first option' },
      { label: 'B', description: 'the second option' },
    ];

    const multiAskDetails = (
      onConfirm: (
        outcome: ToolConfirmationOutcome,
        payload?: ToolConfirmationPayload,
      ) => Promise<void>,
    ): ToolCallConfirmationDetails => ({
      type: 'ask_user_question',
      title: 'Three questions',
      questions: [
        {
          question: 'Pick a deploy target?',
          header: 'Deploy',
          options: [
            { label: 'staging', description: 'the staging target' },
            { label: 'prod', description: 'the production target' },
          ],
        },
        {
          question: 'Pick a region?',
          header: 'Region',
          options: [
            { label: 'eu', description: 'the eu region' },
            { label: 'us', description: 'the us region' },
          ],
        },
        {
          question: 'Pick channels?',
          header: 'Notify',
          multiSelect: true,
          options: [
            { label: 'mail', description: 'the mail channel' },
            { label: 'chat', description: 'the chat channel' },
          ],
        },
      ],
      onConfirm,
    });

    function mount(details: ToolCallConfirmationDetails): HTMLElement {
      return render(
        <OpenTuiToolConfirmation
          call={{
            callId: 'call-1',
            name: 'ask_user_question',
            confirmationDetails: details,
          }}
          config={trustedConfig}
          onSettled={() => {}}
        />,
      ).container;
    }

    function typeChars(text: string) {
      for (const char of text) press({ name: char, sequence: char });
    }

    /** Every character in one batch, as a burst of keypresses arrives. */
    function typeBatched(text: string) {
      act(() => {
        for (const char of text) {
          for (const handler of mocks.state.keyboardHandlers) {
            handler({ name: char, sequence: char });
          }
        }
      });
    }

    /**
     * Several keys in one batch. A held arrow key auto-repeats at ~30 ms and the
     * terminal delivers the events in one read, so every key of the burst is
     * handled against the same render.
     */
    function pressBatched(keys: Array<{ name: string; sequence?: string }>) {
      act(() => {
        for (const key of keys) {
          for (const handler of mocks.state.keyboardHandlers) {
            handler(key);
          }
        }
      });
    }

    function paste(text: string) {
      act(() => {
        for (const handler of mocks.state.pasteHandlers) {
          handler({
            bytes: new TextEncoder().encode(text),
            preventDefault: () => {},
          });
        }
      });
    }

    /** ink pauses before swapping tabs so the ✓ on the answered row shows. */
    function settleAdvance() {
      act(() => {
        vi.advanceTimersByTime(200);
      });
    }

    /** The character the software cursor is drawn on. */
    function cursorCell(container: HTMLElement): string {
      const cell = container.querySelector('[data-bg]');
      if (!cell) throw new Error('no cursor cell is drawn');
      return cell.textContent ?? '';
    }

    beforeEach(() => {
      vi.useFakeTimers();
    });
    afterEach(() => {
      vi.useRealTimers();
    });

    const wide = (tag: string) => tag.padEnd(30, '-');
    const twoWideHeaders = (
      onConfirm: (
        outcome: ToolConfirmationOutcome,
        payload?: ToolConfirmationPayload,
      ) => Promise<void>,
    ): ToolCallConfirmationDetails => ({
      type: 'ask_user_question',
      title: 'Two questions',
      questions: [
        {
          question: 'Pick a deploy target?',
          header: wide('deploy'),
          options: [{ label: 'staging', description: 'the staging target' }],
        },
        {
          question: 'Pick a region?',
          header: wide('region'),
          options: [{ label: 'eu', description: 'the eu region' }],
        },
      ],
      onConfirm,
    });

    it('fits headers that fill the chip row, and still clips ones that cannot fit', () => {
      // Eighty columns leaves this row room for both headers, and it is this arm
      // that fails when ink's transcript indent is charged to it as well.
      mocks.state.dimensions = { width: 80, height: 40 };
      const room = mount(twoWideHeaders(async () => {})).textContent ?? '';
      expect(room).toContain(wide('deploy'));
      expect(room).toContain(wide('region'));

      // Forty columns less leaves no room, so the cap still bites — and what
      // survives of the header is still on the row, which is what tells a
      // clipped chip apart from a row that drew no header at all.
      mocks.state.dimensions = { width: 40, height: 40 };
      const tight = mount(twoWideHeaders(async () => {})).textContent ?? '';
      expect(tight).not.toContain(wide('deploy'));
      expect(tight).toContain('deploy');
    });

    it('re-fits the chip row once its answered headers carry the mark', () => {
      // Each answered header gains a " ✓" that the row's own budget pays for, so
      // the row that fit both headers whole while they went unanswered has to
      // clip once both are answered. Measured at the width the arm above passes
      // at, so the only thing that moved is the answer count.
      mocks.state.dimensions = { width: 80, height: 40 };
      const container = mount(twoWideHeaders(async () => {}));
      expect(container.textContent ?? '').toContain(wide('deploy'));

      press({ name: '1', sequence: '1' });
      settleAdvance();
      press({ name: '1', sequence: '1' });
      settleAdvance();

      // Answering the second question lands on the Submit tab, whose review
      // list prints each header in full, so the row under measurement is the
      // text ahead of that list rather than the whole container.
      const chipRow = (container.textContent ?? '').split('Your answers:')[0];
      expect(chipRow).toContain('✓');
      expect(chipRow).toContain('deploy');
      expect(chipRow).not.toContain(wide('deploy'));
    });

    it('numbers each option and renders its description and the free-text row', () => {
      const text = mount(multiAskDetails(async () => {})).textContent ?? '';
      expect(text).toContain('1. staging');
      expect(text).toContain('the staging target');
      expect(text).toContain('2. prod');
      expect(text).toContain('3. Type something...');
    });

    it('commits a predefined option straight from its digit', () => {
      const onConfirm = vi.fn(async () => {});
      mount(askDetails(twoOptions, onConfirm));
      press({ name: '2', sequence: '2' });
      expect(onConfirm).toHaveBeenCalledWith(
        ToolConfirmationOutcome.ProceedOnce,
        { answers: { '0': 'B' } },
      );
    });

    it("only moves the cursor onto the free-text row for that row's own digit", () => {
      const onConfirm = vi.fn(async () => {});
      const container = mount(askDetails(twoOptions, onConfirm));
      press({ name: '3', sequence: '3' });
      expect(onConfirm).not.toHaveBeenCalled();
      typeChars('own answer');
      expect(container.textContent ?? '').toContain('> own answer');
      press({ name: 'return', sequence: '\r' });
      expect(onConfirm).toHaveBeenCalledWith(
        ToolConfirmationOutcome.ProceedOnce,
        { answers: { '0': 'own answer' } },
      );
    });

    it('deletes the last typed character on backspace', () => {
      const onConfirm = vi.fn(async () => {});
      mount(askDetails(twoOptions, onConfirm));
      press({ name: '3', sequence: '3' });
      typeChars('abc');
      press({ name: 'backspace' });
      press({ name: 'return', sequence: '\r' });
      expect(onConfirm).toHaveBeenCalledWith(
        ToolConfirmationOutcome.ProceedOnce,
        { answers: { '0': 'ab' } },
      );
    });

    it('appends a bracketed paste to the free-text row', () => {
      const onConfirm = vi.fn(async () => {});
      mount(askDetails(twoOptions, onConfirm));
      press({ name: '3', sequence: '3' });
      paste('a pasted answer');
      press({ name: 'return', sequence: '\r' });
      expect(onConfirm).toHaveBeenCalledWith(
        ToolConfirmationOutcome.ProceedOnce,
        { answers: { '0': 'a pasted answer' } },
      );
    });

    it('drops a paste that arrives while the cursor was on an option row', () => {
      // The composer is unmounted while this dialog owns the screen, so a
      // bracketed paste has nowhere else to go — but a row the cursor is not on
      // takes no key, and a paste is no different from one.
      const onConfirm = vi.fn(async () => {});
      const container = mount(askDetails(twoOptions, onConfirm));
      paste('stray');
      press({ name: '3', sequence: '3' });
      expect(container.textContent ?? '').toContain('> ');
      expect(container.textContent ?? '').not.toContain('stray');
    });

    it('keeps a pasted newline out of the row and inside the answer', () => {
      const onConfirm = vi.fn(async () => {});
      const container = mount(askDetails(twoOptions, onConfirm));
      press({ name: '3', sequence: '3' });
      paste('alpha\nbeta');
      press({ name: 'left' });
      // ink's single-line field draws the row the caret sits in, so the split
      // value neither grows this dialog nor detaches its cursor from the caret.
      expect(container.textContent ?? '').not.toContain('alpha');
      expect(container.textContent ?? '').toContain('beta');
      expect(cursorCell(container)).toBe('a');
      press({ name: 'up' });
      // The collapsed row echoes the same window: it stands in for the row the
      // cursor left, so the hidden half of the answer cannot grow the dialog
      // from there either.
      expect(container.textContent ?? '').not.toContain('alpha');
      press({ name: 'down' });
      press({ name: 'return', sequence: '\r' });
      expect(onConfirm).toHaveBeenCalledWith(
        ToolConfirmationOutcome.ProceedOnce,
        { answers: { '0': 'alpha\nbeta' } },
      );
    });

    it('keeps a long answer inside the width the row has', () => {
      // ink holds this exact field in a TextInput 50 cells wide and one row
      // tall. Without that window a single long paste grows the dialog past the
      // terminal height and pushes the options still to be picked off screen.
      const onConfirm = vi.fn(async () => {});
      const container = mount(askDetails(twoOptions, onConfirm));
      press({ name: '3', sequence: '3' });
      const long = 'x'.repeat(120);
      paste(long);
      expect(container.textContent ?? '').not.toContain('x'.repeat(50));
      expect(container.textContent ?? '').toContain('…');
      // The bound is on the drawing only: the answer keeps every character.
      press({ name: 'return', sequence: '\r' });
      expect(onConfirm).toHaveBeenCalledWith(
        ToolConfirmationOutcome.ProceedOnce,
        { answers: { '0': long } },
      );
    });

    it('keeps every character of a burst that shares one batch', () => {
      const onConfirm = vi.fn(async () => {});
      const container = mount(askDetails(twoOptions, onConfirm));
      press({ name: '3', sequence: '3' });
      typeBatched('burst');
      expect(container.textContent ?? '').toContain('> burst');
      press({ name: 'return', sequence: '\r' });
      expect(onConfirm).toHaveBeenCalledWith(
        ToolConfirmationOutcome.ProceedOnce,
        { answers: { '0': 'burst' } },
      );
    });

    it('opens the free-text row for the letters that follow its digit in one batch', () => {
      const onConfirm = vi.fn(async () => {});
      const container = mount(askDetails(twoOptions, onConfirm));
      // The digit moves the cursor onto the free-text row and the letters land in
      // the same read, so the row has to own them without a render in between.
      typeBatched('3abc');
      expect(container.textContent ?? '').toContain('> abc');
      press({ name: 'return', sequence: '\r' });
      expect(onConfirm).toHaveBeenCalledWith(
        ToolConfirmationOutcome.ProceedOnce,
        { answers: { '0': 'abc' } },
      );
    });

    it('walks a held arrow key over every row it repeats through', () => {
      const onConfirm = vi.fn(async () => {});
      const container = mount(askDetails(twoOptions, onConfirm));
      pressBatched([
        { name: 'down' },
        { name: 'down' },
        { name: 'down' },
        { name: 'x', sequence: 'x' },
      ]);
      expect(container.textContent ?? '').toContain('> x');
      expect(onConfirm).not.toHaveBeenCalled();
    });

    it('commits the row the cursor ended on when its Enter shares one batch', () => {
      const onConfirm = vi.fn(async () => {});
      mount(askDetails(twoOptions, onConfirm));
      pressBatched([{ name: 'down' }, { name: 'return', sequence: '\r' }]);
      expect(onConfirm).toHaveBeenCalledWith(
        ToolConfirmationOutcome.ProceedOnce,
        { answers: { '0': 'B' } },
      );
    });

    it('unticks an option when both ticks of a burst share one batch', () => {
      const onConfirm = vi.fn(async () => {});
      const container = mount(multiAskDetails(onConfirm));
      press({ name: 'right' });
      press({ name: 'right' });
      pressBatched([
        { name: 'space', sequence: ' ' },
        { name: 'space', sequence: ' ' },
      ]);
      expect(container.textContent ?? '').not.toContain('[✓]');
      press({ name: 'return', sequence: '\r' });
      expect(onConfirm).not.toHaveBeenCalled();
    });

    it('sends an option ticked in the same batch as its Enter', () => {
      const onConfirm = vi.fn(async () => {});
      mount(askDetails(twoOptions, onConfirm, true));
      pressBatched([
        { name: 'space', sequence: ' ' },
        { name: 'return', sequence: '\r' },
      ]);
      expect(onConfirm).toHaveBeenCalledWith(
        ToolConfirmationOutcome.ProceedOnce,
        { answers: { '0': 'A' } },
      );
    });

    it('ticks the option an arrow reached in the same batch', () => {
      const onConfirm = vi.fn(async () => {});
      const container = mount(askDetails(twoOptions, onConfirm, true));
      pressBatched([{ name: 'down' }, { name: 'space', sequence: ' ' }]);
      // Held arrow + Space out of one read: the cursor moved to B, and the Space
      // has to follow it instead of re-toggling the row this render drew.
      expect(container.textContent ?? '').toContain('[✓] 2. B');
      press({ name: 'return', sequence: '\r' });
      expect(onConfirm).toHaveBeenCalledWith(
        ToolConfirmationOutcome.ProceedOnce,
        { answers: { '0': 'B' } },
      );
    });

    it('answers the free-text row an arrow burst reached in the same read', () => {
      const onConfirm = vi.fn(async () => {});
      mount(askDetails(twoOptions, onConfirm));
      // Off the option list and onto the free-text row, then that row's own
      // character and its Enter, all out of one stdin read: the submit has to
      // follow the cursor the arrows moved, not the one this render drew.
      pressBatched([
        { name: 'down' },
        { name: 'down' },
        { name: 'x', sequence: 'x' },
        { name: 'return', sequence: '\r' },
      ]);
      expect(onConfirm).toHaveBeenCalledWith(
        ToolConfirmationOutcome.ProceedOnce,
        { answers: { '0': 'x' } },
      );
    });

    it('edits the middle of a typed answer', () => {
      const onConfirm = vi.fn(async () => {});
      const container = mount(askDetails(twoOptions, onConfirm));
      press({ name: '3', sequence: '3' });
      typeChars('abcdef');
      press({ name: 'left' });
      press({ name: 'left' });
      expect(cursorCell(container)).toBe('e');
      typeChars('X');
      press({ name: 'return', sequence: '\r' });
      expect(onConfirm).toHaveBeenCalledWith(
        ToolConfirmationOutcome.ProceedOnce,
        { answers: { '0': 'abcdXef' } },
      );
    });

    it('moves the caret instead of the question with the arrows', () => {
      const onConfirm = vi.fn(async () => {});
      const container = mount(multiAskDetails(onConfirm));
      press({ name: '3', sequence: '3' });
      typeChars('ab');
      press({ name: 'left' });
      press({ name: 'left' });
      press({ name: 'right' });
      // the row owns the cursor, so neither arrow reached the tab switch
      expect(cursorCell(container)).toBe('b');
      expect(container.textContent ?? '').toContain('Pick a deploy target?');
      press({ name: 'return', sequence: '\r' });
      expect(container.textContent ?? '').not.toContain('Pick a region?');
      settleAdvance();
      expect(container.textContent ?? '').toContain('Pick a region?');
    });

    it('restarts the caret past the value when the row is selected again', () => {
      const onConfirm = vi.fn(async () => {});
      const container = mount(askDetails(twoOptions, onConfirm));
      press({ name: '3', sequence: '3' });
      typeChars('abc');
      press({ name: 'left' });
      press({ name: 'left' });
      press({ name: 'left' });
      expect(cursorCell(container)).toBe('a');
      // ink mounts this field per selected row, and mounts it at the end of the
      // value it holds, so leaving the row and returning drops that position
      press({ name: 'up' });
      press({ name: 'down' });
      typeChars('X');
      expect(container.textContent ?? '').toContain('> abcX');
      press({ name: 'return', sequence: '\r' });
      expect(onConfirm).toHaveBeenCalledWith(
        ToolConfirmationOutcome.ProceedOnce,
        { answers: { '0': 'abcX' } },
      );
    });

    it('advances exactly one tab when a typed answer is committed', () => {
      const onConfirm = vi.fn(async () => {});
      const container = mount(multiAskDetails(onConfirm));
      press({ name: 'return', sequence: '\r' });
      settleAdvance();
      expect(container.textContent ?? '').toContain('Pick a region?');
      press({ name: 'down' });
      press({ name: 'down' });
      typeChars('typed');
      press({ name: 'return', sequence: '\r' });
      settleAdvance();
      // ink mounts a TextInput whose own Enter subscriber fires alongside the
      // dialog's, so one keystroke skips this question entirely.
      expect(container.textContent ?? '').toContain('Pick channels?');
      expect(onConfirm).not.toHaveBeenCalled();
    });

    it('advances one tab when a second answer lands inside the pause', () => {
      const onConfirm = vi.fn(async () => {});
      const container = mount(multiAskDetails(onConfirm));
      press({ name: 'return', sequence: '\r' });
      act(() => {
        vi.advanceTimersByTime(50);
      });
      press({ name: 'down' });
      press({ name: 'return', sequence: '\r' });
      settleAdvance();
      // Both keystrokes answered the first question, so only the pause scheduled
      // by the second one may swap tabs.
      expect(container.textContent ?? '').toContain('Pick a region?');
      expect(container.textContent ?? '').toContain('Deploy ✓');
      expect(onConfirm).not.toHaveBeenCalled();
    });

    it('keeps the question a manual tab move lands on during a pending pause', () => {
      const onConfirm = vi.fn(async () => {});
      const container = mount(multiAskDetails(onConfirm));
      press({ name: 'return', sequence: '\r' });
      act(() => {
        vi.advanceTimersByTime(50);
      });
      // The answer to the first question still has its swap pending, and looking
      // ahead by hand must not have that swap fire one tab further on.
      press({ name: 'right' });
      settleAdvance();
      expect(container.textContent ?? '').toContain('Pick a region?');
      expect(container.textContent ?? '').not.toContain('Pick channels?');
      expect(onConfirm).not.toHaveBeenCalled();
    });

    it('joins the checked options and counts the typed entry on a multi-select', () => {
      const onConfirm = vi.fn(async () => {});
      const container = mount(multiAskDetails(onConfirm));
      press({ name: 'right' });
      press({ name: 'right' });
      expect(container.textContent ?? '').toContain('Pick channels?');
      press({ name: 'space', sequence: ' ' });
      press({ name: 'down' });
      press({ name: 'space', sequence: ' ' });
      press({ name: 'down' });
      typeChars('sms');
      press({ name: 'return', sequence: '\r' });
      settleAdvance();
      expect(container.textContent ?? '').toContain('Notify: mail, chat, sms');
      press({ name: 'return', sequence: '\r' });
      expect(onConfirm).toHaveBeenCalledWith(
        ToolConfirmationOutcome.ProceedOnce,
        { answers: { '2': 'mail, chat, sms' } },
      );
    });

    it('takes the typed entry of the tab the cursor is on, not the one last drawn', () => {
      // The tab move and the Enter that follows it are handled against the render
      // that drew the previous question's empty entry, so the value has to be
      // read from the live tab the way submitCustomRow reads it.
      const onConfirm = vi.fn(async () => {});
      const container = mount(multiAskDetails(onConfirm));
      press({ name: 'right' });
      press({ name: 'right' });
      press({ name: 'down' });
      press({ name: 'down' });
      typeChars('sms');
      press({ name: 'up' });
      press({ name: 'left' });
      pressBatched([{ name: 'right' }, { name: 'return', sequence: '\r' }]);
      settleAdvance();
      expect(container.textContent ?? '').toContain('Notify: sms');
      press({ name: 'return', sequence: '\r' });
      expect(onConfirm).toHaveBeenCalledWith(
        ToolConfirmationOutcome.ProceedOnce,
        { answers: { '2': 'sms' } },
      );
    });

    it('drops the letter that trails the Enter of the same read', () => {
      // A multi-select's answer is assembled from the field again at submit-all
      // time, so a letter handled after the Enter that already gave the answer
      // would widen it: the read has to stop at its own Enter.
      const onConfirm = vi.fn(async () => {});
      const container = mount(multiAskDetails(onConfirm));
      press({ name: 'right' });
      press({ name: 'right' });
      press({ name: 'down' });
      press({ name: 'down' });
      pressBatched([
        { name: 's', sequence: 's' },
        { name: 'm', sequence: 'm' },
        { name: 's', sequence: 's' },
        { name: 'return', sequence: '\r' },
        { name: 'Z', sequence: 'Z' },
      ]);
      settleAdvance();
      expect(container.textContent ?? '').not.toContain('smsZ');
      press({ name: 'return', sequence: '\r' });
      expect(onConfirm).toHaveBeenCalledWith(
        ToolConfirmationOutcome.ProceedOnce,
        { answers: { '2': 'sms' } },
      );
    });

    it('carries an answer given earlier in the same read into the submit that ends it', () => {
      // The digit only queues the answer, so the Submit tab this same read walks
      // to has to read it from the mirror: the render that armed the handler
      // predates the burst and still reports the question unanswered.
      const onConfirm = vi.fn(async () => {});
      mount(multiAskDetails(onConfirm));
      pressBatched([
        { name: '1', sequence: '1' },
        { name: 'right' },
        { name: 'right' },
        { name: 'right' },
        { name: 'return', sequence: '\r' },
      ]);
      expect(onConfirm).toHaveBeenCalledWith(
        ToolConfirmationOutcome.ProceedOnce,
        { answers: { '0': 'staging' } },
      );
    });

    it('counts a typed entry the same read checked and submitted', () => {
      // Typing into a multi-select row is what ticks its box, and the tick is
      // what submitAll asks for. Both land in one read here, so the flag has to
      // be readable before the render that carries it.
      const onConfirm = vi.fn(async () => {});
      mount(multiAskDetails(onConfirm));
      press({ name: 'right' });
      press({ name: 'right' });
      press({ name: 'down' });
      press({ name: 'down' });
      pressBatched([
        { name: 's', sequence: 's' },
        { name: 'm', sequence: 'm' },
        { name: 's', sequence: 's' },
        { name: 'return', sequence: '\r' },
        // Off the row before the arrow becomes a tab move, as above.
        { name: 'up' },
        { name: 'right' },
        { name: 'return', sequence: '\r' },
      ]);
      expect(onConfirm).toHaveBeenCalledWith(
        ToolConfirmationOutcome.ProceedOnce,
        { answers: { '2': 'sms' } },
      );
    });

    it('keeps a submitted row closed to the read that follows the submit', () => {
      // The submit's own re-render parks the dialog on the answered tab for the
      // whole pause, with the row still mounted and still focused, so a latch
      // that re-render clears hands the field back to the next read and lets it
      // widen an answer already recorded.
      const onConfirm = vi.fn(async () => {});
      const container = mount(multiAskDetails(onConfirm));
      press({ name: 'right' });
      press({ name: 'right' });
      press({ name: 'down' });
      press({ name: 'down' });
      typeChars('sms');
      press({ name: 'return', sequence: '\r' });
      act(() => {
        vi.advanceTimersByTime(50);
      });
      typeChars('Z');
      settleAdvance();
      expect(container.textContent ?? '').not.toContain('smsZ');
      press({ name: 'return', sequence: '\r' });
      expect(onConfirm).toHaveBeenCalledWith(
        ToolConfirmationOutcome.ProceedOnce,
        { answers: { '2': 'sms' } },
      );
    });

    it('keeps a digit trailing an answer in the same read from replacing it', () => {
      // The field's own latch only reaches its insert branch. An arrow in the
      // same read steps the cursor off the free-text row, so the digit behind it
      // lands on the option branch and answers the question a second time while
      // the pause still holds the row it settled on screen.
      const onConfirm = vi.fn(async () => {});
      mount(multiAskDetails(onConfirm));
      press({ name: 'down' });
      press({ name: 'down' });
      typeChars('xyz');
      pressBatched([
        { name: 'return', sequence: '\r' },
        { name: 'up' },
        { name: '1', sequence: '1' },
        { name: 'right' },
        { name: 'right' },
        { name: 'right' },
        { name: 'return', sequence: '\r' },
      ]);
      expect(onConfirm).toHaveBeenCalledWith(
        ToolConfirmationOutcome.ProceedOnce,
        { answers: { '0': 'xyz' } },
      );
    });

    it('moves the cursor with a digit on a multi-select tab instead of ticking it', () => {
      // On a single-select the digit commits the option it names. On a
      // multi-select it stays ink's cursor move: an answer there is given by
      // Space or by the free-text row, so a digit that also ticked would hand one
      // over that no key asked for.
      const onConfirm = vi.fn(async () => {});
      const container = mount(multiAskDetails(onConfirm));
      press({ name: 'right' });
      press({ name: 'right' });
      press({ name: '2', sequence: '2' });
      expect(container.textContent ?? '').toContain('❯ [ ] 2. chat');
      expect(container.textContent ?? '').not.toContain('[✓]');
      settleAdvance();
      // Nothing was answered, so the pause has no tab to swap to.
      expect(container.textContent ?? '').toContain('Pick channels?');
      expect(onConfirm).not.toHaveBeenCalled();
    });

    it('holds a tick the same read trails a multi-select answer with', () => {
      // A multi-select answer is rebuilt from its ticked boxes at submit, so a
      // Space behind the Enter changes an answer already given: the pause still
      // holds the question the Enter settled.
      const onConfirm = vi.fn(async () => {});
      mount(multiAskDetails(onConfirm));
      press({ name: 'right' });
      press({ name: 'right' });
      press({ name: 'space', sequence: ' ' });
      press({ name: 'down' });
      press({ name: 'down' });
      typeChars('sms');
      pressBatched([
        { name: 'return', sequence: '\r' },
        { name: 'up' },
        { name: 'space', sequence: ' ' },
        { name: 'right' },
        { name: 'return', sequence: '\r' },
      ]);
      expect(onConfirm).toHaveBeenCalledWith(
        ToolConfirmationOutcome.ProceedOnce,
        { answers: { '2': 'mail, sms' } },
      );
    });

    it('drops the letters of a burst that moved to another tab', () => {
      // The free-text field re-seeds its buffer during render, so the letters
      // after a tab move in the same read would append to the question that
      // render drew and store it under the tab the burst reached.
      const onConfirm = vi.fn(async () => {});
      const container = mount(multiAskDetails(onConfirm));
      press({ name: 'down' });
      press({ name: 'down' });
      typeChars('ab');
      // The row owns ←/→ for in-field caret movement, so the cursor has to be
      // off it before the arrow becomes a tab move.
      press({ name: 'up' });
      pressBatched([
        { name: 'right' },
        { name: 'down' },
        { name: 'down' },
        { name: 'x', sequence: 'x' },
      ]);
      expect(container.textContent ?? '').not.toContain('abx');
      // The row the burst ended on belongs to the tab it reached, and '> ' is
      // drawn only by that field, so this is that field and not an option row.
      expect(container.textContent ?? '').not.toContain('> x');
      press({ name: 'return', sequence: '\r' });
      press({ name: 'up' });
      press({ name: 'left' });
      press({ name: 'down' });
      press({ name: 'down' });
      expect(container.textContent ?? '').toContain('> ab');
      // The storage half: the burst's Enter answered nothing, so the review tab
      // still lists the question the burst landed on as open.
      press({ name: 'up' });
      press({ name: 'right' });
      press({ name: 'right' });
      press({ name: 'right' });
      expect(container.textContent ?? '').toContain('Region: (not answered)');
    });

    it('drops a paste that trails the keys of one read onto another tab', () => {
      // One stdin read carries both: the arrows move the live cursor onto
      // another question's free-text row while the paste handler still sees the
      // render that drew this one, and the write path files under the live tab.
      // Left unguarded, one question's half-typed answer is concatenated with
      // the paste and submitted as another question's.
      const onConfirm = vi.fn(async () => {});
      const container = mount(multiAskDetails(onConfirm));
      press({ name: 'down' });
      press({ name: 'down' });
      typeChars('ab');
      act(() => {
        // The row owns ←/→ for in-field caret movement, so the ↑ that leaves it
        // has to be part of the same read for the arrows to become tab moves.
        const keys = [
          { name: 'up' },
          { name: 'right' },
          { name: 'down' },
          { name: 'down' },
        ];
        for (const key of keys) {
          for (const handler of mocks.state.keyboardHandlers) handler(key);
        }
        for (const handler of mocks.state.pasteHandlers) {
          handler({
            bytes: new TextEncoder().encode('xyz'),
            preventDefault: () => {},
          });
        }
      });
      expect(container.textContent ?? '').not.toContain('abxyz');
      press({ name: 'up' });
      press({ name: 'right' });
      press({ name: 'right' });
      expect(container.textContent ?? '').toContain('Region: (not answered)');
    });

    it('drops a paste that trails an answer the pause is still holding', () => {
      // The row the answer came from stays drawn and focused for ink's 150 ms
      // pause, so a paste in that window would widen an answer already
      // recorded — here a multi-select box whose ticks made the answer.
      const onConfirm = vi.fn(async () => {});
      const container = mount(multiAskDetails(onConfirm));
      press({ name: 'right' });
      press({ name: 'right' });
      press({ name: 'space', sequence: ' ' });
      press({ name: 'return', sequence: '\r' });
      press({ name: 'down' });
      press({ name: 'down' });
      paste('xyz');
      settleAdvance();
      expect(container.textContent ?? '').toContain('Notify: mail');
      expect(container.textContent ?? '').not.toContain('mail, xyz');
    });

    it('keeps a free-text row editable whose submit the pause rejected', () => {
      // Nothing was recorded, so the row has not submitted and the letters
      // trailing that Enter in the same read still belong to it. Latched
      // anyway, the row would swallow them and the answer the user comes back
      // to give is the shorter one.
      const onConfirm = vi.fn(async () => {});
      const container = mount(multiAskDetails(onConfirm));
      pressBatched([
        { name: 'return', sequence: '\r' },
        { name: 'down' },
        { name: 'down' },
        { name: 'f', sequence: 'f' },
        { name: 'o', sequence: 'o' },
        { name: 'o', sequence: 'o' },
        { name: 'return', sequence: '\r' },
        { name: 'b', sequence: 'b' },
        { name: 'a', sequence: 'a' },
        { name: 'r', sequence: 'r' },
      ]);
      settleAdvance();
      press({ name: 'left' });
      press({ name: 'down' });
      press({ name: 'down' });
      expect(container.textContent ?? '').toContain('foobar');
      press({ name: 'return', sequence: '\r' });
      settleAdvance();
      press({ name: 'right' });
      press({ name: 'right' });
      press({ name: 'right' });
      press({ name: 'return', sequence: '\r' });
      expect(onConfirm).toHaveBeenCalledWith(
        ToolConfirmationOutcome.ProceedOnce,
        { answers: { '0': 'foobar' } },
      );
    });

    it('reviews every answer on the Submit tab and cancels from its second row', () => {
      const onConfirm = vi.fn(async () => {});
      const container = mount(multiAskDetails(onConfirm));
      press({ name: 'return', sequence: '\r' });
      settleAdvance();
      press({ name: 'right' });
      press({ name: 'right' });
      const text = container.textContent ?? '';
      expect(text).toContain('Your answers:');
      expect(text).toContain('Deploy: staging');
      expect(text).toContain('Region: (not answered)');
      press({ name: 'down' });
      press({ name: 'return', sequence: '\r' });
      expect(onConfirm).toHaveBeenCalledWith(
        ToolConfirmationOutcome.Cancel,
        undefined,
      );
    });
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
});
