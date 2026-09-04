/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import { ToolConfirmationOutcome } from '@qwen-code/qwen-code-core/subagentRuntime';
import {
  externalModelLabel,
  optionKindForOutcome,
  resolvePermissionMode,
} from './acp-subagent-executor.js';

describe('resolvePermissionMode', () => {
  // The security-critical case. `~/.claude/settings.json` on a real machine may
  // set `permissions.defaultMode: "auto"`, under which the adapter self-approves
  // every tool call and emits no permission request at all. A definition that
  // declares nothing must therefore resolve to a mode that asks, not to
  // "whatever the external agent's own config says".
  it('fails safe to the asking mode when nothing is declared', () => {
    expect(resolvePermissionMode(undefined, undefined)).toBe('default');
    expect(resolvePermissionMode('', '')).toBe('default');
    expect(resolvePermissionMode('   ', undefined)).toBe('default');
  });

  it('fails safe to the asking mode for an unrecognized value', () => {
    expect(resolvePermissionMode('turbo', undefined)).toBe('default');
    expect(resolvePermissionMode(undefined, 'nonsense')).toBe('default');
  });

  it('maps qwen approval modes onto Claude permission modes', () => {
    expect(resolvePermissionMode(undefined, 'yolo')).toBe('auto');
    expect(resolvePermissionMode(undefined, 'auto')).toBe('auto');
    expect(resolvePermissionMode(undefined, 'auto-edit')).toBe('acceptEdits');
    expect(resolvePermissionMode(undefined, 'plan')).toBe('plan');
    expect(resolvePermissionMode(undefined, 'default')).toBe('default');
  });

  it('maps Claude-style permission mode spellings', () => {
    expect(resolvePermissionMode('acceptEdits', undefined)).toBe('acceptEdits');
    expect(resolvePermissionMode('manual', undefined)).toBe('default');
    expect(resolvePermissionMode('bypass', undefined)).toBe(
      'bypassPermissions',
    );
    expect(resolvePermissionMode('bypassPermissions', undefined)).toBe(
      'bypassPermissions',
    );
    expect(resolvePermissionMode('dontAsk', undefined)).toBe('default');
  });

  it('is case and whitespace insensitive', () => {
    expect(resolvePermissionMode('  AUTO  ', undefined)).toBe('auto');
    expect(resolvePermissionMode('AcceptEdits', undefined)).toBe('acceptEdits');
  });

  it('prefers permissionMode over approvalMode', () => {
    // permissionMode is the definition's own Claude-shaped declaration;
    // approvalMode is the loader's bridged fallback.
    expect(resolvePermissionMode('plan', 'yolo')).toBe('plan');
  });
});

describe('optionKindForOutcome', () => {
  it('maps a single approval to allow_once', () => {
    expect(optionKindForOutcome(ToolConfirmationOutcome.ProceedOnce)).toBe(
      'allow_once',
    );
    expect(
      optionKindForOutcome(
        ToolConfirmationOutcome.ProceedOnceAndSwitchToDefault,
      ),
    ).toBe('allow_once');
  });

  it('maps every persisted-always variant to allow_always', () => {
    expect(optionKindForOutcome(ToolConfirmationOutcome.ProceedAlways)).toBe(
      'allow_always',
    );
    expect(
      optionKindForOutcome(ToolConfirmationOutcome.ProceedAlwaysProject),
    ).toBe('allow_always');
    expect(
      optionKindForOutcome(ToolConfirmationOutcome.ProceedAlwaysUser),
    ).toBe('allow_always');
  });

  it('maps cancellation and editor-modification to a rejection', () => {
    // ModifyWithEditor cannot be honoured over ACP — there is no channel to
    // hand the user's edited arguments back — so it must reject rather than
    // silently approve the original call.
    expect(optionKindForOutcome(ToolConfirmationOutcome.Cancel)).toBe(
      'reject_once',
    );
    expect(optionKindForOutcome(ToolConfirmationOutcome.ModifyWithEditor)).toBe(
      'reject_once',
    );
  });

  it('never returns an unknown kind', () => {
    for (const outcome of Object.values(ToolConfirmationOutcome)) {
      expect(['allow_once', 'allow_always', 'reject_once']).toContain(
        optionKindForOutcome(outcome),
      );
    }
  });
});

describe('externalModelLabel', () => {
  it('labels with the command basename, not the parent model', () => {
    expect(externalModelLabel('npx')).toBe('external-acp:npx');
    expect(externalModelLabel('/usr/local/bin/claude')).toBe(
      'external-acp:claude',
    );
    expect(externalModelLabel('C:\\tools\\agent.exe')).toBe(
      'external-acp:agent.exe',
    );
  });
});
