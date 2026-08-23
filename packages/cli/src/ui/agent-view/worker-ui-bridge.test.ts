/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */
import { describe, it, expect, vi } from 'vitest';
import {
  ToolConfirmationOutcome,
  type WaitingToolCall,
} from '@qwen-code/qwen-code-core';
import { StreamingState } from '../types.js';
import {
  answerAgentViewPendingToolCall,
  applyAgentViewWorkerControlEventForUi,
  getAgentViewAnswerableToolCalls,
  getAgentViewWorkerStateForUi,
  getLastAgentViewModelOutputLine,
  retainAnsweredAgentViewSoftQuestion,
} from './worker-ui-bridge.js';

describe('getAgentViewWorkerStateForUi', () => {
  it('selects the newest non-empty model output line', () => {
    expect(
      getLastAgentViewModelOutputLine([
        { type: 'gemini', text: 'first response' },
        {
          type: 'gemini_content',
          text: 'opening line\n\nfinal question?',
        },
      ]),
    ).toBe('final question?');
  });

  it('maps responding state to working with the last model output', () => {
    expect(
      getAgentViewWorkerStateForUi({
        initError: null,
        streamingState: StreamingState.Responding,
        pendingToolCalls: [{ status: 'executing', request: { name: 'Bash' } }],
        lastResult: 'Running the requested test file.',
      }),
    ).toEqual({
      sessionState: 'working',
      lastResult: 'Running the requested test file.',
    });
  });

  it('maps confirmation waits to needs_input', () => {
    expect(
      getAgentViewWorkerStateForUi({
        initError: null,
        streamingState: StreamingState.WaitingForConfirmation,
        pendingToolCalls: [
          { status: 'awaiting_approval', request: { name: 'Edit' } },
        ],
      }),
    ).toEqual({
      sessionState: 'needs_input',
      waitingFor: 'Edit',
      inputKind: 'blocking',
    });
  });

  it('maps nested Agent confirmation waits to needs_input', () => {
    expect(
      getAgentViewWorkerStateForUi({
        initError: null,
        streamingState: StreamingState.WaitingForConfirmation,
        pendingToolCalls: [
          {
            status: 'executing',
            request: { name: 'Agent' },
            liveOutput: {
              type: 'task_execution',
              pendingConfirmation: { type: 'info' },
            },
          },
        ],
      }),
    ).toEqual({
      sessionState: 'needs_input',
      waitingFor: 'Agent',
      inputKind: 'blocking',
    });
  });

  it('maps idle and initialization failures', () => {
    expect(
      getAgentViewWorkerStateForUi({
        initError: null,
        streamingState: StreamingState.Idle,
        lastResult: 'Ready for the next step.',
      }),
    ).toEqual({
      sessionState: 'idle',
      lastResult: 'Ready for the next step.',
    });

    expect(
      getAgentViewWorkerStateForUi({
        initError: new Error('init failed'),
        streamingState: StreamingState.Idle,
      }),
    ).toEqual({
      sessionState: 'failed',
      summary: 'init failed',
    });
  });

  it('maps idle model questions to needs_input', () => {
    expect(
      getAgentViewWorkerStateForUi({
        initError: null,
        streamingState: StreamingState.Idle,
        lastResult:
          'What would you like to test? A specific file, the full suite, or something else?',
      }),
    ).toEqual({
      sessionState: 'needs_input',
      waitingFor: 'response',
      inputKind: 'soft',
      lastResult:
        'What would you like to test? A specific file, the full suite, or something else?',
    });
  });

  it('does not re-open an answered soft question without new model output', () => {
    const lastResult = 'What should I do next?';
    expect(
      getAgentViewWorkerStateForUi({
        initError: null,
        streamingState: StreamingState.Idle,
        lastResult,
        answeredSoftQuestion: lastResult,
      }),
    ).toEqual({ sessionState: 'idle', lastResult });
  });

  it('retains an answered soft question until model output changes', () => {
    const question = 'What should I do next?';

    expect(retainAnsweredAgentViewSoftQuestion(question, question)).toBe(
      question,
    );
    expect(
      retainAnsweredAgentViewSoftQuestion(question, 'Here is the result.'),
    ).toBeUndefined();
  });
});

describe('answerAgentViewPendingToolCall', () => {
  it('resolves a matching permission confirmation', async () => {
    const onConfirm = vi.fn(async () => {});
    const pendingCall = {
      status: 'awaiting_approval',
      request: { callId: 'call-1', name: 'Edit' },
      confirmationDetails: {
        type: 'info',
        title: 'Allow edit?',
        prompt: 'Allow edit?',
        onConfirm,
      },
    } as unknown as WaitingToolCall;

    await expect(
      answerAgentViewPendingToolCall(
        {
          type: 'answer',
          sequence: 1,
          callId: 'call-1',
          text: 'yes',
          at: '2026-07-17T00:00:00.000Z',
        },
        [pendingCall],
      ),
    ).resolves.toBe(true);

    expect(onConfirm).toHaveBeenCalledWith(ToolConfirmationOutcome.ProceedOnce);
  });

  it('passes text answers to AskUserQuestion confirmations', async () => {
    const onConfirm = vi.fn(async () => {});
    const pendingCall = {
      status: 'awaiting_approval',
      request: { callId: 'call-2', name: 'AskUserQuestion' },
      confirmationDetails: {
        type: 'ask_user_question',
        title: 'Choose',
        questions: [
          {
            question: 'Which path?',
            header: 'Path',
            options: [],
          },
        ],
        onConfirm,
      },
    } as unknown as WaitingToolCall;

    await expect(
      answerAgentViewPendingToolCall(
        {
          type: 'answer',
          sequence: 1,
          text: 'src/index.ts',
          at: '2026-07-17T00:00:00.000Z',
        },
        [pendingCall],
      ),
    ).resolves.toBe(true);

    expect(onConfirm).toHaveBeenCalledWith(
      ToolConfirmationOutcome.ProceedOnce,
      { answers: { 0: 'src/index.ts' } },
    );
  });

  it('applies a text answer to every question in a multi-question confirmation', async () => {
    const onConfirm = vi.fn(async () => {});
    const pendingCall = {
      status: 'awaiting_approval',
      request: { callId: 'call-multi', name: 'AskUserQuestion' },
      confirmationDetails: {
        type: 'ask_user_question',
        title: 'Choose',
        questions: [
          { question: 'Which path?', header: 'Path', options: [] },
          { question: 'Which mode?', header: 'Mode', options: [] },
        ],
        onConfirm,
      },
    } as unknown as WaitingToolCall;

    await expect(
      answerAgentViewPendingToolCall(
        {
          type: 'answer',
          sequence: 1,
          text: 'src/index.ts',
          at: '2026-07-17T00:00:00.000Z',
        },
        [pendingCall],
      ),
    ).resolves.toBe(true);

    expect(onConfirm).toHaveBeenCalledWith(
      ToolConfirmationOutcome.ProceedOnce,
      { answers: { 0: 'src/index.ts', 1: 'src/index.ts' } },
    );
  });

  it('maps negative text answers to cancel', async () => {
    const onConfirm = vi.fn(async () => {});
    const pendingCall = {
      status: 'awaiting_approval',
      request: { callId: 'call-3', name: 'Bash' },
      confirmationDetails: {
        type: 'exec',
        title: 'Run command?',
        prompt: 'Run command?',
        command: 'npm test',
        rootCommand: 'npm',
        onConfirm,
      },
    } as unknown as WaitingToolCall;

    await expect(
      answerAgentViewPendingToolCall(
        {
          type: 'answer',
          sequence: 1,
          text: 'no',
          at: '2026-07-17T00:00:00.000Z',
        },
        [pendingCall],
      ),
    ).resolves.toBe(true);

    expect(onConfirm).toHaveBeenCalledWith(ToolConfirmationOutcome.Cancel);
  });

  it('fails closed: only explicit affirmative words approve tool confirmations', async () => {
    for (const text of ['stop', "don't delete that", 'yes but wait']) {
      const onConfirm = vi.fn(async () => {});
      const pendingCall = {
        status: 'awaiting_approval',
        request: { callId: 'call-4', name: 'Bash' },
        confirmationDetails: {
          type: 'exec',
          title: 'Run command?',
          prompt: 'Run command?',
          command: 'rm -rf build',
          rootCommand: 'rm',
          onConfirm,
        },
      } as unknown as WaitingToolCall;

      await expect(
        answerAgentViewPendingToolCall(
          {
            type: 'answer',
            sequence: 1,
            text,
            at: '2026-07-17T00:00:00.000Z',
          },
          [pendingCall],
        ),
      ).resolves.toBe(true);

      expect(onConfirm).toHaveBeenCalledWith(ToolConfirmationOutcome.Cancel);
    }
  });

  it('answers nested Agent pending confirmations', async () => {
    const onConfirm = vi.fn(async () => {});
    const answerable = getAgentViewAnswerableToolCalls([
      {
        status: 'executing',
        request: { callId: 'agent-call', name: 'Agent' },
        liveOutput: {
          type: 'task_execution',
          pendingConfirmation: {
            type: 'info',
            title: 'Allow nested action?',
            prompt: 'Allow nested action?',
            onConfirm,
          },
        },
      },
    ]);

    await expect(
      answerAgentViewPendingToolCall(
        {
          type: 'answer',
          sequence: 1,
          text: 'yes',
          at: '2026-07-17T00:00:00.000Z',
        },
        answerable,
      ),
    ).resolves.toBe(true);

    expect(onConfirm).toHaveBeenCalledWith(ToolConfirmationOutcome.ProceedOnce);
  });

  it('routes callId-less answers to the displayed awaiting call, not a nested one', async () => {
    const nestedOnConfirm = vi.fn(async () => {});
    const editOnConfirm = vi.fn(async () => {});
    const answerable = getAgentViewAnswerableToolCalls([
      {
        status: 'executing',
        request: { callId: 'agent-call', name: 'Agent' },
        liveOutput: {
          type: 'task_execution',
          pendingConfirmation: {
            type: 'info',
            title: 'Allow nested action?',
            prompt: 'Allow nested action?',
            onConfirm: nestedOnConfirm,
          },
        },
      },
      {
        status: 'awaiting_approval',
        request: { callId: 'edit-call', name: 'Edit' },
        confirmationDetails: {
          type: 'info',
          title: 'Allow edit?',
          prompt: 'Allow edit?',
          onConfirm: editOnConfirm,
        },
      },
    ]);

    await expect(
      answerAgentViewPendingToolCall(
        {
          type: 'answer',
          sequence: 1,
          text: 'yes',
          at: '2026-07-17T00:00:00.000Z',
        },
        answerable,
      ),
    ).resolves.toBe(true);

    expect(editOnConfirm).toHaveBeenCalledWith(
      ToolConfirmationOutcome.ProceedOnce,
    );
    expect(nestedOnConfirm).not.toHaveBeenCalled();
  });

  it('delivers negative answers to AskUserQuestion instead of refusing', async () => {
    const onConfirm = vi.fn(async () => {});
    const pendingCall = {
      status: 'awaiting_approval',
      request: { callId: 'call-q', name: 'AskUserQuestion' },
      confirmationDetails: {
        type: 'ask_user_question',
        title: 'Choose',
        questions: [
          {
            question: 'Proceed?',
            header: 'Proceed',
            options: [],
          },
        ],
        onConfirm,
      },
    } as unknown as WaitingToolCall;

    await expect(
      answerAgentViewPendingToolCall(
        {
          type: 'answer',
          sequence: 1,
          text: 'no',
          at: '2026-07-17T00:00:00.000Z',
        },
        [pendingCall],
      ),
    ).resolves.toBe(true);

    expect(onConfirm).toHaveBeenCalledWith(
      ToolConfirmationOutcome.ProceedOnce,
      { answers: { 0: 'no' } },
    );
  });
});

describe('applyAgentViewWorkerControlEventForUi', () => {
  it('drops stale answers when no approval is pending', async () => {
    const enqueuePrompt = vi.fn();

    await applyAgentViewWorkerControlEventForUi(
      {
        type: 'answer',
        sequence: 1,
        text: 'run the focused test',
        at: '2026-07-17T00:00:00.000Z',
      },
      [],
      enqueuePrompt,
    );

    expect(enqueuePrompt).not.toHaveBeenCalled();
  });

  it('does not queue approval answers as prompts', async () => {
    const onConfirm = vi.fn(async () => {});
    const enqueuePrompt = vi.fn();
    const pendingCall = {
      status: 'awaiting_approval',
      request: { callId: 'call-1', name: 'Edit' },
      confirmationDetails: {
        type: 'info',
        title: 'Allow edit?',
        prompt: 'Allow edit?',
        onConfirm,
      },
    } as unknown as WaitingToolCall;

    await applyAgentViewWorkerControlEventForUi(
      {
        type: 'answer',
        sequence: 1,
        callId: 'call-1',
        text: 'yes',
        at: '2026-07-17T00:00:00.000Z',
      },
      [pendingCall],
      enqueuePrompt,
    );

    expect(onConfirm).toHaveBeenCalledWith(ToolConfirmationOutcome.ProceedOnce);
    expect(enqueuePrompt).not.toHaveBeenCalled();
  });
});
