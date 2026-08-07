/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { Readable } from 'node:stream';
import { describe, expect, it, vi } from 'vitest';
import {
  runWriteConfirmation,
  runWriteConfirmationCli,
} from './write-confirmation.js';

describe('write confirmation Hook', () => {
  it.each(['default', 'auto', 'auto_edit', 'auto-edit', 'yolo'])(
    'asks in %s mode and displays a reversible escaped representation',
    (permissionMode) => {
      const content =
        '  quote " slash \\ newline\nnull \u0000 c1 \u0085 line \u2028 paragraph \u2029 zero \u200b bidi \u202e supplemental \u{110bd}  ';

      const result = runWriteConfirmation(
        validInput({ permission_mode: permissionMode, content }),
      );

      expect(result.hookSpecificOutput.permissionDecision).toBe('ask');
      const reason = result.hookSpecificOutput.permissionDecisionReason;
      const serialized = reason.slice(reason.indexOf('\n') + 1);
      expect(JSON.parse(serialized)).toBe(content);
      expect(reason).not.toContain('\u0000');
      expect(reason).not.toContain('\u0085');
      expect(reason).not.toContain('\u2028');
      expect(reason).not.toContain('\u2029');
      expect(reason).not.toContain('\u200b');
      expect(reason).not.toContain('\u202e');
      expect(reason).not.toContain('\u{110bd}');
      expect(reason).toContain('\\u0000');
      expect(reason).toContain('\\u0085');
      expect(reason).toContain('\\u2028');
      expect(reason).toContain('\\u2029');
      expect(reason).toContain('\\u200b');
      expect(reason).toContain('\\u202e');
      expect(reason).toContain('\\ud804\\udcbd');
    },
  );

  it.each([
    ['wrong event', validInput({ hook_event_name: 'PostToolUse' })],
    ['wrong tool', validInput({ tool_name: 'context_remember' })],
  ])('passes through %s', (_name, input) => {
    expect(runWriteConfirmation(input)).toEqual({});
  });

  it.each([
    ['missing input', validInput({ tool_input: undefined })],
    ['non-string content', validInput({ content: 42 })],
    ['whitespace content', validInput({ content: ' \t\n' })],
    ['control-only content', validInput({ content: '\u0000\u200b\u202e' })],
    ['unpaired high surrogate', validInput({ content: '\ud800' })],
    ['unpaired low surrogate', validInput({ content: '\udc00' })],
    ['oversized content', validInput({ content: '🙂'.repeat(4001) })],
    ['non-object input', null],
  ])('denies invalid matching request: %s', (_name, input) => {
    const result = runWriteConfirmation(input);

    expect(result.hookSpecificOutput).toEqual({
      hookEventName: 'PreToolUse',
      permissionDecision: 'deny',
      permissionDecisionReason:
        'External context memory write confirmation request is invalid.',
    });
  });

  it.each([
    ['plan', 'External context memory writes are not allowed in plan mode.'],
    ['future', 'External context memory write permission mode is unsupported.'],
  ])('denies %s mode with a specific reason', (permissionMode, reason) => {
    const result = runWriteConfirmation(
      validInput({ permission_mode: permissionMode }),
    );

    expect(result.hookSpecificOutput).toEqual({
      hookEventName: 'PreToolUse',
      permissionDecision: 'deny',
      permissionDecisionReason: reason,
    });
  });

  it('ignores extra tool arguments that the MCP schema strips', () => {
    const content = 'repository policy';

    const result = runWriteConfirmation(
      validInput({ content, extraToolInput: true }),
    );

    expect(result.hookSpecificOutput.permissionDecision).toBe('ask');
    const serialized = result.hookSpecificOutput.permissionDecisionReason.slice(
      result.hookSpecificOutput.permissionDecisionReason.indexOf('\n') + 1,
    );
    expect(JSON.parse(serialized)).toBe(content);
  });

  it('accepts exactly 4000 Unicode code points', () => {
    const content = '🙂'.repeat(4000);

    const result = runWriteConfirmation(validInput({ content }));

    expect(result.hookSpecificOutput.permissionDecision).toBe('ask');
    expect(
      JSON.parse(
        result.hookSpecificOutput.permissionDecisionReason.split('\n')[1] ??
          'null',
      ),
    ).toBe(content);
  });

  it.each([
    ['malformed JSON', Readable.from(['{'])],
    [
      'oversized input',
      Readable.from([JSON.stringify({ content: 'x'.repeat(1024 * 1024 + 1) })]),
    ],
  ])('writes a deny response for %s', async (_name, input) => {
    const write = vi.fn();

    await runWriteConfirmationCli(input, { write });

    expect(write).toHaveBeenCalledTimes(1);
    expect(JSON.parse(write.mock.calls[0]?.[0] as string)).toMatchObject({
      hookSpecificOutput: { permissionDecision: 'deny' },
    });
  });

  it('writes one ask response for valid CLI input', async () => {
    const write = vi.fn();
    const input = Readable.from([JSON.stringify(validInput())]);

    await runWriteConfirmationCli(input, { write });

    expect(write).toHaveBeenCalledTimes(1);
    expect(JSON.parse(write.mock.calls[0]?.[0] as string)).toMatchObject({
      hookSpecificOutput: { permissionDecision: 'ask' },
    });
  });

  it('propagates output failures to the process entry point', async () => {
    const input = Readable.from([JSON.stringify(validInput())]);

    await expect(
      runWriteConfirmationCli(input, {
        write: () => {
          throw new Error('broken stdout');
        },
      }),
    ).rejects.toThrow('broken stdout');
  });
});

function validInput(
  overrides: {
    hook_event_name?: unknown;
    tool_name?: unknown;
    permission_mode?: unknown;
    content?: unknown;
    tool_input?: unknown;
    extraToolInput?: boolean;
  } = {},
): Record<string, unknown> {
  const toolInput = Object.hasOwn(overrides, 'tool_input')
    ? overrides.tool_input
    : {
        content: overrides.content ?? 'repository policy',
        ...(overrides.extraToolInput ? { tenant: 'other' } : {}),
      };
  return {
    hook_event_name: overrides.hook_event_name ?? 'PreToolUse',
    tool_name: overrides.tool_name ?? 'mcp__external-context__context_remember',
    permission_mode: overrides.permission_mode ?? 'default',
    tool_input: toolInput,
  };
}
