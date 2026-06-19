/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, vi } from 'vitest';
import { ToolConfirmationOutcome } from '@qwen-code/qwen-code-core';
import {
  outcomeToOptionId,
  buildDaemonConfirmation,
} from './daemonConfirmation.js';
import type { PendingPermission } from './projectDaemonEvent.js';

// Ground truth: the exact `options` a live 0.17.x daemon sent for a write_file
// (edit) gate — captured via scripts/capture-daemon-frames.mts. Note there is
// NO `reject_always` in an edit's option set.
const EDIT_OPTIONS: PendingPermission['options'] = [
  { kind: 'allow_always', name: 'Allow All Edits', optionId: 'proceed_always' },
  { kind: 'allow_once', name: 'Allow', optionId: 'proceed_once' },
  { kind: 'reject_once', name: 'Reject', optionId: 'cancel' },
];

describe('outcomeToOptionId', () => {
  it('maps ProceedOnce → the allow_once option', () => {
    expect(
      outcomeToOptionId(ToolConfirmationOutcome.ProceedOnce, EDIT_OPTIONS),
    ).toBe('proceed_once');
  });

  it('maps every ProceedAlways* variant → the single allow_always option', () => {
    for (const o of [
      ToolConfirmationOutcome.ProceedAlways,
      ToolConfirmationOutcome.ProceedAlwaysProject,
      ToolConfirmationOutcome.ProceedAlwaysUser,
      ToolConfirmationOutcome.ProceedAlwaysServer,
      ToolConfirmationOutcome.ProceedAlwaysTool,
    ]) {
      expect(outcomeToOptionId(o, EDIT_OPTIONS)).toBe('proceed_always');
    }
  });

  it('maps Cancel (and Modify/Restore) → the reject_once option', () => {
    for (const o of [
      ToolConfirmationOutcome.Cancel,
      ToolConfirmationOutcome.ModifyWithEditor,
      ToolConfirmationOutcome.RestorePrevious,
    ]) {
      expect(outcomeToOptionId(o, EDIT_OPTIONS)).toBe('cancel');
    }
  });

  it('falls back to reject_always when reject_once is absent', () => {
    const opts: PendingPermission['options'] = [
      { kind: 'allow_once', optionId: 'a' },
      { kind: 'reject_always', optionId: 'r_all' },
    ];
    expect(outcomeToOptionId(ToolConfirmationOutcome.Cancel, opts)).toBe(
      'r_all',
    );
  });

  it('returns null when no reject option exists (caller declines explicitly)', () => {
    const opts: PendingPermission['options'] = [
      { kind: 'allow_once', optionId: 'a' },
    ];
    expect(outcomeToOptionId(ToolConfirmationOutcome.Cancel, opts)).toBeNull();
  });

  it('falls back allow_always → allow_once when no allow_always exists', () => {
    const opts: PendingPermission['options'] = [
      { kind: 'allow_once', optionId: 'once' },
      { kind: 'reject_once', optionId: 'no' },
    ];
    expect(outcomeToOptionId(ToolConfirmationOutcome.ProceedAlways, opts)).toBe(
      'once',
    );
  });
});

describe('buildDaemonConfirmation', () => {
  const gate: PendingPermission = {
    requestId: 'req_1',
    toolCallId: 'call_1',
    title: 'Writing to /tmp/capture_probe.txt',
    options: EDIT_OPTIONS,
  };

  it('builds an `info` confirmation carrying the tool title', () => {
    const details = buildDaemonConfirmation(gate, vi.fn());
    expect(details.type).toBe('info');
    expect(details.title).toBe('Writing to /tmp/capture_probe.txt');
    expect((details as { prompt: string }).prompt).toBe(
      'Writing to /tmp/capture_probe.txt',
    );
  });

  it('onConfirm maps the outcome and posts the resolved optionId', async () => {
    const respond = vi.fn(async () => {});
    const details = buildDaemonConfirmation(gate, respond);
    await details.onConfirm(ToolConfirmationOutcome.ProceedAlways);
    expect(respond).toHaveBeenCalledWith('proceed_always');
    await details.onConfirm(ToolConfirmationOutcome.Cancel);
    expect(respond).toHaveBeenLastCalledWith('cancel');
  });

  it('falls back to a generic title when the gate has none', () => {
    const details = buildDaemonConfirmation(
      { ...gate, title: undefined },
      vi.fn(),
    );
    expect(details.title).toBe('Tool approval requested');
  });
});
