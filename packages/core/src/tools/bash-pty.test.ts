/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';

const mockOpen = vi.hoisted(() => vi.fn());

vi.mock('../services/pty/ptySessionService.js', async (importOriginal) => {
  const actual =
    await importOriginal<
      typeof import('../services/pty/ptySessionService.js')
    >();
  return {
    ...actual,
    PtySessionService: {
      getInstance: () => ({
        open: mockOpen,
        findByPid: vi.fn(() => undefined),
        onDataByPid: vi.fn(),
        onExitByPid: vi.fn(),
        writeByPid: vi.fn(async () => ({})),
        closeByPid: vi.fn(async () => ({})),
      }),
    },
  };
});

import type { AgentLoopContext } from '../config/agent-loop-context.js';
import {
  PermissionModes,
  rulesForToolName,
  type PermissionRules,
  type ToolCheckContext,
} from '../permissions/manager/decision/index.js';
import type { PtySnapshotResult } from '../services/pty/ptySessionService.js';
import { ExecutionLifecycleService } from '../services/executionLifecycleService.js';
import { executeBashPtyCommand } from './bash-pty.js';
import { createBashInputToolChecker } from './tool-checkers/checkers/bash-pty-checkers.js';
import {
  alwaysAllowChecker,
  withToolLevelRules,
} from './tool-checkers/rule-precedence.js';
import type { ToolPermissionReason } from './tool-checkers/checker-reasons.js';
import {
  BASH_INPUT_TOOL_NAME,
  BASH_OUTPUT_TOOL_NAME,
  BASH_RESIZE_TOOL_NAME,
} from './tool-names.js';

function snapshot(overrides: Partial<PtySnapshotResult>): PtySnapshotResult {
  return {
    session_id: 'session-id',
    command: 'echo ok',
    cwd: '/tmp',
    pid: 123,
    alive: false,
    exit_code: 0,
    cols: 80,
    rows: 24,
    cursor: { x: 0, y: 0 },
    buffer_type: 'normal',
    screen: '',
    last_output_at: Date.now(),
    ...overrides,
  };
}

describe('executeBashPtyCommand exit status', () => {
  const ptyLastOutputs = new Map<number, string>();
  const context = {
    config: {
      getTargetDir: () => '/tmp',
      getPtyLastOutputs: () => ptyLastOutputs,
    },
  } as unknown as AgentLoopContext;

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('prefixes and propagates a failed PTY exit status', async () => {
    mockOpen.mockResolvedValue(
      snapshot({
        command: './missing-script.sh',
        exit_code: 127,
        screen: 'missing-script.sh: No such file or directory',
      }),
    );

    const result = await executeBashPtyCommand(
      context,
      { command: './missing-script.sh' },
      new AbortController().signal,
    );

    expect(result.llmContent).toMatch(/^Exit code 127\n\n/);
    expect(result.isError).toBe(true);
    expect(result.toolUseResult).toMatchObject({
      exit_code: 127,
      isError: true,
    });
  });

  it('carries customContext into the background PTY lifecycle', async () => {
    mockOpen.mockResolvedValue(
      snapshot({ command: 'sleep 30', alive: true, exit_code: undefined }),
    );
    const attachSpy = vi
      .spyOn(ExecutionLifecycleService, 'attachExecution')
      .mockReturnValue({
        pid: 123,
        result: new Promise(() => {}),
      });
    const backgroundSpy = vi
      .spyOn(ExecutionLifecycleService, 'background')
      .mockReturnValue(undefined);
    const customContext = Object.freeze({ tenant: 'alpha' });

    try {
      await executeBashPtyCommand(
        context,
        { command: 'sleep 30' },
        new AbortController().signal,
        {
          shellExecutionConfig: {
            customContext,
            sanitizationConfig: {
              allowedEnvironmentVariables: [],
              blockedEnvironmentVariables: [],
              enableEnvironmentVariableRedaction: false,
            },
          },
        },
      );

      expect(attachSpy).toHaveBeenCalledWith(
        123,
        expect.objectContaining({ customContext }),
      );
      expect(backgroundSpy).toHaveBeenCalledWith(123, 'model');
    } finally {
      attachSpy.mockRestore();
      backgroundSpy.mockRestore();
    }
  });

  it('keeps an expected exit code 1 as a successful PTY result', async () => {
    mockOpen.mockResolvedValue(
      snapshot({
        command: 'rg missing-pattern',
        exit_code: 1,
      }),
    );

    const result = await executeBashPtyCommand(
      context,
      { command: 'rg missing-pattern' },
      new AbortController().signal,
    );

    expect(result.isError).toBeUndefined();
    expect(result.llmContent).toContain('No matches found');
    expect(result.toolUseResult).toMatchObject({
      exit_code: 1,
      returnCodeInterpretation: 'No matches found',
    });
  });
});

/**
 * Tests for the Bash PTY companion tools' permission checks, now re-homed in
 * the checker registry (tools/tool-checkers/checker-registry.ts):
 *
 * - BashOutput — default allow stamped `bash_pty.output.allow`
 * - BashInput — gap-shaped ask the permission mode resolves (develop's
 *   passthrough); a tool-level allow rule fills it, deny still terminates.
 * - BashResize — default allow stamped `bash_pty.resize.allow`
 * - Rule regression: tool-level deny rules still beat the allows, because the
 *   rule stage runs inside each checker before its self-check.
 */

// ============================================================================
// Test Helpers
// ============================================================================

function checkContext(
  toolName: string,
  overrides: Partial<PermissionRules> = {},
): ToolCheckContext<ToolPermissionReason> {
  const rules: PermissionRules = { allow: {}, deny: {}, ask: {}, ...overrides };
  return {
    mode: PermissionModes.Default,
    rules,
    cwd: '/tmp',
    additionalDirectories: [],
    rulesForTool: rulesForToolName(rules, toolName),
    toolUseId: 'tu-test',
  };
}

const outputChecker = alwaysAllowChecker(
  BASH_OUTPUT_TOOL_NAME,
  'bash_pty.output.allow',
);
const resizeChecker = alwaysAllowChecker(
  BASH_RESIZE_TOOL_NAME,
  'bash_pty.resize.allow',
);
const inputChecker = createBashInputToolChecker(BASH_INPUT_TOOL_NAME);

// ============================================================================
// BashOutput — explicit allow
// ============================================================================

describe('BashOutputTool permission check', () => {
  it('explicitly allows output reads instead of the generic default', async () => {
    const result = await outputChecker.check(
      { pid: 1234 },
      checkContext(BASH_OUTPUT_TOOL_NAME),
    );

    expect(result.kind).toBe('allow');
    if (result.kind === 'allow') {
      // Not the generic `no_check.default.allow` — a stamped decision point.
      expect(result.extra?.decisionPoint).toBe('bash_pty.output.allow');
    }
  });
});

// ============================================================================
// BashInput — gap-shaped ask the permission mode resolves
// ============================================================================

describe('BashInputTool permission check', () => {
  it('leaves a gap-shaped ask for the permission mode to resolve', async () => {
    const result = await inputChecker.check(
      { pid: 1234, chars: 'ls -la', submit: true },
      checkContext(BASH_INPUT_TOOL_NAME),
    );

    expect(result.kind).toBe('ask');
    if (result.kind === 'ask') {
      expect(result.reason.decisionPoint).toBe('bash_pty.input.pass');
      expect(result.reason.attribution).toEqual(
        expect.objectContaining({ type: 'other' }),
      );
      expect(result.extra?.fillableByAllow).toBe(true);
    }
  });

  it('carries a non-empty message naming the action and the input summary', async () => {
    // The permission dialog renders only the message, so the message must say
    // what will happen and show what will be written to the PTY session.
    const result = await inputChecker.check(
      { pid: 1234, chars: 'ls -la', submit: true },
      checkContext(BASH_INPUT_TOOL_NAME),
    );

    expect(result.kind).toBe('ask');
    if (result.kind === 'ask') {
      expect(result.reason.message).not.toBe('');
      expect(result.reason.message).toContain('PTY');
      expect(result.reason.message).toContain('1234');
      expect(result.reason.message).toContain('ls -la');
      // submit=true renders the trailing carriage return as <Enter>.
      expect(result.reason.message).toContain('<Enter>');
    }
  });

  it('bounds the input summary for long payloads', async () => {
    const longChars = 'x'.repeat(500);
    const result = await inputChecker.check(
      { pid: 1234, chars: longChars },
      checkContext(BASH_INPUT_TOOL_NAME),
    );

    expect(result.kind).toBe('ask');
    if (result.kind === 'ask') {
      expect(result.reason.message).not.toContain(longChars);
      expect(result.reason.message.endsWith('...')).toBe(true);
    }
  });

  it('offers a tool-level allow suggestion — the gap is grantable', async () => {
    // Develop's passthrough makes BashInput ordinarily gated, so the prompt
    // offers to allow the tool from then on.
    const result = await inputChecker.check(
      { pid: 1234, chars: 'id' },
      checkContext(BASH_INPUT_TOOL_NAME),
    );

    expect(result.kind).toBe('ask');
    if (result.kind === 'ask') {
      expect(result.suggestions).toEqual([
        expect.objectContaining({ type: 'addRules', behavior: 'allow' }),
      ]);
    }
  });

  it('is filled by a tool-level allow rule', async () => {
    // The registry assembles every checker behind withToolLevelRules, which
    // fills a gap-shaped ask with a recorded allow.
    const assembled = withToolLevelRules(BASH_INPUT_TOOL_NAME, inputChecker);
    const result = await assembled.check(
      { pid: 1234, chars: 'id' },
      checkContext(BASH_INPUT_TOOL_NAME, {
        allow: { userSettings: [BASH_INPUT_TOOL_NAME] },
      }),
    );

    expect(result.kind).toBe('allow');
  });

  it('is terminated by a tool-level deny rule', async () => {
    const result = await inputChecker.check(
      { pid: 1234, chars: 'id' },
      checkContext(BASH_INPUT_TOOL_NAME, {
        deny: { userSettings: [BASH_INPUT_TOOL_NAME] },
      }),
    );

    expect(result.kind).toBe('deny');
  });

  it('honors a tool-level ask rule with the rule attribution', async () => {
    const result = await inputChecker.check(
      { pid: 1234, chars: 'id' },
      checkContext(BASH_INPUT_TOOL_NAME, {
        ask: { userSettings: [BASH_INPUT_TOOL_NAME] },
      }),
    );

    expect(result.kind).toBe('ask');
    if (result.kind === 'ask') {
      expect(result.reason.attribution).toEqual(
        expect.objectContaining({ type: 'rule' }),
      );
    }
  });
});

// ============================================================================
// BashResize — explicit allow
// ============================================================================

describe('BashResizeTool permission check', () => {
  it('explicitly allows resizing instead of the generic default', async () => {
    const result = await resizeChecker.check(
      { pid: 1234, cols: 120, rows: 40 },
      checkContext(BASH_RESIZE_TOOL_NAME),
    );

    expect(result.kind).toBe('allow');
    if (result.kind === 'allow') {
      expect(result.extra?.decisionPoint).toBe('bash_pty.resize.allow');
    }
  });
});

// ============================================================================
// Checker regression — tool-level deny rules beat the explicit allows
//
// Each checker applies the tool-level rules before its own verdict, and a rule
// deny is terminal. The stamped allows must not change that: a whole-tool deny
// rule still blocks BashOutput and BashResize.
// ============================================================================

describe('tool-level deny rules still govern the bash PTY tools', () => {
  it('a BashOutput deny rule wins over its stamped allow', async () => {
    const result = await outputChecker.check(
      { pid: 1234 },
      checkContext(BASH_OUTPUT_TOOL_NAME, {
        deny: { userSettings: [BASH_OUTPUT_TOOL_NAME] },
      }),
    );

    expect(result.kind).toBe('deny');
    if (result.kind === 'deny') {
      expect(result.extra?.denialReason?.attribution).toEqual(
        expect.objectContaining({
          type: 'rule',
          rule: expect.objectContaining({ ruleBehavior: 'deny' }),
        }),
      );
    }
  });

  it('a BashResize deny rule wins over its stamped allow', async () => {
    const result = await resizeChecker.check(
      { pid: 1234, cols: 120, rows: 40 },
      checkContext(BASH_RESIZE_TOOL_NAME, {
        deny: { userSettings: [BASH_RESIZE_TOOL_NAME] },
      }),
    );

    expect(result.kind).toBe('deny');
    if (result.kind === 'deny') {
      expect(result.extra?.denialReason?.attribution).toEqual(
        expect.objectContaining({
          type: 'rule',
          rule: expect.objectContaining({ ruleBehavior: 'deny' }),
        }),
      );
    }
  });
});
