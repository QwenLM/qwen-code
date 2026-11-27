/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  buildTurnFailureResult,
  CUSTOM_MODEL_PROVIDER_CONFIG_WIRE,
  ModelInferenceError,
  type Config,
  type SDKMessage,
} from '@qwen-code/core';
import {
  buildStreamJsonInitMessage,
  buildSyntheticErrorResultMessage,
  writeHeadlessTextResult,
} from './nonInteractiveOutput.js';
import {
  createBestEffortNonInteractiveCommandService,
  createNonInteractiveCommandService,
} from '../nonInteractiveCliCommands.js';
import { buildResultError } from '../thread-manager/thread-session/query/queryProjection.js';

vi.mock('../nonInteractiveCliCommands.js', () => ({
  createBestEffortNonInteractiveCommandService: vi.fn(),
  createNonInteractiveCommandService: vi.fn(),
}));

function createConfig(): Config {
  return {
    getAgentRegistry: vi.fn(() => ({
      getAllAgentNames: vi.fn(() => []),
    })),
    getEnabledPlugins: vi.fn(() => []),
    getMcpClientManager: vi.fn(() => undefined),
    getModel: vi.fn(() => 'qwen-max'),
    getOutputStyle: vi.fn(() => undefined),
    getPermissionMode: vi.fn(() => 'default'),
    getSessionId: vi.fn(() => 'session-1'),
    getSkillManager: vi.fn(() => ({
      getSkills: vi.fn(() => []),
    })),
    getTargetDir: vi.fn(() => '/tmp'),
    getToolRegistry: vi.fn(() => ({
      getAllToolNames: vi.fn(() => []),
    })),
  } as unknown as Config;
}

describe('buildStreamJsonInitMessage', () => {
  beforeEach(() => {
    vi.mocked(createBestEffortNonInteractiveCommandService).mockReset();
    vi.mocked(createNonInteractiveCommandService).mockReset();
  });

  it('falls back to the best-effort command catalog when startup readiness fails', async () => {
    vi.mocked(createNonInteractiveCommandService).mockRejectedValue(
      new Error('Startup readiness gate "commands" failed: base boom'),
    );
    vi.mocked(createBestEffortNonInteractiveCommandService).mockResolvedValue({
      getCommands: vi.fn(() => [{ name: 'status' }]),
    } as unknown as Awaited<
      ReturnType<typeof createBestEffortNonInteractiveCommandService>
    >);

    const message = await buildStreamJsonInitMessage(createConfig());
    expect(message).not.toHaveProperty('qodercli_version');

    expect(createBestEffortNonInteractiveCommandService).toHaveBeenCalled();
    expect(message).toEqual(
      expect.objectContaining({
        capabilities: expect.arrayContaining([
          'interrupt_receipt_v1',
          'interrupt_cancel_queued_v1',
          'msg_lifecycle_v1',
          'session_rewind_v1',
          'background_tasks_v1',
          'side_question_v1',
          'custom_context_v1',
          'goal_v1',
          'goal_max_turns_v1',
          'goal_max_turns_unlimited_v1',
          'goal_resume_v1',
          'skill_evolution_v1',
          'plan_mode_v1',
          'session_store_fork_barrier_v1',
          CUSTOM_MODEL_PROVIDER_CONFIG_WIRE.capability.management,
          'selected_skills_v1',
        ]),
        slash_commands: ['status'],
        subtype: 'init',
        type: 'system',
      }),
    );
  });

  it('通用 init 不声明仅由 Daemon 支持的消息 ID 标题能力', async () => {
    vi.mocked(createNonInteractiveCommandService).mockResolvedValue({
      getCommands: () => [],
    } as unknown as Awaited<ReturnType<typeof createNonInteractiveCommandService>>);
    const message = await buildStreamJsonInitMessage(createConfig());
    expect(message).not.toHaveProperty('qodercli_version');
    expect(message).toMatchObject({ capabilities: expect.any(Array) });
    expect((message as { capabilities?: string[] }).capabilities)
      .not.toContain('title_source_message_v1');
  });

  it('preserves caller aborts while building protocol metadata', async () => {
    const controller = new AbortController();
    controller.abort();
    vi.mocked(createNonInteractiveCommandService).mockRejectedValue(
      Object.assign(new Error('aborted'), { name: 'AbortError' }),
    );

    await expect(
      buildStreamJsonInitMessage(createConfig(), controller.signal),
    ).rejects.toThrow('aborted');
    expect(createBestEffortNonInteractiveCommandService).not.toHaveBeenCalled();
  });
});

describe('writeHeadlessTextResult', () => {
  it.each(['quota_exhausted', 'auth'] as const)(
    'preserves HTTP 403/code 122 in SDK and -p when classified as %s',
    (kind) => {
      const previousExitCode = process.exitCode;
      const stdout = { write: vi.fn() } as unknown as NodeJS.WriteStream;
      const error = new ModelInferenceError('Provider HTTP 403 diagnostic', {
        kind,
        status: 403,
        code: '122',
        phase: 'before_output',
      });
      const frame = buildResultError(
        'error_during_execution',
        { error, errors: [error.message], durationMs: 1, numTurns: 1 },
        'session-1',
      ) as Extract<SDKMessage, { type: 'result' }>;

      expect(JSON.parse(JSON.stringify(frame))).toMatchObject({
        error_code: '122',
        errors: [error.message],
      });
      expect(frame).not.toHaveProperty('error_message');
      try {
        writeHeadlessTextResult(frame, stdout);
        expect(stdout.write).toHaveBeenCalledExactlyOnceWith(error.message);
        expect(process.exitCode).toBe(1);
      } finally {
        process.exitCode = previousExitCode;
      }
    },
  );

  it('prints the dynamic provider error and exits unsuccessfully', () => {
    const previousExitCode = process.exitCode;
    const stdout = { write: vi.fn() } as unknown as NodeJS.WriteStream;
    const message = {
      type: 'result',
      subtype: 'error_during_execution',
      is_error: true,
      errors: ['Dynamic 416 provider message'],
      error_code: 416,
    } as unknown as Extract<SDKMessage, { type: 'result' }>;

    try {
      writeHeadlessTextResult(message, stdout);

      expect(stdout.write).toHaveBeenCalledWith(
        'Dynamic 416 provider message',
      );
      expect(process.exitCode).toBe(1);
    } finally {
      process.exitCode = previousExitCode;
    }
  });

  it('prints the max-turn result error and exits unsuccessfully', () => {
    const previousExitCode = process.exitCode;
    const stdout = { write: vi.fn() } as unknown as NodeJS.WriteStream;
    const message = {
      type: 'result',
      subtype: 'error_max_turns',
      is_error: true,
      errors: ['Reached maximum number of turns (2)'],
      terminal_reason: 'max_turns',
    } as unknown as Extract<SDKMessage, { type: 'result' }>;

    try {
      writeHeadlessTextResult(message, stdout);

      expect(stdout.write).toHaveBeenCalledWith(
        'Reached maximum number of turns (2)',
      );
      expect(process.exitCode).toBe(1);
    } finally {
      process.exitCode = previousExitCode;
    }
  });

  it('prints the concrete turn failure instead of the Unknown error fallback', () => {
    const previousExitCode = process.exitCode;
    const stdout = { write: vi.fn() } as unknown as NodeJS.WriteStream;
    const error = Object.assign(
      new Error(
        "EPERM: operation not permitted, open 'C:\\tmp\\session.jsonl'",
      ),
      { code: 'EPERM' },
    );
    const message = buildTurnFailureResult(
      'session-1',
      error,
    ) as unknown as Extract<SDKMessage, { type: 'result' }>;

    try {
      writeHeadlessTextResult(message, stdout);

      expect(stdout.write).toHaveBeenCalledWith(error.message);
      expect(process.exitCode).toBe(1);
    } finally {
      process.exitCode = previousExitCode;
    }
  });
});

// Structured authentication errors must keep their identity after their public message is simplified.
describe('buildSyntheticErrorResultMessage', () => {
  it('preserves job_token_invalid with a general sign-in message', () => {
    const error = Object.assign(
      new Error('Internal authentication diagnostics'),
      {
        code: 'job_token_invalid',
        httpStatus: 401,
      },
    );
    expect(
      buildSyntheticErrorResultMessage(createConfig(), error),
    ).toMatchObject({
      type: 'result',
      is_error: true,
      error_code: 'job_token_invalid',
      result:
        'Unable to verify your sign-in status. Sign in again and try again.',
    });
  });
});
