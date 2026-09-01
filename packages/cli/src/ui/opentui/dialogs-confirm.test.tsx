/**
 * @license
 * Copyright 2026 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Outcome-option construction for the tool-confirmation dialog: the
 * always-allow rows depend on the optional `hideAlwaysAllow` flag that only
 * some confirmation-detail union members carry (ask_user_question has no such
 * field), so the gate must narrow before reading it.
 */

import { describe, it, expect, vi } from 'vitest';

// theme.ts builds a SyntaxStyle at module scope, which needs the OpenTUI
// native FFI — unavailable in the test runtime. Stub the graphics surface.
vi.mock('@opentui/core', () => ({
  SyntaxStyle: { fromStyles: () => ({}) },
  MouseButton: { LEFT: 0 },
}));

import {
  ToolConfirmationOutcome,
  type ToolCallConfirmationDetails,
} from '@qwen-code/qwen-code-core';
import { buildOutcomeOptions } from './dialogs-confirm.js';

const onConfirm = async () => {};

const execDetails = (
  hideAlwaysAllow?: boolean,
): ToolCallConfirmationDetails => ({
  type: 'exec',
  title: 'Run command',
  onConfirm,
  hideAlwaysAllow,
  command: 'ls -la',
  rootCommand: 'ls',
});

const askDetails = (): ToolCallConfirmationDetails => ({
  type: 'ask_user_question',
  title: 'A question',
  questions: [
    {
      question: 'Pick one',
      header: 'Choice',
      options: [{ label: 'A', description: 'option a' }],
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
