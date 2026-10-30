/**
 * @license
 * Copyright 2026 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Live-turn regression tests (R2): the prompt reaches the client as a full
 * PartListUnion (multimodal included) and the per-turn modelOverride travels
 * through SendMessageOptions. Plus the two hops Batch 8 added: text drained at
 * a tool boundary is resolved like an idle submission (`@path` expansion under
 * a read deadline, with a queue restore when the turn dies mid-read), and an
 * image reaching the model goes through the prompt-side vision bridge.
 */

import { makeFakeConfig } from '@qwen-code/qwen-code-core/test-utils/config.js';
import { Config } from '@qwen-code/qwen-code-core/config/config.js';
import { Storage } from '@qwen-code/qwen-code-core/config/storage.js';
import { LlmClient } from '@qwen-code/qwen-code-core/core/client.js';
import { LlmChat } from '@qwen-code/qwen-code-core/core/llm-chat.js';
import { createRestoreToolResponseBinding } from '../utils/restore-tool-response.js';
import { buildResumedHistoryItems } from '../utils/resumeHistoryUtils.js';
import { beforeEach, describe, it, expect, vi } from 'vitest';
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import {
  foldLiveEvent,
  snapshotCanonicalHistory,
  type LiveHistoryItem,
} from './live-session-model.js';

import {
  ApprovalMode,
  CoreToolScheduler,
  LlmEventType,
  MockTool,
  getUnsupportedImageFormatWarning,
  SendMessageType,
} from '@qwen-code/qwen-code-core';
import type {
  ServerLlmStreamEvent,
  SendMessageOptions,
  ToolCallConfirmationDetails,
  VisionBridgeModelSelection,
} from '@qwen-code/qwen-code-core';
import {
  ensureConfigInitialized,
  livePromptEvents,
  nextApprovalMode,
  nextLivePromptId,
  resetPromptCountForTesting,
  selectAutoApprovals,
  STARTUP_CHAT_WAIT_MS,
  type OpenTuiSteeringSubmission,
  type WaitingCallInfo,
} from './live-session.js';
import type { ChatRecordingService } from '@qwen-code/qwen-code-core/services/chatRecordingService.js';
import type { ToolCallRequestInfo } from '@qwen-code/qwen-code-core/core/turn.js';
import { goalToolResultProvenance } from '@qwen-code/qwen-code-core/goals/goal-tool-result-provenance.js';
import type { OpenTuiStreamEvent } from './event-adapter.js';
import type { HandleAtCommandResult } from '../hooks/atCommandProcessor.js';
import { ToolCallStatus, type IndividualToolCallDisplay } from '../types.js';

function steering(...texts: string[]): OpenTuiSteeringSubmission[] {
  return texts.map((text) => ({ text, content: text }));
}

// `runVisionBridge` is the one bridge collaborator that would reach a real
// provider, so it is recorded here; every other core export (including the
// bridge's gates and formatters) stays real.
const visionMocks = vi.hoisted(() => ({
  run: vi.fn(),
}));

const modMocks = vi.hoisted(() => ({ get: vi.fn() }));
const checkpointControl = vi.hoisted(() => ({
  held: false,
  release: null as (() => void) | null,
  update: null as
    | ((phase: 'resolved' | 'reentered' | 'repeated') => void)
    | null,
  afterWrite: null as (() => Promise<void>) | null,
  afterMkdir: null as (() => Promise<void>) | null,
}));
vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>();
  return {
    ...actual,
    mkdir: async (...args: Parameters<typeof actual.mkdir>) => {
      const result = await actual.mkdir(...args);
      await checkpointControl.afterMkdir?.();
      return result;
    },
    writeFile: async (...args: Parameters<typeof actual.writeFile>) => {
      await actual.writeFile(...args);
      await checkpointControl.afterWrite?.();
    },
  };
});
const schedulerControl = vi.hoisted(() => ({
  finish: null as (() => Promise<void>) | null,
}));
vi.mock('../../services/interactive-mod-session.js', () => ({
  getInteractiveModSession: modMocks.get,
}));

// The round-trip tests also replace the tool scheduler with a stub that
// completes the pending calls immediately.
vi.mock('@qwen-code/qwen-code-core', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('@qwen-code/qwen-code-core')>();
  return {
    ...actual,
    runVisionBridge: (params: unknown) => visionMocks.run(params),
    CoreToolScheduler: class FakeScheduler {
      private readonly opts: {
        onAllToolCallsComplete: (calls: unknown[]) => unknown;
        onToolCallsUpdate?: (calls: unknown[]) => unknown;
        outputUpdateHandler?: (callId: string, chunk: unknown) => unknown;
      };
      constructor(opts: {
        onAllToolCallsComplete: (calls: unknown[]) => unknown;
        onToolCallsUpdate?: (calls: unknown[]) => unknown;
        outputUpdateHandler?: (callId: string, chunk: unknown) => unknown;
      }) {
        this.opts = opts;
      }
      async schedule(
        calls: Array<{ callId: string; name?: string; args?: unknown }>,
      ): Promise<void> {
        if (
          calls.some(
            (call) => (call.args as { __foreground?: boolean })?.__foreground,
          )
        ) {
          await this.opts.onToolCallsUpdate?.(
            calls.map((request) => ({ status: 'scheduled', request })),
          );
          await this.opts.onToolCallsUpdate?.(
            calls.map((request, index) => ({
              status: 'executing',
              request,
              pid: 4300 + index,
              promoteAbortController: new AbortController(),
            })),
          );
          await this.opts.onToolCallsUpdate?.(
            calls.map((request) => ({ status: 'success', request })),
          );
        } else if (checkpointControl.held) {
          const waiting = () =>
            calls.map((request) => ({
              status: 'awaiting_approval',
              request,
              confirmationDetails: {
                type: 'info',
                title: 'Edit a',
                onConfirm: async () => {},
              },
            }));
          const publish = () => this.opts.onToolCallsUpdate?.(waiting());
          checkpointControl.update = (phase) => {
            if (phase === 'repeated') {
              publish();
              return;
            }
            this.opts.onToolCallsUpdate?.(
              calls.map((request) => ({ status: 'scheduled', request })),
            );
            if (phase === 'reentered') publish();
          };
          const released = new Promise<void>((resolve) => {
            checkpointControl.release = resolve;
          });
          publish();
          await released;
          this.opts.onToolCallsUpdate?.(
            calls.map((request) => ({ status: 'scheduled', request })),
          );
          await this.opts.onAllToolCallsComplete(
            calls.map((request) => ({
              status: 'success',
              request,
              response: {
                resultDisplay: 'done',
                responseParts: [
                  {
                    functionResponse: {
                      name: request.name,
                      id: request.callId,
                      response: { ok: true },
                    },
                  },
                ],
              },
            })),
          );
          return;
        }
        const failure = calls.find(
          (c) => (c.args as { __scheduleFailure?: string })?.__scheduleFailure,
        )?.args as { __scheduleFailure: string } | undefined;
        if (failure) {
          this.opts.onToolCallsUpdate?.(
            calls.map((request) => ({ status: 'scheduled', request })),
          );
          if (failure.__scheduleFailure === 'cancelled')
            throw new DOMException('Mod generation revoked', 'AbortError');
          throw new Error('Scheduler failed');
        }
        if (
          calls.some((c) => (c.args as { __deferred?: boolean })?.__deferred)
        ) {
          schedulerControl.finish = () =>
            this.schedule(calls.map((c) => ({ ...c, args: {} })));
          return;
        }
        const bounce = calls.some(
          (c) =>
            (c.args as { __bounceApproval?: boolean } | undefined)
              ?.__bounceApproval,
        );
        if (bounce) {
          // PreToolUse 'ask' bounce shape: awaiting → executing → back to
          // awaiting_approval under the same callId with fresh details.
          const waiting = (title: string) =>
            calls.map((c) => ({
              status: 'awaiting_approval',
              request: c,
              confirmationDetails: {
                type: 'ask_user_question',
                title,
                questions: [],
                onConfirm: async () => {},
              },
            }));
          const executing = calls.map((c) => ({
            status: 'executing',
            request: c,
          }));
          await this.opts.onToolCallsUpdate?.(waiting('original'));
          await this.opts.onToolCallsUpdate?.(executing);
          await this.opts.onToolCallsUpdate?.(
            waiting('Hook requested confirmation to run'),
          );
        } else if (
          calls.some(
            (c) =>
              (c.args as { __queuedApproval?: boolean } | undefined)
                ?.__queuedApproval,
          )
        ) {
          // Two-call batch where approving the first does not start it: the
          // scheduler holds it in 'scheduled' until the sibling's approval
          // lands, and only then moves it to 'executing'.
          const awaiting = calls.map((c) => ({
            status: 'awaiting_approval',
            request: c,
            confirmationDetails: {
              type: 'info',
              title: 'original',
              onConfirm: async () => {},
            },
          }));
          const firstMoved = (status: string) =>
            calls.map((c, i) =>
              i === 0 ? { status, request: c } : awaiting[i],
            );
          await this.opts.onToolCallsUpdate?.(awaiting);
          await this.opts.onToolCallsUpdate?.(firstMoved('scheduled'));
          await this.opts.onToolCallsUpdate?.(firstMoved('executing'));
        } else if (
          calls.some(
            (c) =>
              (c.args as { __cancelApproval?: boolean } | undefined)
                ?.__cancelApproval,
          )
        ) {
          // No/Esc outcome shape: the scheduler cancels the call, so it
          // leaves awaiting_approval with status 'cancelled'.
          const cancelled = calls.map((c) => ({
            status: 'cancelled',
            request: c,
          }));
          await this.opts.onToolCallsUpdate?.(
            calls.map((c) => ({
              status: 'awaiting_approval',
              request: c,
              confirmationDetails: {
                type: 'info',
                title: 'original',
                onConfirm: async () => {},
              },
            })),
          );
          await this.opts.onToolCallsUpdate?.(cancelled);
        } else {
          // Emit one awaiting_approval update per call (twice, to prove the
          // live-session dedupe). A call with `__invocationDesc` args also
          // carries a scheduler-style invocation whose getDescription feeds
          // the tool-description event (R1-104).
          for (let i = 0; i < 2; i++) {
            await this.opts.onToolCallsUpdate?.(
              calls.map((c) => {
                const { __invocationDesc: desc, __resolvedName: resolvedName } =
                  (c.args ?? {}) as {
                    __invocationDesc?: string;
                    __resolvedName?: string;
                  };
                return {
                  status: 'awaiting_approval',
                  request: resolvedName
                    ? {
                        ...c,
                        name: resolvedName,
                        modelFacingName: c.name,
                      }
                    : c,
                  ...(resolvedName
                    ? {
                        tool: {
                          name: resolvedName,
                          displayName: 'Advisor',
                        },
                      }
                    : {}),
                  ...(desc
                    ? { invocation: { getDescription: () => desc } }
                    : {}),
                  confirmationDetails: {
                    type: 'ask_user_question',
                    title: '',
                    questions: [],
                    onConfirm: async () => {},
                  },
                };
              }),
            );
          }
        }
        // Live output bridge: one chunk per call before completion (the
        // shape is chosen by the individual tests via the call args).
        for (const c of calls) {
          const chunks = ((c.args ?? {}) as { __liveChunks?: unknown[] })
            .__liveChunks ?? ['live output\n'];
          for (const chunk of chunks) {
            this.opts.outputUpdateHandler?.(c.callId, chunk);
          }
        }
        await this.opts.onAllToolCallsComplete(
          calls.map((c) => {
            const a = (c.args ?? {}) as {
              __cancelled?: boolean;
              __cancelApproval?: boolean;
              __modOutput?: string;
              __restoreResult?: Record<string, unknown>;
              __rewritten?: boolean;
            };
            return {
              nativeAttemptsObserved: a.__modOutput !== undefined,
              request: {
                ...c,
                callId: c.callId,
                name: c.name ?? 'test_tool',
                args: a.__rewritten
                  ? { ...a, modified_by_user: true }
                  : (c.args ?? {}),
              },
              // A No/Esc cancellation leaves the scheduler with a cancelled
              // call — the send loop must see it as terminal to stop.
              status:
                a.__cancelled === true || a.__cancelApproval === true
                  ? 'cancelled'
                  : 'success',
              response: {
                responseParts: [
                  {
                    functionResponse: {
                      name: c.name ?? 'test_tool',
                      id: c.callId,
                      response:
                        a.__restoreResult ??
                        (a.__modOutput !== undefined
                          ? { output: a.__modOutput }
                          : { ok: true }),
                    },
                  },
                ],
                resultDisplay: 'done',
                persistedOutputFiles:
                  a.__modOutput !== undefined ? [] : undefined,
                executionStatus:
                  a.__modOutput !== undefined ? 'not_started' : undefined,
              },
            };
          }),
        );
        if (
          calls.some(
            (call) => (call.args as { __foreground?: boolean })?.__foreground,
          )
        ) {
          await this.opts.onToolCallsUpdate?.(
            calls.map((request) => ({
              status: 'executing',
              request,
              pid: 9999,
            })),
          );
        }
      }
    },
  };
});

// The `@`-mention expander reads files through Config; record the queries it
// receives and answer with the configured result. live-session owns the
// expansion (ink expands in processQuery / resolveSteeredMessages, never at the
// composer), so this is where the behaviour is pinned.
const atMocks = vi.hoisted(() => ({
  calls: [] as string[],
  result: {
    processedQuery: null,
    shouldProceed: true,
  } as HandleAtCommandResult,
  /**
   * Set to hang the expander forever — a read that ignores its signal. The hook
   * runs first, so a test can abort the turn from inside the read.
   */
  hang: null as (() => void) | null,
  /**
   * Set to abort the turn inside the read but still resolve it. Queued two
   * microtasks deep so the abort lands after the race has delivered the read's
   * result but before the steering hop returns — the "hop resolved cleanly,
   * abort right behind it" window.
   */
  abortAfter: null as (() => void) | null,
}));

vi.mock('../../services/interactive-mod-tool-scheduler.js', async () => {
  const core = await import('@qwen-code/qwen-code-core');
  return { InteractiveModToolScheduler: core.CoreToolScheduler };
});

vi.mock('../hooks/atCommandProcessor.js', () => ({
  handleAtCommand: async ({ query }: { query: string }) => {
    atMocks.calls.push(query);
    if (atMocks.hang) {
      atMocks.hang();
      return new Promise<HandleAtCommandResult>(() => {});
    }
    if (atMocks.abortAfter) {
      queueMicrotask(() => queueMicrotask(atMocks.abortAfter!));
    }
    return atMocks.result;
  },
}));

function createFakeConfig(
  sendMessageStream: (...args: unknown[]) => unknown,
  bridgeModel?: VisionBridgeModelSelection,
  isInitialized: () => boolean = () => true,
  recorder?: {
    recordMidTurnUserMessage: (...args: unknown[]) => void;
    recordToolResult?: ChatRecordingService['recordToolResult'];
  },
) {
  const chatRecorder = recorder
    ? { recordToolResult: vi.fn(), ...recorder }
    : undefined;
  // One stable client object: tests spy on its addHistory through
  // getGeminiClient() (R5-4/R6-5).
  const client = {
    sendMessageStream,
    isInitialized,
    // R5-4/R6-5: an abort at the sampling boundary still writes the
    // completed batch's function responses to history before returning.
    addHistory: vi.fn(async () => {}),
    // A chat the startup flight has already completed: `setTools()` ran, so
    // its declarations are in the generation config the send reads.
    getChat: () => ({
      getGenerationConfig: () => ({ tools: [{ functionDeclarations: [] }] }),
    }),
  };
  return {
    initialize: vi.fn(async () => {}),
    getGeminiClient: () => client,
    getSessionId: () => 'session-1',
    getModel: () => 'test-model',
    getMaxSessionTurns: () => 10,
    getContentGeneratorConfig: () => ({ authType: 'qwen-oauth' }),
    // Pinning a bridge model is what turns `shouldRunVisionBridge` on; every
    // other test leaves it undefined and the prompt rides through untouched.
    getDefaultVisionBridgeModel: () => bridgeModel,
    getChatRecordingService: () => chatRecorder,
    getDebugLogger: () => ({
      debug: () => {},
      warn: () => {},
      error: () => {},
    }),
  } as unknown as Config;
}

/** One tool batch on call 1, plain finish on the continuation call. */
function oneToolBatchStream(request: {
  goalContext?: ToolCallRequestInfo['goalContext'];
  callId: string;
  name: string;
  args?: unknown;
}) {
  let calls = 0;
  return vi.fn(function* (...args: unknown[]): Generator<{
    type: string;
    value?: unknown;
  }> {
    calls += 1;
    if (calls === 1) {
      yield { type: 'tool_call_request', value: request };
      return;
    }
    (args[3] as SendMessageOptions | undefined)?.steerInput?.accept();
    yield { type: 'finished', value: {} };
  });
}

async function drain<T>(gen: AsyncGenerator<T>): Promise<T[]> {
  const events = [];
  for await (const ev of gen) events.push(ev);
  return events;
}

describe('livePromptEvents', () => {
  it('records a native model result once using the same finalized response sent to the model', async () => {
    const request = { callId: 'native-recorded', name: 'read_file', args: {} };
    const stream = oneToolBatchStream(request);
    const recordToolResult = vi.fn();
    const config = createFakeConfig(stream, undefined, () => true, {
      recordMidTurnUserMessage: vi.fn(),
      recordToolResult,
    } as Parameters<typeof createFakeConfig>[3]);
    await drain(livePromptEvents(config, 'read', new AbortController().signal));
    expect(stream).toHaveBeenCalledTimes(2);
    expect(recordToolResult).toHaveBeenCalledOnce();
    const [parts, metadata] = recordToolResult.mock.calls[0];
    expect(parts).toEqual(stream.mock.calls[1][0]);
    expect(metadata.callId).toBe(request.callId);
    expect(metadata.status).toBe('success');
    expect(parts).toEqual([
      {
        functionResponse: {
          id: request.callId,
          name: request.name,
          response: { ok: true },
        },
      },
    ]);
  });

  it.each(['turn', 'session'] as const)(
    'does not record an old model result after the %s changes while rendering completion',
    async (scope) => {
      const stream = oneToolBatchStream({
        callId: 'old-owner-result',
        name: 'read_file',
        args: {},
      });
      const recordToolResult = vi.fn();
      const config = createFakeConfig(stream, undefined, () => true, {
        recordMidTurnUserMessage: vi.fn(),
        recordToolResult,
      } as Parameters<typeof createFakeConfig>[3]);
      let current = true;
      let sessionId = 'session-1';
      Object.assign(config, { getSessionId: () => sessionId });
      let invalidated = false;
      for await (const event of livePromptEvents(config, 'read', undefined, {
        isCurrentTurn: () => current,
      })) {
        if (event.type === 'tool-end' && event.id === 'old-owner-result') {
          invalidated = true;
          if (scope === 'turn') current = false;
          else sessionId = 'session-2';
        }
      }
      expect(invalidated).toBe(true);
      expect(recordToolResult).not.toHaveBeenCalled();
    },
  );

  it.each(['read_file', 'get_goal'])(
    'retains real Goal provenance options for native %s result',
    async (name) => {
      const permit = {
        goalId: 'goal-native',
        revision: 2,
        turnId: 'turn-native',
      };
      const request = {
        callId: 'goal-call',
        name,
        args: {},
        goalContext: permit,
      };
      const stream = oneToolBatchStream(request);
      const recordToolResult = vi.fn();
      const config = createFakeConfig(stream, undefined, () => true, {
        recordMidTurnUserMessage: vi.fn(),
        recordToolResult,
      });
      await drain(livePromptEvents(config, 'go', new AbortController().signal));
      expect(recordToolResult).toHaveBeenCalledOnce();
      const [parts, metadata, options] = recordToolResult.mock.calls[0];
      expect(parts).toEqual(stream.mock.calls[1][0]);
      expect(metadata).toMatchObject({
        callId: request.callId,
        status: 'success',
      });
      expect(options).toEqual(goalToolResultProvenance(request, parts));
      expect(options).toEqual(
        name === 'get_goal'
          ? { goalContext: permit, provenance: 'goal_runtime' }
          : { goalContext: permit },
      );
      expect(options.goalContext).not.toBe(permit);
    },
  );
  it.each([
    { type: LlmEventType.Retry },
    {
      type: LlmEventType.ModelFallback,
      fromModel: 'primary-model',
      toModel: 'fallback-model',
      fallbackIndex: 1,
    },
  ] satisfies ServerLlmStreamEvent[])(
    'executes only fresh tools after $type discards a failed attempt',
    async (boundary) => {
      const oldRequest: ToolCallRequestInfo = {
        callId: 'discarded-attempt-tool',
        name: 'test_tool',
        args: { attempt: 'discarded' },
        isClientInitiated: false,
        prompt_id: 'same-prompt',
      };
      const freshRequest: ToolCallRequestInfo = {
        ...oldRequest,
        callId: 'fresh-attempt-tool',
        args: { attempt: 'fresh' },
      };
      let sends = 0;
      const sendMessageStream = vi.fn(
        function* (): Generator<ServerLlmStreamEvent> {
          sends += 1;
          if (sends === 1) {
            yield { type: LlmEventType.ToolCallRequest, value: oldRequest };
            yield boundary;
            yield { type: LlmEventType.ToolCallRequest, value: freshRequest };
          }
        },
      );
      const schedule = vi.spyOn(CoreToolScheduler.prototype, 'schedule');
      try {
        await drain(livePromptEvents(createFakeConfig(sendMessageStream), 'q'));

        expect(schedule).toHaveBeenCalledExactlyOnceWith(
          [freshRequest],
          expect.any(AbortSignal),
        );
        expect(sendMessageStream).toHaveBeenCalledTimes(2);
        expect(sendMessageStream.mock.calls[1]).toEqual([
          [
            {
              functionResponse: {
                name: freshRequest.name,
                id: freshRequest.callId,
                response: { ok: true },
              },
            },
          ],
          expect.any(AbortSignal),
          expect.any(String),
          { type: SendMessageType.ToolResult },
        ]);
      } finally {
        schedule.mockRestore();
      }
    },
  );

  it('explicit Retry reuses prepared parts without rereading mentions or rebridging media', async () => {
    const sendMessageStream = vi.fn(function* () {
      yield { type: 'finished', value: {} };
    });
    const config = createFakeConfig(sendMessageStream);
    const content = [{ text: '@owned.txt already expanded' }, imagePart];
    await drain(
      livePromptEvents(config, 'unused draft', undefined, {
        promptId: 'same-id',
        submittedPrompt: '@owned.txt',
        humanInput: { text: 'original' },
        workflowModeEligible: true,
        retry: {
          content,
          modelOverride: 'skill-model',
          inlineModelOverride: false,
        },
      }),
    );
    expect(sendMessageStream).toHaveBeenCalledExactlyOnceWith(
      content,
      expect.any(AbortSignal),
      'same-id',
      { type: SendMessageType.Retry, modelOverride: 'skill-model' },
    );
    expect(atMocks.calls).toHaveLength(0);
    expect(visionMocks.run).not.toHaveBeenCalled();
  });

  /** A `@path` read as the expander reports it (ink's tool_group entry). */
  const readDisplay = (
    overrides: Partial<IndividualToolCallDisplay> = {},
  ): IndividualToolCallDisplay => ({
    callId: 'client-read-1',
    name: 'Read File(s)',
    description: 'src/a.ts',
    resultDisplay: 'FILE BODY',
    status: ToolCallStatus.Success,
    confirmationDetails: undefined,
    ...overrides,
  });

  function expectMentionCanonicalSource(events: readonly OpenTuiStreamEvent[]) {
    const cards = events.filter(
      (event) => 'id' in event && event.id === 'client-read-1',
    );
    expect(cards).toHaveLength(3);
    const source = cards[0].canonicalHistoryItem;
    expect(source).toEqual({
      id: expect.any(Number),
      type: 'tool_group',
      tools: atMocks.result.toolDisplays,
    });
    expect(source!.id).toBeLessThan(0);
    for (const event of cards) {
      expect(event.historyId).toBe(source!.id);
      expect(event.canonicalHistoryItem).toBe(source);
    }
    return { historyId: source!.id, canonicalHistoryItem: source! };
  }

  /** An attached image, as the composer hands it to the stream. */
  const imagePart = {
    inlineData: { mimeType: 'image/png', data: 'aW1hZ2U=' },
  };

  beforeEach(() => {
    resetPromptCountForTesting();
    atMocks.calls.length = 0;
    atMocks.result = { processedQuery: null, shouldProceed: true };
    atMocks.hang = null;
    atMocks.abortAfter = null;
    visionMocks.run.mockReset();
    modMocks.get.mockReset();
    schedulerControl.finish = null;
    checkpointControl.held = false;
    checkpointControl.release = null;
    checkpointControl.update = null;
    checkpointControl.afterWrite = null;
    checkpointControl.afterMkdir = null;
  });

  it('seeds prompt ids past claims in the resumed transcript', () => {
    const messages = [0, 1, 2].map((turn) => ({
      type: 'user' as const,
      sessionId: 'session-1',
      promptId: `session-1########${turn}`,
      message: { parts: [{ text: `prompt ${turn}` }] },
    }));
    const config = {
      getSessionId: () => 'session-1',
      getResumedSessionData: () => ({ conversation: { messages } }),
    } as unknown as Config;

    expect(nextLivePromptId(config)).toBe('session-1########3');
  });

  it('records and restores only the finalized synthetic read response under a small batch budget', async () => {
    const output = 'RAW-MOD-RESULT:'.repeat(2000);
    const request = {
      callId: 'synthetic-read',
      name: 'read_file',
      args: { __modOutput: output },
    };
    const stream = oneToolBatchStream(request);
    const recordToolResult = vi.fn();
    const config = createFakeConfig(stream, undefined, () => true, {
      recordMidTurnUserMessage: vi.fn(),
      recordToolResult,
    } as Parameters<typeof createFakeConfig>[3]);
    Object.assign(config, { getToolOutputBatchBudget: () => 1000 });
    await drain(livePromptEvents(config, 'read', new AbortController().signal));
    expect(recordToolResult).toHaveBeenCalledOnce();
    const [parts, metadata] = recordToolResult.mock.calls[0];
    expect(metadata.responseParts).toBeUndefined();
    expect(metadata.executionStatus).toBe('not_started');
    expect(JSON.stringify(parts)).not.toContain(output);
    expect(JSON.stringify(parts).length).toBeLessThan(1500);
    expect(stream.mock.calls[1][0]).toEqual(parts);
    const restored = buildResumedHistoryItems(
      {
        conversation: {
          messages: [
            {
              type: 'assistant',
              timestamp: new Date().toISOString(),
              message: {
                parts: [
                  {
                    functionCall: {
                      id: request.callId,
                      name: request.name,
                      args: {},
                    },
                  },
                ],
              },
            },
            {
              type: 'tool_result',
              toolCallResult: metadata,
              message: { parts },
            },
          ],
        },
      } as unknown as import('@qwen-code/qwen-code-core').ResumedSessionData,
      {
        getToolRegistry: () => ({
          getTool: () =>
            new MockTool({ name: 'read_file', displayName: 'Read File' }),
        }),
      } as unknown as Config,
    );
    const group = restored.find((item) => item.type === 'tool_group');
    expect(group?.type).toBe('tool_group');
    if (group?.type !== 'tool_group') throw new Error('missing restored read');
    expect(group.tools[0].detailedDisplay).toBeDefined();
    expect(group.tools[0].detailedDisplay?.length).toBeLessThan(1500);
    expect(group.tools[0].detailedDisplay).not.toContain(output);
  });

  it('forwards string prompts as an explicit UserQuery send', async () => {
    const sendMessageStream = vi.fn(function* () {});
    const config = createFakeConfig(sendMessageStream);
    const signal = new AbortController().signal;

    await drain(livePromptEvents(config, 'hello', signal));

    expect(config.initialize).toHaveBeenCalled();
    expect(sendMessageStream).toHaveBeenCalledTimes(1);
    const [prompt, passedSignal, , options] = sendMessageStream.mock
      .calls[0] as unknown[];
    expect(prompt).toBe('hello');
    expect(passedSignal).toBe(signal);
    expect(options).toEqual({ type: SendMessageType.UserQuery });
  });

  it('hands the turn hooks the admission and every event of its streams', async () => {
    const events = [
      { type: 'content', value: 'hi' },
      {
        type: 'finished',
        value: { reason: undefined, usageMetadata: undefined },
      },
    ];
    const sendMessageStream = vi.fn(function* (...args: unknown[]) {
      (args[3] as { onPromptAdmitted?: () => void }).onPromptAdmitted?.();
      yield* events;
    });
    const config = createFakeConfig(sendMessageStream);
    const onPromptAdmitted = vi.fn();
    const onStreamEvent = vi.fn();

    await drain(
      livePromptEvents(config, 'hello', new AbortController().signal, {
        onPromptAdmitted,
        onStreamEvent,
      }),
    );

    expect(onPromptAdmitted).toHaveBeenCalledOnce();
    expect(onStreamEvent.mock.calls.map(([event]) => event)).toEqual(events);
  });

  it('shares one initialization promise across callers', async () => {
    const initialize = vi.fn(async () => {});
    const config = { initialize } as unknown as Config;

    await Promise.all([
      ensureConfigInitialized(config),
      ensureConfigInitialized(config),
    ]);

    expect(initialize).toHaveBeenCalledTimes(1);
  });

  it('blocks model sends on Mod failure even when the native client is initialized', async () => {
    const sendMessageStream = vi.fn(function* () {});
    const config = {
      ...createFakeConfig(sendMessageStream),
      getGeminiClient: () => ({ isInitialized: () => true }),
    } as unknown as Config;
    const initializeMods = vi
      .fn()
      .mockRejectedValue(new Error('Unsupported terminal tool.call'));
    modMocks.get.mockReturnValue({ initialize: initializeMods });

    await expect(ensureConfigInitialized(config)).rejects.toThrow(
      'terminal tool.call',
    );
    await expect(drain(livePromptEvents(config, 'hello'))).rejects.toThrow(
      'terminal tool.call',
    );
    expect(sendMessageStream).not.toHaveBeenCalled();
    // OpenTUI offers the band above the prompt.
    expect(initializeMods).toHaveBeenCalledExactlyOnceWith(['AbovePrompt']);
  });

  it('waits for the shared initialization before the first send', async () => {
    let resolveInitialize!: () => void;
    const initialize = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          resolveInitialize = resolve;
        }),
    );
    const sendMessageStream = vi.fn(function* () {
      yield { type: 'finished', value: {} };
    });
    const config = {
      ...createFakeConfig(sendMessageStream),
      initialize,
    } as unknown as Config;

    const gen = livePromptEvents(config, 'hello');
    const drained = drain(gen);

    // The registry loader's initialize is still in flight; the turn must not
    // send while it runs (the pre-fix behavior died with "Chat not
    // initialized" here).
    await new Promise((resolve) => setTimeout(resolve, 0));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(sendMessageStream).not.toHaveBeenCalled();

    resolveInitialize();
    await drained;

    expect(initialize).toHaveBeenCalledTimes(1);
    expect(sendMessageStream).toHaveBeenCalledTimes(1);
  });

  it('proceeds when another caller already initialized the config', async () => {
    const sendMessageStream = vi.fn(function* () {
      yield { type: 'finished', value: {} };
    });
    const config = {
      ...createFakeConfig(sendMessageStream),
      initialize: vi.fn(async () => {
        throw new Error('Config was already initialized');
      }),
    } as unknown as Config;

    await drain(livePromptEvents(config, 'hello'));

    expect(sendMessageStream).toHaveBeenCalledTimes(1);
  });

  it('surfaces a failed initialization instead of "Chat not initialized"', async () => {
    const sendMessageStream = vi.fn(function* () {});
    const config = {
      ...createFakeConfig(sendMessageStream),
      initialize: vi.fn(async () => {
        throw new Error('auth exploded');
      }),
      getGeminiClient: () => ({
        sendMessageStream,
        isInitialized: () => false,
      }),
    } as unknown as Config;

    await expect(drain(livePromptEvents(config, 'hello'))).rejects.toThrow(
      'auth exploded',
    );
  });

  it('rejects pending Mod readiness when host initialization fails', async () => {
    const error = new Error('Transcript restore failed');
    let rejectReady!: (reason: unknown) => void;
    const ready = new Promise<void>((_, reject) => {
      rejectReady = reject;
    });
    const failed = vi.fn();
    void ready.catch(failed);
    const failStartup = vi.fn(rejectReady);
    const initializeMods = vi.fn();
    modMocks.get.mockReturnValue({
      ready,
      failStartup,
      initialize: initializeMods,
    });
    const config = {
      initialize: vi.fn().mockRejectedValue(error),
      getGeminiClient: () => ({ isInitialized: () => false }),
    } as unknown as Config;

    await expect(ensureConfigInitialized(config)).rejects.toBe(error);
    expect(failed).toHaveBeenCalledExactlyOnceWith(error);
    await expect(ready).rejects.toBe(error);
    await expect(ensureConfigInitialized(config)).rejects.toBe(error);
    expect(failStartup).toHaveBeenCalledExactlyOnceWith(error);
    expect(initializeMods).not.toHaveBeenCalled();
    expect(config.initialize).toHaveBeenCalledOnce();
  });

  it.each(['already initialized', 'client ready'])(
    'accepts only successful host re-entry: %s',
    async (state) => {
      const initializeMods = vi.fn().mockResolvedValue(undefined);
      const failStartup = vi.fn();
      modMocks.get.mockReturnValue({ initialize: initializeMods, failStartup });
      const config = {
        initialize: vi
          .fn()
          .mockRejectedValue(
            new Error(
              state === 'already initialized'
                ? 'Config was already initialized'
                : 'Background recovery failed',
            ),
          ),
        getGeminiClient: () => ({
          isInitialized: () => state === 'client ready',
        }),
      } as unknown as Config;

      if (state === 'already initialized') {
        await expect(ensureConfigInitialized(config)).resolves.toBeUndefined();
        expect(initializeMods).toHaveBeenCalledOnce();
        expect(failStartup).not.toHaveBeenCalled();
      } else {
        await expect(ensureConfigInitialized(config)).rejects.toThrow(
          'Background recovery failed',
        );
        expect(initializeMods).not.toHaveBeenCalled();
        expect(failStartup).toHaveBeenCalledOnce();
      }
    },
  );

  it.each(['helper', 'failed elsewhere', 'succeeded elsewhere'])(
    'preserves the real staged Workflow mode startup outcome: %s',
    async (owner) => {
      const root = await mkdtemp(path.join(tmpdir(), 'opentui-startup-'));
      vi.stubEnv('QWEN_CODE_MODELS_DEV', 'off');
      vi.stubEnv('QWEN_CODE_DISABLE_WORKFLOWS', '1');
      const initializeMods = vi.fn();
      const failStartup = vi.fn();
      modMocks.get.mockReturnValue({ initialize: initializeMods, failStartup });
      try {
        await Storage.runWithRuntimeBaseDir(root, undefined, async () => {
          const config = new Config({
            cwd: root,
            targetDir: root,
            debugMode: false,
            model: 'test-model',
            chatRecording: true,
            workflowsEnabled: false,
            workflowMode: owner !== 'succeeded elsewhere',
            usageStatisticsEnabled: false,
            overrideExtensions: [],
            bareMode: true,
            safeMode: true,
            trustedFolder: true,
            disableAllHooks: true,
          });
          const send = vi.spyOn(config.getGeminiClient(), 'sendMessageStream');
          try {
            let failure: unknown;
            if (owner !== 'helper') {
              failure = await config
                .initialize()
                .catch((error: unknown) => error);
            }
            const startup = ensureConfigInitialized(config);
            expect(ensureConfigInitialized(config)).toBe(startup);
            if (owner === 'succeeded elsewhere') {
              await expect(startup).resolves.toBeUndefined();
              expect(initializeMods).toHaveBeenCalledOnce();
              expect(failStartup).not.toHaveBeenCalled();
            } else {
              failure ??= await startup.catch((error: unknown) => error);
              expect(failure).toMatchObject({
                message: 'Workflow mode is unavailable in this session',
              });
              await expect(startup).rejects.toBe(failure);
              await expect(ensureConfigInitialized(config)).rejects.toBe(
                failure,
              );
              await expect(
                drain(livePromptEvents(config, 'hello')),
              ).rejects.toBe(failure);
              expect(initializeMods).not.toHaveBeenCalled();
              expect(failStartup).toHaveBeenCalledExactlyOnceWith(failure);
            }
            expect(config.getGeminiClient().isInitialized()).toBe(true);
            expect(send).not.toHaveBeenCalled();
          } finally {
            await config.shutdown({ shutdownTelemetry: false });
          }
        });
      } finally {
        vi.unstubAllEnvs();
        await rm(root, { recursive: true, force: true });
      }
    },
  );

  it('keeps surfacing the real initialization failure on later submits', async () => {
    // Core never retries a settled initialization, so the rejected shared
    // promise stays cached: every submit sees "auth exploded", not the
    // masked re-entry error that degrades into "Chat not initialized".
    const sendMessageStream = vi.fn(function* () {});
    const config = {
      ...createFakeConfig(sendMessageStream),
      initialize: vi.fn(async () => {
        throw new Error('auth exploded');
      }),
      getGeminiClient: () => ({
        sendMessageStream,
        isInitialized: () => false,
      }),
    } as unknown as Config;

    await expect(drain(livePromptEvents(config, 'hello'))).rejects.toThrow(
      'auth exploded',
    );
    await expect(drain(livePromptEvents(config, 'hello'))).rejects.toThrow(
      'auth exploded',
    );
  });

  it('keeps the rejected initialization cached across direct re-entries', async () => {
    // Core flips `initialized` before awaiting the flight, so a re-entry after
    // a settled failure throws the re-entry error, not the real one: only the
    // cached rejected promise keeps surfacing the real cause. The submit-path
    // test above cannot see this — its mock rejects identically on every call,
    // so re-entering after an evicted cache entry looks the same.
    let calls = 0;
    const initialize = vi.fn(async () => {
      calls += 1;
      throw new Error(
        calls === 1 ? 'auth exploded' : 'Config was already initialized',
      );
    });
    const config = {
      initialize,
      getGeminiClient: () => ({ isInitialized: () => false }),
    } as unknown as Config;

    await expect(ensureConfigInitialized(config)).rejects.toThrow(
      'auth exploded',
    );
    await expect(ensureConfigInitialized(config)).rejects.toThrow(
      'auth exploded',
    );
    expect(initialize).toHaveBeenCalledTimes(1);
  });

  it('waits for the chat an in-flight startup initialization creates', async () => {
    // The boot-time command-registry load owns the initialize() flight, so the
    // turn's own call throws "already initialized" and its catch proceeds
    // while startChat() has not run yet. The real client then throws from
    // getChat(); the stand-in throws the same way, so the wait is what keeps
    // the turn alive.
    let chatReady = false;
    const sendMessageStream = vi.fn(function* () {
      if (!chatReady) throw new Error('Chat not initialized');
      yield { type: 'finished', value: {} };
    });
    const config = {
      ...createFakeConfig(sendMessageStream, undefined, () => chatReady),
      initialize: vi.fn(async () => {
        throw new Error('Config was already initialized');
      }),
    } as unknown as Config;
    setTimeout(() => {
      chatReady = true;
    }, 250);

    await drain(livePromptEvents(config, 'hello'));

    expect(sendMessageStream).toHaveBeenCalledTimes(1);
  });

  it('holds the first send until the startup chat has tool declarations', async () => {
    // `startChat()` assigns the chat (client.ts:2261) and only then awaits the
    // SessionStart hook, the session-start context and `setTools()`. A wait
    // that releases on chat existence alone sends the first prompt of the
    // session with no tool declarations at all.
    let chatExists = false;
    let tools: unknown[] | undefined;
    let toolsAtSend: unknown[] | undefined;
    const sendMessageStream = vi.fn(function* () {
      toolsAtSend = tools;
      yield { type: 'finished', value: {} };
    });
    const config = {
      ...createFakeConfig(sendMessageStream),
      initialize: vi.fn(async () => {
        throw new Error('Config was already initialized');
      }),
      getGeminiClient: () => ({
        sendMessageStream,
        isInitialized: () => chatExists,
        getChat: () => ({ getGenerationConfig: () => ({ tools }) }),
      }),
    } as unknown as Config;

    vi.useFakeTimers();
    try {
      chatExists = true;
      const pending = drain(livePromptEvents(config, 'hello'));
      // The chat exists while the startup flight is still inside setTools().
      await vi.advanceTimersByTimeAsync(1_000);
      expect(sendMessageStream).not.toHaveBeenCalled();
      tools = [{ functionDeclarations: [] }];
      await vi.advanceTimersByTimeAsync(1_000);
      await pending;
    } finally {
      vi.useRealTimers();
    }

    expect(sendMessageStream).toHaveBeenCalledTimes(1);
    // A literal, not the mutable `tools`, so a send that observed no tools
    // cannot pass by comparing two undefined values.
    expect(toolsAtSend).toEqual([{ functionDeclarations: [] }]);
  });

  it('reports the client error once the startup chat wait is spent', async () => {
    // The bound is what keeps a config that never finishes initializing from
    // polling forever: the turn falls through to the send and surfaces the
    // client's own error instead of hanging the prompt.
    const sendMessageStream = vi.fn(function* () {
      throw new Error('Chat not initialized');
      yield { type: 'finished', value: {} };
    });
    const config = {
      ...createFakeConfig(sendMessageStream),
      initialize: vi.fn(async () => {
        throw new Error('Config was already initialized');
      }),
      getGeminiClient: () => ({
        sendMessageStream,
        isInitialized: () => false,
        getChat: () => {
          throw new Error('Chat not initialized');
        },
      }),
    } as unknown as Config;

    vi.useFakeTimers();
    try {
      const pending = drain(livePromptEvents(config, 'hello'));
      // The wait expires deep inside the virtual-time run, so keep the
      // rejection handled until the assertion below can claim it.
      void pending.catch(() => {});
      await vi.advanceTimersByTimeAsync(STARTUP_CHAT_WAIT_MS + 1_000);
      await expect(pending).rejects.toThrow('Chat not initialized');
    } finally {
      vi.useRealTimers();
    }

    expect(sendMessageStream).toHaveBeenCalledTimes(1);
  });

  it('settles an Esc pressed during the startup wait without sending', async () => {
    // Releasing the wait is not enough: a text-only prompt has no abort gate
    // between the loop and `sendMessageStream`, so falling through would fire
    // the UserPromptSubmit hooks and push history for a cancelled prompt.
    const controller = new AbortController();
    const sendMessageStream = vi.fn(function* () {
      yield { type: 'finished', value: {} };
    });
    // A startup flight that never creates the chat, so the wait is still
    // running when the abort lands.
    const config = createFakeConfig(sendMessageStream, undefined, () => false);

    vi.useFakeTimers();
    try {
      const pending = drain(
        livePromptEvents(config, 'hello', controller.signal),
      );
      let settled = false;
      const markSettled = () => {
        settled = true;
      };
      void pending.then(markSettled, markSettled);
      await vi.advanceTimersByTimeAsync(500);
      controller.abort();
      // Poll ticks, not the budget: the abort must release the wait at once.
      await vi.advanceTimersByTimeAsync(500);
      expect(settled).toBe(true);
      await expect(pending).rejects.toThrow();
    } finally {
      vi.useRealTimers();
    }

    expect(sendMessageStream).not.toHaveBeenCalled();
  });

  it('fails the turn when the startup wait expires on a chat with no tools', async () => {
    // `startChat()` assigns the chat before the SessionStart hook and
    // `setTools()`, so a flight still inside that gap — or one that died in
    // it — leaves a chat that is not ready: a send against it declares zero
    // tools, silently.
    const sendMessageStream = vi.fn(function* () {
      yield { type: 'finished', value: {} };
    });
    const config = {
      ...createFakeConfig(sendMessageStream),
      initialize: vi.fn(async () => {
        throw new Error('Config was already initialized');
      }),
      getGeminiClient: () => ({
        sendMessageStream,
        isInitialized: () => true,
        getChat: () => ({ getGenerationConfig: () => ({ tools: undefined }) }),
      }),
    } as unknown as Config;

    vi.useFakeTimers();
    try {
      const pending = drain(livePromptEvents(config, 'hello'));
      // The wait expires deep inside the virtual-time run, so keep the
      // rejection handled until the assertion below can claim it.
      void pending.catch(() => {});
      await vi.advanceTimersByTimeAsync(STARTUP_CHAT_WAIT_MS + 1_000);
      await expect(pending).rejects.toThrow(
        `Timed out after ${STARTUP_CHAT_WAIT_MS}ms`,
      );
    } finally {
      vi.useRealTimers();
    }

    expect(sendMessageStream).not.toHaveBeenCalled();
  });

  it('uses the ink promptId format and increments promptCount per turn', async () => {
    const sendMessageStream = vi.fn(function* () {});
    const config = createFakeConfig(sendMessageStream);

    await drain(livePromptEvents(config, 'one'));
    await drain(livePromptEvents(config, 'two'));

    // ink parity: sessionId + '########' + promptCount (useGeminiStream:3287)
    expect((sendMessageStream.mock.calls[0] as unknown[])[2]).toBe(
      'session-1########0',
    );
    expect((sendMessageStream.mock.calls[1] as unknown[])[2]).toBe(
      'session-1########1',
    );
  });

  it('keeps one promptId across the tool-continuation loop of a turn', async () => {
    const sendMessageStream = oneToolBatchStream({
      callId: 't1',
      name: 'test_tool',
      args: {},
    });
    const config = createFakeConfig(sendMessageStream);

    await drain(livePromptEvents(config, 'go'));

    expect(sendMessageStream).toHaveBeenCalledTimes(2);
    expect((sendMessageStream.mock.calls[0] as unknown[])[2]).toBe(
      (sendMessageStream.mock.calls[1] as unknown[])[2],
    );
  });

  it('prefers the caller-minted promptId over the module counter (R1-16)', async () => {
    const sendMessageStream = vi.fn(function* () {});
    const config = createFakeConfig(sendMessageStream);

    await drain(
      livePromptEvents(config, 'go', undefined, {
        promptId: 'session-9########7',
      }),
    );

    expect((sendMessageStream.mock.calls[0] as unknown[])[2]).toBe(
      'session-9########7',
    );
  });

  it('forwards fresh-mode eligibility once without inventing human provenance', async () => {
    const sendMessageStream = oneToolBatchStream({
      callId: 'mode-tool',
      name: 'test_tool',
      args: {},
    });
    const config = createFakeConfig(sendMessageStream);
    await drain(
      livePromptEvents(config, 'ordinary recalled input', undefined, {
        workflowModeEligible: true,
      }),
    );
    expect((sendMessageStream.mock.calls[0] as unknown[])[3]).toMatchObject({
      workflowModeEligible: true,
    });
    expect(
      (sendMessageStream.mock.calls[0] as unknown[])[3],
    ).not.toHaveProperty('humanInput');
    expect(
      (sendMessageStream.mock.calls[1] as unknown[])[3],
    ).not.toHaveProperty('workflowModeEligible');
  });

  it('forwards multimodal part lists unchanged', async () => {
    const sendMessageStream = vi.fn(function* () {});
    const config = createFakeConfig(sendMessageStream);
    const parts = [
      { text: 'describe this: ' },
      { inlineData: { mimeType: 'image/png', data: 'aW1hZ2U=' } },
    ];

    // Production always reaches this seam with provenance set (the composer
    // submit passes `submittedPrompt`), so the options here are what force the
    // non-mention check — not the provenance short-circuit — to decide.
    await drain(
      livePromptEvents(config, parts, undefined, {
        submittedPrompt: 'describe this: ',
      }),
    );

    const [prompt] = sendMessageStream.mock.calls[0] as unknown[];
    expect(prompt).toBe(parts);
    // No mention occurs in the typed text, so the attachment payload stays intact.
    expect(atMocks.calls).toEqual([]);
  });

  it('runs a restored client tool without starting a model continuation', async () => {
    const sendMessageStream = vi.fn(function* () {
      yield { type: 'finished', value: {} };
    });
    const recordToolResult = vi.fn();
    const config = createFakeConfig(sendMessageStream, undefined, () => true, {
      recordMidTurnUserMessage: vi.fn(),
      recordToolResult,
    });
    const events = await drain(
      livePromptEvents(config, [], undefined, {
        promptId: 'restored-tool',
        toolCall: { name: 'test_tool', args: { owned: true } },
      }),
    );
    expect(recordToolResult).not.toHaveBeenCalled();
    expect(sendMessageStream).not.toHaveBeenCalled();
    expect(events.filter((event) => event.type === 'tool-start')).toHaveLength(
      1,
    );
    expect(events.filter((event) => event.type === 'tool-result')).toEqual([
      expect.objectContaining({ display: 'done' }),
    ]);
    expect(events.filter((event) => event.type === 'tool-end')).toEqual([
      expect.objectContaining({ success: true }),
    ]);
    expect(events.some((event) => event.type === 'user')).toBe(false);
  });

  it('keeps cancelled client tools out of model history and queued input', async () => {
    const sendMessageStream = vi.fn(function* () {});
    const recordToolResult = vi.fn();
    const config = createFakeConfig(sendMessageStream, undefined, () => true, {
      recordMidTurnUserMessage: vi.fn(),
      recordToolResult,
    });
    const drainSteering = vi.fn(() => steering('next user turn'));
    const events = await drain(
      livePromptEvents(config, [], undefined, {
        toolCall: { name: 'test_tool', args: { __cancelled: true } },
        drainSteering,
      }),
    );

    expect(recordToolResult).not.toHaveBeenCalled();
    expect(sendMessageStream).not.toHaveBeenCalled();
    expect(config.getGeminiClient().addHistory).not.toHaveBeenCalled();
    expect(drainSteering).not.toHaveBeenCalled();
    expect(events.filter((event) => event.type === 'tool-end')).toEqual([
      expect.objectContaining({ success: false, summary: 'cancelled' }),
    ]);
  });

  it.each(['success', 'cancelled', 'successor', 'rewritten'] as const)(
    'pairs an actual initialTool completion only with its captured restore owner: %s',
    async (mode) => {
      const directory = await mkdtemp(
        path.join(tmpdir(), 'restore-live-caller-'),
      );
      const config = makeFakeConfig({
        targetDir: directory,
        cwd: directory,
        usageStatisticsEnabled: false,
        disableAllHooks: true,
      });
      const client = new LlmClient(config);
      const chat = new LlmChat(config);
      chat.setTools([]);
      vi.spyOn(client, 'getChat').mockReturnValue(chat);
      vi.spyOn(client, 'isInitialized').mockReturnValue(true);
      vi.spyOn(config, 'getLlmClient').mockReturnValue(client);
      vi.spyOn(config, 'getGeminiClient').mockReturnValue(client);
      vi.spyOn(config, 'initialize').mockResolvedValue();
      const sends = vi.spyOn(client, 'sendMessageStream');
      const recordToolResult = vi.fn();
      vi.spyOn(config, 'getChatRecordingService').mockReturnValue({
        recordToolResult,
      } as unknown as ChatRecordingService);
      const args = {
        __cancelled: mode === 'cancelled',
        __rewritten: mode === 'rewritten',
        __restoreResult:
          mode === 'cancelled'
            ? { error: 'ACTUAL_CANCELLED_RESULT' }
            : { output: 'ACTUAL_LOCAL_REPLAY_RESULT' },
      };
      client.setHistory([
        {
          role: 'model',
          parts: [
            { functionCall: { id: 'original-call', name: 'test_tool', args } },
          ],
        },
      ]);
      const binding = createRestoreToolResponseBinding(
        config,
        'test_tool',
        args,
      )!;
      let current = true;
      try {
        for await (const event of livePromptEvents(config, [], undefined, {
          toolCall: {
            name: 'test_tool',
            args,
            restoreResponseBinding: binding,
          },
          isCurrentTurn: () => current,
        })) {
          if (mode === 'successor' && event.type === 'tool-end')
            current = false;
        }
        const history = client.getHistoryShallow();
        if (mode === 'successor') expect(history).toHaveLength(1);
        else {
          expect(binding.executionCallId).toMatch(/^test_tool-/);
          expect(history).toHaveLength(2);
          expect(history[0].parts?.[0].functionCall?.args).toEqual(args);
          expect(history[1].parts).toEqual([
            {
              functionResponse: {
                id: 'original-call',
                name: 'test_tool',
                response: args.__restoreResult,
              },
            },
          ]);
        }
        expect(sends).not.toHaveBeenCalled();
        expect(recordToolResult).not.toHaveBeenCalled();
      } finally {
        await rm(directory, { recursive: true, force: true });
      }
    },
  );

  it.each(['healthy', 'aborted'] as const)(
    'checks the actual abort signal during a held restore publication: %s',
    async (mode) => {
      const directory = await mkdtemp(
        path.join(tmpdir(), 'restore-abort-owner-'),
      );
      const config = makeFakeConfig({
        targetDir: directory,
        cwd: directory,
        usageStatisticsEnabled: false,
        disableAllHooks: true,
      });
      const client = new LlmClient(config);
      const chat = new LlmChat(config);
      chat.setTools([]);
      vi.spyOn(client, 'getChat').mockReturnValue(chat);
      vi.spyOn(client, 'isInitialized').mockReturnValue(true);
      vi.spyOn(config, 'getLlmClient').mockReturnValue(client);
      vi.spyOn(config, 'getGeminiClient').mockReturnValue(client);
      vi.spyOn(config, 'initialize').mockResolvedValue();
      const sends = vi.spyOn(client, 'sendMessageStream');
      const args = { __restoreResult: { output: 'ACTUAL_NEW_LOCAL_RESULT' } };
      client.setHistory([
        {
          role: 'model',
          parts: [
            { functionCall: { id: 'logical-old', name: 'test_tool', args } },
          ],
        },
      ]);
      const tail = chat.peekLastHistoryEntry();
      const revision = chat.getHistoryReplacementRevision();
      const addHistory = vi.spyOn(client, 'addHistory');
      let enter!: () => void;
      let release!: () => void;
      const entered = new Promise<void>((resolve) => {
        enter = resolve;
      });
      const held = new Promise<void>((resolve) => {
        release = resolve;
      });
      const publish = vi.fn();
      const restoreToolBranch = vi.fn(
        async (
          input: Parameters<ChatRecordingService['restoreToolBranch']>[0],
        ) => {
          enter();
          await held;
          if (!input.isCurrent()) return false;
          publish(input);
          return true;
        },
      );
      const recorder = {
        restoreToolBranch,
        recordToolResult: vi.fn(),
      } as unknown as ChatRecordingService;
      vi.spyOn(config, 'getChatRecordingService').mockReturnValue(recorder);
      const binding = createRestoreToolResponseBinding(
        config,
        'test_tool',
        args,
        {
          recorder,
          truncatedCount: 0,
        },
      )!;
      const controller = new AbortController();
      let run: Promise<OpenTuiStreamEvent[]> | undefined;
      try {
        // A real interrupt aborts the signal while this turn's seq stays current.
        // Do not emulate it by returning false from isCurrentTurn.
        run = drain(
          livePromptEvents(config, [], controller.signal, {
            toolCall: {
              name: 'test_tool',
              args,
              restoreResponseBinding: binding,
            },
            isCurrentTurn: () => true,
          }),
        );
        await Promise.race([
          entered,
          run.then(() => {
            throw new Error('Restore did not enter held durable publication');
          }),
        ]);
        expect(restoreToolBranch).toHaveBeenCalledOnce();
        expect(restoreToolBranch.mock.calls[0][0].isCurrent()).toBe(true);
        expect(addHistory).not.toHaveBeenCalled();
        if (mode === 'aborted') controller.abort();
        expect(controller.signal.aborted).toBe(mode === 'aborted');
        expect(chat.peekLastHistoryEntry()).toBe(tail);
        expect(chat.getHistoryReplacementRevision()).toBe(revision);
        release();
        await run;
        expect(sends).not.toHaveBeenCalled();
        expect(recorder.recordToolResult).not.toHaveBeenCalled();
        if (mode === 'aborted') {
          expect(publish).not.toHaveBeenCalled();
          expect(addHistory).not.toHaveBeenCalled();
          expect(client.getHistoryShallow()).toHaveLength(1);
        } else {
          expect(publish).toHaveBeenCalledOnce();
          expect(addHistory).toHaveBeenCalledOnce();
          expect(client.getHistoryShallow()[1].parts).toEqual([
            {
              functionResponse: {
                id: 'logical-old',
                name: 'test_tool',
                response: args.__restoreResult,
              },
            },
          ]);
        }
      } finally {
        release();
        try {
          if (run) await run;
        } finally {
          await rm(directory, { recursive: true, force: true });
        }
      }
    },
  );

  it('passes the per-turn modelOverride through send options', async () => {
    const sendMessageStream = vi.fn(function* () {});
    const config = createFakeConfig(sendMessageStream);

    await drain(
      livePromptEvents(config, 'go', undefined, { modelOverride: 'fast-x' }),
    );

    const [, , , options] = sendMessageStream.mock.calls[0] as unknown[];
    expect(options).toEqual({
      type: SendMessageType.UserQuery,
      modelOverride: 'fast-x',
    });
  });

  it('rides submittedPrompt on the first send and drops it on continuation', async () => {
    const sendMessageStream = oneToolBatchStream({
      callId: 't1',
      name: 'test_tool',
      args: {},
    });
    const config = createFakeConfig(sendMessageStream);

    await drain(
      livePromptEvents(config, 'expanded payload', undefined, {
        submittedPrompt: '@file.txt raw composer text',
      }),
    );

    expect(sendMessageStream).toHaveBeenCalledTimes(2);
    const [firstOptions, secondOptions] = sendMessageStream.mock.calls.map(
      (call) => (call as unknown[])[3],
    );
    expect(firstOptions).toEqual({
      type: SendMessageType.UserQuery,
      submittedPrompt: '@file.txt raw composer text',
    });
    expect(secondOptions).toEqual({ type: SendMessageType.ToolResult });
  });

  it('forwards a human declaration only on the initial send, independently from submittedPrompt', async () => {
    const sendMessageStream = oneToolBatchStream({
      callId: 'intent-tool',
      name: 'test_tool',
      args: {},
    });
    const config = createFakeConfig(sendMessageStream);
    const humanInput = { text: 'ultracode inspect @notes' };
    await drain(
      livePromptEvents(config, 'expanded payload', undefined, { humanInput }),
    );
    expect((sendMessageStream.mock.calls[0] as unknown[])[3]).toMatchObject({
      type: SendMessageType.UserQuery,
      humanInput,
    });
    expect(
      (sendMessageStream.mock.calls[0] as unknown[])[3],
    ).not.toHaveProperty('submittedPrompt');
    expect(
      (sendMessageStream.mock.calls[1] as unknown[])[3],
    ).not.toHaveProperty('humanInput');
  });

  it('expands an @-mention where the prompt enters the stream', async () => {
    const sendMessageStream = vi.fn(function* () {});
    const config = createFakeConfig(sendMessageStream);
    const expanded = [
      { text: 'summarize @src/a.ts' },
      { text: '--- Content from src/a.ts ---\nFILE BODY' },
    ];
    atMocks.result = {
      processedQuery: expanded,
      shouldProceed: true,
      toolDisplays: [readDisplay()],
    };

    const events = await drain(
      livePromptEvents(config, 'summarize @src/a.ts', undefined, {
        submittedPrompt: 'summarize @src/a.ts',
      }),
    );

    expect(atMocks.calls).toEqual(['summarize @src/a.ts']);
    const [prompt, , , options] = sendMessageStream.mock.calls[0] as unknown[];
    expect(prompt).toEqual(expanded);
    // The transcript item (applied by the caller) keeps the typed text; the
    // expanded payload is for the model, and provenance stays raw.
    expect(options).toEqual({
      type: SendMessageType.UserQuery,
      submittedPrompt: 'summarize @src/a.ts',
    });
    // ink renders the read through handleAtCommand's addItem as a tool_group;
    // here it is the same card, already settled.
    const canonical = expectMentionCanonicalSource(events);
    expect(events).toEqual(
      expect.arrayContaining([
        {
          type: 'tool-start',
          id: 'client-read-1',
          ...canonical,
          tool: 'Read File(s)',
          title: 'src/a.ts',
        },
        {
          type: 'tool-result',
          id: 'client-read-1',
          ...canonical,
          display: 'FILE BODY',
        },
        {
          type: 'tool-end',
          id: 'client-read-1',
          ...canonical,
          success: true,
          summary: 'ok',
        },
      ]),
    );
  });

  it('reports a failed @-mention read instead of sending the unexpanded text', async () => {
    const sendMessageStream = vi.fn(function* () {});
    const config = createFakeConfig(sendMessageStream);
    atMocks.result = {
      processedQuery: null,
      shouldProceed: false,
      toolDisplays: [
        readDisplay({
          description: 'Error attempting to read files',
          status: ToolCallStatus.Error,
          resultDisplay: 'Error reading files (missing.ts): no such file',
        }),
      ],
    };

    const events = await drain(
      livePromptEvents(config, 'read @missing.ts', undefined, {
        submittedPrompt: 'read @missing.ts',
      }),
    );

    expect(sendMessageStream).not.toHaveBeenCalled();
    const canonical = expectMentionCanonicalSource(events);
    expect(events).toEqual(
      expect.arrayContaining([
        {
          type: 'tool-result',
          id: 'client-read-1',
          ...canonical,
          display: 'Error reading files (missing.ts): no such file',
        },
        {
          type: 'tool-end',
          id: 'client-read-1',
          ...canonical,
          success: false,
          summary: 'error',
        },
      ]),
    );
  });

  it('leaves a generated prompt carrying an @-mention unexpanded (R1-6)', async () => {
    const sendMessageStream = vi.fn(function* () {});
    const config = createFakeConfig(sendMessageStream);
    // Decline-shaped: were the gate keyed on the prompt's shape alone, a
    // `/remember my friend @alice …` payload would drop the turn here.
    atMocks.result = { processedQuery: null, shouldProceed: false };

    await drain(livePromptEvents(config, 'remember that @alice reviews PRs'));

    expect(atMocks.calls).toEqual([]);
    expect(sendMessageStream).toHaveBeenCalledTimes(1);
    const [prompt] = sendMessageStream.mock.calls[0] as unknown[];
    expect(prompt).toBe('remember that @alice reviews PRs');
  });

  it('expands typed mentions while retaining the separately attached image bytes', async () => {
    const sendMessageStream = vi.fn(function* () {});
    const config = createFakeConfig(sendMessageStream);
    const image = {
      inlineData: {
        mimeType: 'image/png',
        data: 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGP4z8AAAAMBAQDJ/pLvAAAAAElFTkSuQmCC',
      },
    };
    atMocks.result = {
      processedQuery: [{ text: 'look @notes.md' }, { text: 'NOTES CONTENT' }],
      shouldProceed: true,
    };
    await drain(
      livePromptEvents(config, [{ text: 'look @notes.md' }, image], undefined, {
        submittedPrompt: 'look @notes.md',
      }),
    );
    expect(atMocks.calls).toEqual(['look @notes.md']);
    expect(sendMessageStream).toHaveBeenCalledOnce();
    expect((sendMessageStream.mock.calls[0] as unknown[])[0]).toEqual([
      { text: 'look @notes.md' },
      { text: 'NOTES CONTENT' },
      image,
    ]);
  });

  it('sends and records structured steering with mentions and exact image parts once', async () => {
    const sendMessageStream = oneToolBatchStream({
      callId: 't1',
      name: 'test_tool',
      args: {},
    });
    const recordMidTurnUserMessage = vi.fn();
    const config = createFakeConfig(sendMessageStream, undefined, undefined, {
      recordMidTurnUserMessage,
    });
    const image = { inlineData: { mimeType: 'image/png', data: 'AAECA//+' } };
    const entry = {
      text: 'compare @notes.md',
      submittedPrompt: 'raw compare @notes.md',
      imagePaths: ['/owned/image.png'],
      content: [{ text: 'compare @notes.md' }, image],
    };
    atMocks.result = {
      processedQuery: [{ text: 'expanded notes' }],
      shouldProceed: true,
    };
    const events = await drain(
      livePromptEvents(config, 'start', undefined, {
        drainSteering: () => [entry],
      }),
    );
    expect(atMocks.calls).toEqual(['compare @notes.md']);
    expect(sendMessageStream.mock.calls[1][0]).toEqual([
      {
        functionResponse: {
          name: 'test_tool',
          id: 't1',
          response: { ok: true },
        },
      },
      { text: 'expanded notes' },
      image,
    ]);
    expect(recordMidTurnUserMessage).toHaveBeenCalledExactlyOnceWith(
      [{ text: 'expanded notes' }, image],
      'compare @notes.md',
    );
    expect(events.filter((event) => event.type === 'user')).toEqual([
      { type: 'user', text: 'compare @notes.md', sentToModel: false },
    ]);
  });

  it('restores the same structured batch when cancelled inside mention resolution', async () => {
    const sendMessageStream = oneToolBatchStream({
      callId: 't1',
      name: 'test_tool',
      args: {},
    });
    const config = createFakeConfig(sendMessageStream);
    const controller = new AbortController();
    const entry: OpenTuiSteeringSubmission = {
      text: 'look @notes.md',
      submittedPrompt: 'raw look',
      imagePaths: ['/owned/image.png'],
      content: [
        { text: 'look @notes.md' },
        {
          inlineData: { mimeType: 'image/png', data: 'AAECAw==' },
        },
      ],
    };
    const restoreSteering = vi.fn();
    atMocks.hang = () => controller.abort();
    const events = await drain(
      livePromptEvents(config, 'start', controller.signal, {
        drainSteering: () => [entry],
        restoreSteering,
      }),
    );
    expect(restoreSteering).toHaveBeenCalledOnce();
    expect(restoreSteering.mock.calls[0][0][0]).toBe(entry);
    expect(sendMessageStream).toHaveBeenCalledOnce();
    expect(events.filter((event) => event.type === 'user')).toEqual([]);
  });

  it.each(['call', 'iteration'])(
    'restores structured steering without echo or recording when continuation fails during %s',
    async (failure) => {
      const first = oneToolBatchStream({
        callId: 't1',
        name: 'test_tool',
        args: {},
      });
      let sends = 0;
      const sendMessageStream = vi.fn((...args: unknown[]) => {
        if (++sends === 1) return first();
        if (failure === 'call') throw new Error('not delivered');
        return (async function* () {
          try {
            yield await Promise.reject(new Error('not delivered'));
          } finally {
            (args[3] as SendMessageOptions).steerInput?.restore();
          }
        })();
      });
      const recordMidTurnUserMessage = vi.fn();
      const config = createFakeConfig(sendMessageStream, undefined, undefined, {
        recordMidTurnUserMessage,
      });
      const entry = {
        text: 'steered image',
        imagePaths: ['/owned/image.png'],
        submittedPrompt: 'raw steered image',
        content: [
          { text: 'steered image' },
          {
            inlineData: { mimeType: 'image/png', data: 'AAECAw==' },
          },
        ],
      };
      const restoreSteering = vi.fn();
      const events: OpenTuiStreamEvent[] = [];
      await expect(
        (async () => {
          for await (const event of livePromptEvents(
            config,
            'start',
            undefined,
            {
              drainSteering: () => [entry],
              restoreSteering,
            },
          ))
            events.push(event);
        })(),
      ).rejects.toThrow('not delivered');
      expect(restoreSteering).toHaveBeenCalledOnce();
      expect(restoreSteering.mock.calls[0][0][0]).toBe(entry);
      expect(recordMidTurnUserMessage).not.toHaveBeenCalled();
      expect(events.filter((event) => event.type === 'user')).toEqual([]);
    },
  );

  it('commits steering once when core accepts before a later stream failure', async () => {
    let sends = 0;
    const sendMessageStream = vi.fn(function* (...args: unknown[]) {
      if (++sends === 1) {
        yield {
          type: 'tool_call_request',
          value: {
            callId: 't1',
            name: 'test_tool',
            args: {},
          },
        };
        return;
      }
      (args[3] as SendMessageOptions).steerInput?.accept();
      yield { type: 'content', value: 'delivered' };
      throw new Error('failed after delivery');
    });
    const recordMidTurnUserMessage = vi.fn();
    const config = createFakeConfig(sendMessageStream, undefined, undefined, {
      recordMidTurnUserMessage,
    });
    const restoreSteering = vi.fn();
    const events: OpenTuiStreamEvent[] = [];
    await expect(
      (async () => {
        for await (const event of livePromptEvents(config, 'start', undefined, {
          drainSteering: () => steering('send exactly once'),
          restoreSteering,
        }))
          events.push(event);
      })(),
    ).rejects.toThrow('failed after delivery');
    expect(recordMidTurnUserMessage).toHaveBeenCalledExactlyOnceWith(
      [{ text: 'send exactly once' }],
      'send exactly once',
    );
    expect(events.filter((event) => event.type === 'user')).toEqual([
      { type: 'user', text: 'send exactly once', sentToModel: false },
    ]);
    expect(restoreSteering).not.toHaveBeenCalled();
  });

  it.each([
    { type: 'max_session_turns' },
    {
      type: 'session_token_limit_exceeded',
      value: { currentTokens: 20, limit: 10 },
    },
    { type: 'loop_detected' },
    { type: 'zero-event exit' },
  ])(
    'restores a pre-push $type continuation even without an error',
    async (event) => {
      const entry = {
        text: 'keep this image',
        imagePaths: ['/owned/image.png'],
        content: [
          { text: 'keep this image' },
          { inlineData: { mimeType: 'image/png', data: 'AAECAw==' } },
        ],
      };
      let sends = 0;
      const sendMessageStream = vi.fn(function* (...args: unknown[]) {
        if (++sends === 1) {
          yield {
            type: 'tool_call_request',
            value: { callId: 't1', name: 'test_tool', args: {} },
          };
          return;
        }
        const carrier = (args[3] as SendMessageOptions).steerInput;
        expect(carrier?.parts).toEqual(entry.content);
        try {
          if (event.type !== 'zero-event exit') yield event;
        } finally {
          carrier?.restore();
          carrier?.restore();
          carrier?.accept();
        }
      });
      const recordMidTurnUserMessage = vi.fn();
      const config = createFakeConfig(sendMessageStream, undefined, undefined, {
        recordMidTurnUserMessage,
      });
      const restoreSteering = vi.fn();
      const onAcceptedSteering = vi.fn();
      const events = await drain(
        livePromptEvents(config, 'start', undefined, {
          drainSteering: () => [entry],
          restoreSteering,
          onAcceptedSteering,
        }),
      );
      expect(sendMessageStream).toHaveBeenCalledTimes(2);
      expect(sendMessageStream.mock.calls[1][0]).toEqual([
        toolResponse,
        ...entry.content,
      ]);
      expect(restoreSteering).toHaveBeenCalledOnce();
      expect(restoreSteering.mock.calls[0][0][0]).toBe(entry);
      expect(recordMidTurnUserMessage).not.toHaveBeenCalled();
      expect(onAcceptedSteering).not.toHaveBeenCalled();
      expect(events.filter((item) => item.type === 'user')).toEqual([]);
    },
  );

  it.each(['zero-event exit', 'throw before an event', 'loop_detected'])(
    'commits core-accepted history once on %s',
    async (outcome) => {
      const entry = {
        text: 'accepted image',
        content: [
          { text: 'accepted image' },
          { inlineData: { mimeType: 'image/png', data: 'AAECAw==' } },
        ],
      };
      let sends = 0;
      const sendMessageStream = vi.fn(function* (...args: unknown[]) {
        if (++sends === 1) {
          yield {
            type: 'tool_call_request',
            value: { callId: 't1', name: 'test_tool', args: {} },
          };
          return;
        }
        const carrier = (args[3] as SendMessageOptions).steerInput;
        expect(carrier?.parts).toEqual(entry.content);
        carrier?.accept();
        carrier?.accept();
        carrier?.restore();
        if (outcome === 'throw before an event') {
          throw new Error('provider failed after history push');
        }
        if (outcome === 'loop_detected') yield { type: 'loop_detected' };
      });
      const recordMidTurnUserMessage = vi.fn();
      const config = createFakeConfig(sendMessageStream, undefined, undefined, {
        recordMidTurnUserMessage,
      });
      const restoreSteering = vi.fn();
      const onAcceptedSteering = vi.fn();
      const events: OpenTuiStreamEvent[] = [];
      const pending = (async () => {
        for await (const event of livePromptEvents(config, 'start', undefined, {
          drainSteering: () => [entry],
          restoreSteering,
          onAcceptedSteering,
        })) {
          events.push(event);
        }
      })();
      if (outcome === 'throw before an event') {
        await expect(pending).rejects.toThrow(
          'provider failed after history push',
        );
      } else {
        await pending;
      }
      expect(sendMessageStream).toHaveBeenCalledTimes(2);
      expect(sendMessageStream.mock.calls[1][0]).toEqual([
        toolResponse,
        ...entry.content,
      ]);
      expect(recordMidTurnUserMessage).toHaveBeenCalledExactlyOnceWith(
        entry.content,
        entry.text,
      );
      expect(events.filter((event) => event.type === 'user')).toEqual([
        { type: 'user', text: entry.text, sentToModel: false },
      ]);
      expect(restoreSteering).not.toHaveBeenCalled();
      expect(onAcceptedSteering).toHaveBeenCalledExactlyOnceWith([entry.text]);
    },
  );

  it('appends drained steering texts after tool responses at the boundary', async () => {
    const sendMessageStream = oneToolBatchStream({
      callId: 't1',
      name: 'test_tool',
      args: {},
    });
    const config = createFakeConfig(sendMessageStream);

    await drain(
      livePromptEvents(config, 'start', undefined, {
        drainSteering: () => steering('steer me'),
      }),
    );

    expect(sendMessageStream).toHaveBeenCalledTimes(2);
    const [secondPrompt] = sendMessageStream.mock.calls[1] as unknown[];
    expect(secondPrompt).toEqual([
      {
        functionResponse: {
          name: 'test_tool',
          id: 't1',
          response: { ok: true },
        },
      },
      { text: 'steer me' },
    ]);
  });

  it.each([false, true])(
    'gates late acceptance by turn generation, not abort state (invalidated=%s)',
    async (invalidated) => {
      let current = true;
      let sends = 0;
      const controller = new AbortController();
      const originalRecording = vi.fn();
      const successorRecording = vi.fn();
      const sendMessageStream = vi.fn(async function* (...args: unknown[]) {
        if (++sends === 1) {
          yield {
            type: 'tool_call_request',
            value: { callId: 't1', name: 'test_tool', args: {} },
          };
          return;
        }
        controller.abort();
        current = !invalidated;
        if (invalidated) {
          vi.spyOn(config, 'getChatRecordingService').mockReturnValue({
            recordMidTurnUserMessage: successorRecording,
          } as unknown as ReturnType<Config['getChatRecordingService']>);
        }
        await Promise.resolve();
        (args[3] as SendMessageOptions).steerInput?.accept();
      });
      const config = createFakeConfig(sendMessageStream, undefined, undefined, {
        recordMidTurnUserMessage: originalRecording,
      });
      const restoreSteering = vi.fn();
      const events = await drain(
        livePromptEvents(config, 'start', controller.signal, {
          drainSteering: () => steering('owned by the old turn'),
          restoreSteering,
          isCurrentTurn: () => current,
        }),
      );
      expect(successorRecording).not.toHaveBeenCalled();
      expect(originalRecording).toHaveBeenCalledTimes(invalidated ? 0 : 1);
      expect(events.filter((event) => event.type === 'user')).toHaveLength(
        invalidated ? 0 : 1,
      );
      expect(restoreSteering).not.toHaveBeenCalled();
    },
  );

  it.each([false, true])(
    'reports consumed mention declines even when core restores the continuation (mixed=%s)',
    async (mixed) => {
      let sends = 0;
      const sendMessageStream = vi.fn(function* (...args: unknown[]) {
        if (++sends === 1) {
          yield {
            type: 'tool_call_request',
            value: { callId: 't1', name: 'test_tool', args: {} },
          };
          return;
        }
        (args[3] as SendMessageOptions).steerInput?.restore();
        yield { type: 'max_session_turns' };
      });
      const recordMidTurnUserMessage = vi.fn();
      const config = createFakeConfig(sendMessageStream, undefined, undefined, {
        recordMidTurnUserMessage,
      });
      const valid = {
        text: 'keep image',
        content: [{ text: 'keep image' }, imagePart],
      };
      atMocks.result = {
        processedQuery: null,
        shouldProceed: false,
        toolDisplays: [
          readDisplay({
            status: ToolCallStatus.Error,
            resultDisplay: 'missing.ts could not be read',
          }),
        ],
      };
      const restoreSteering = vi.fn();
      const events = await drain(
        livePromptEvents(config, 'start', undefined, {
          drainSteering: () => [
            ...steering('@missing.ts'),
            ...(mixed ? [valid] : []),
          ],
          restoreSteering,
        }),
      );
      expect(sendMessageStream.mock.calls[1][0]).toEqual([
        toolResponse,
        ...(mixed ? valid.content : []),
      ]);
      expect(restoreSteering.mock.calls).toEqual(mixed ? [[[valid]]] : []);
      const canonical = expectMentionCanonicalSource(events);
      expect(events).toContainEqual({
        type: 'tool-result',
        id: 'client-read-1',
        ...canonical,
        display: 'missing.ts could not be read',
      });
      expect(events.filter((event) => event.type === 'user')).toEqual([]);
      expect(recordMidTurnUserMessage).not.toHaveBeenCalled();
    },
  );

  it('skips steering when the turn is aborted', async () => {
    const drainSteering = vi.fn(() => steering('never'));
    const controller = new AbortController();
    const batch = oneToolBatchStream({
      callId: 't1',
      name: 'test_tool',
      args: {},
    });
    // Esc reaches the generator mid-turn, not before it: the abort lands on
    // the tool-response boundary, which is where a real cancel arrives.
    const sendMessageStream = vi.fn(() => {
      controller.abort();
      return batch();
    });
    const config = createFakeConfig(sendMessageStream);

    await drain(
      livePromptEvents(config, 'start', controller.signal, { drainSteering }),
    );

    expect(drainSteering).not.toHaveBeenCalled();
  });

  // --- The steering hop resolves the way an idle submission does (U-21) ----

  const toolResponse = {
    functionResponse: { name: 'test_tool', id: 't1', response: { ok: true } },
  };

  it('expands an @-mention in drained steering text before the boundary send', async () => {
    const sendMessageStream = oneToolBatchStream({
      callId: 't1',
      name: 'test_tool',
      args: {},
    });
    const config = createFakeConfig(sendMessageStream);
    atMocks.result = {
      processedQuery: [
        { text: 'look @src/a.ts' },
        { text: '--- Content from src/a.ts ---\nFILE BODY' },
      ],
      shouldProceed: true,
      toolDisplays: [readDisplay()],
    };

    const events = (await drain(
      livePromptEvents(config, 'start', undefined, {
        drainSteering: () => steering('look @src/a.ts'),
      }),
    )) as OpenTuiStreamEvent[];

    expect(atMocks.calls).toEqual(['look @src/a.ts']);
    const [secondPrompt] = sendMessageStream.mock.calls[1] as unknown[];
    expect(secondPrompt).toEqual([
      toolResponse,
      { text: 'look @src/a.ts' },
      { text: '--- Content from src/a.ts ---\nFILE BODY' },
    ]);
    // The read the model received shows up as the settled card ink renders.
    const canonical = expectMentionCanonicalSource(events);
    expect(events).toEqual(
      expect.arrayContaining([
        {
          type: 'tool-start',
          id: 'client-read-1',
          ...canonical,
          tool: 'Read File(s)',
          title: 'src/a.ts',
        },
        {
          type: 'tool-result',
          id: 'client-read-1',
          ...canonical,
          display: 'FILE BODY',
        },
        {
          type: 'tool-end',
          id: 'client-read-1',
          ...canonical,
          success: true,
          summary: 'ok',
        },
      ]),
    );
  });

  it('joins drained steering texts with a blank line between messages', async () => {
    const sendMessageStream = oneToolBatchStream({
      callId: 't1',
      name: 'test_tool',
      args: {},
    });
    const config = createFakeConfig(sendMessageStream);

    await drain(
      livePromptEvents(config, 'start', undefined, {
        drainSteering: () => steering('first', 'second'),
      }),
    );

    const [secondPrompt] = sendMessageStream.mock.calls[1] as unknown[];
    expect(secondPrompt).toEqual([
      toolResponse,
      { text: 'first' },
      { text: '\n\n' },
      { text: 'second' },
    ]);
    expect(atMocks.calls).toEqual([]);
  });

  it('restores the whole drained batch when the turn dies inside a steering read', async () => {
    const sendMessageStream = oneToolBatchStream({
      callId: 't1',
      name: 'test_tool',
      args: {},
    });
    const config = createFakeConfig(sendMessageStream);
    const controller = new AbortController();
    const restoreSteering = vi.fn();
    atMocks.hang = () => controller.abort();

    const events = (await drain(
      livePromptEvents(config, 'start', controller.signal, {
        drainSteering: () => steering('read @a.ts', 'then @b.ts'),
        restoreSteering,
      }),
    )) as OpenTuiStreamEvent[];

    // All-or-nothing: the resolved hop dies with the turn, so every text comes
    // back instead of a half-built message reaching the model.
    expect(restoreSteering).toHaveBeenCalledWith(
      steering('read @a.ts', 'then @b.ts'),
    );
    // R6-5: the dead signal never sends the continuation — the completed
    // batch's responses reach history instead (the R5-4 shape, pinned below).
    expect(sendMessageStream).toHaveBeenCalledTimes(1);
    // And nothing the restored hop produced reaches the transcript: the echo
    // belongs to ink's accept step (U-12), which an aborted hop never gets to.
    expect(events.filter((e) => e.type === 'user')).toEqual([]);
  });

  // --- U-32: a steer is recorded for /resume (ink accept() :3352-3358) -----

  it('records each surviving steered message with its own parts (U-32)', async () => {
    const sendMessageStream = oneToolBatchStream({
      callId: 't1',
      name: 'test_tool',
      args: {},
    });
    const recordMidTurnUserMessage = vi.fn();
    const config = createFakeConfig(sendMessageStream, undefined, undefined, {
      recordMidTurnUserMessage,
    });

    await drain(
      livePromptEvents(config, 'start', undefined, {
        drainSteering: () => steering('first', 'second'),
      }),
    );

    // Per message, in ink accept() order — each with its own parts, not the
    // joined hop (a resumed session replays the same shape).
    expect(recordMidTurnUserMessage.mock.calls).toEqual([
      [[{ text: 'first' }], 'first'],
      [[{ text: 'second' }], 'second'],
    ]);
  });

  it('records nothing when the steering hop is restored (U-32)', async () => {
    const sendMessageStream = oneToolBatchStream({
      callId: 't1',
      name: 'test_tool',
      args: {},
    });
    const recordMidTurnUserMessage = vi.fn();
    const config = createFakeConfig(sendMessageStream, undefined, undefined, {
      recordMidTurnUserMessage,
    });
    const controller = new AbortController();
    atMocks.hang = () => controller.abort();

    await drain(
      livePromptEvents(config, 'start', controller.signal, {
        drainSteering: () => steering('read @a.ts'),
      }),
    );

    expect(recordMidTurnUserMessage).not.toHaveBeenCalled();
    // R6-5: the abort inside the hop is the same dead-signal window as an
    // abort after the hop — the completed batch's responses still reach
    // history, and no continuation send rides the aborted signal.
    const addHistory = vi.mocked(config.getGeminiClient().addHistory);
    expect(addHistory).toHaveBeenCalledTimes(1);
    const content = addHistory.mock.calls[0][0] as {
      role: string;
      parts: Array<{ functionResponse?: { id?: string } }>;
    };
    expect(content.role).toBe('user');
    expect(content.parts.some((p) => p.functionResponse?.id === 't1')).toBe(
      true,
    );
    expect(sendMessageStream).toHaveBeenCalledTimes(1);
  });

  it('restores the steer when the abort lands after the hop resolves (U-32)', async () => {
    const sendMessageStream = oneToolBatchStream({
      callId: 't1',
      name: 'test_tool',
      args: {},
    });
    const recordMidTurnUserMessage = vi.fn();
    const addHistory = vi.fn();
    const config = {
      ...createFakeConfig(sendMessageStream, undefined, undefined, {
        recordMidTurnUserMessage,
      }),
      getGeminiClient: () => ({
        sendMessageStream,
        addHistory,
        isInitialized: () => true,
        getChat: () => ({
          getGenerationConfig: () => ({
            tools: [{ functionDeclarations: [] }],
          }),
        }),
      }),
    } as unknown as Config;
    const controller = new AbortController();
    const restoreSteering = vi.fn();
    atMocks.abortAfter = () => controller.abort();
    atMocks.result = {
      processedQuery: [{ text: 'resolved @a.ts' }],
      shouldProceed: true,
    };

    const events = (await drain(
      livePromptEvents(config, 'start', controller.signal, {
        drainSteering: () => steering('read @a.ts'),
        restoreSteering,
      }),
    )) as OpenTuiStreamEvent[];

    // The hop resolved cleanly, but the continuation send will never run on
    // the aborted signal — ink re-checks the signal after accept() and so must
    // the recording: writing it here would commit a mid-turn user message the
    // model never saw, and /resume would replay it as the user's words.
    expect(recordMidTurnUserMessage).not.toHaveBeenCalled();
    expect(restoreSteering).toHaveBeenCalledWith(steering('read @a.ts'));
    expect(events.filter((e) => e.type === 'user')).toEqual([]);
    // The resolved hop does not ride the dead signal: no continuation send.
    expect(sendMessageStream).toHaveBeenCalledTimes(1);
    // The batch itself completed before the abort, so its responses must
    // still be paired with their calls (R5-4): without the history write the
    // next send's orphan repair tells the model the successful tool failed
    // and invites a retry.
    expect(addHistory).toHaveBeenCalledTimes(1);
    const content = addHistory.mock.calls[0][0] as {
      role: string;
      parts: Array<{ functionResponse?: { id?: string } }>;
    };
    expect(content.role).toBe('user');
    expect(content.parts.some((p) => p.functionResponse?.id === 't1')).toBe(
      true,
    );
  });

  it('restores the steer and records nothing when the continuation send throws (R6-7)', async () => {
    let calls = 0;
    const sendMessageStream = vi.fn(function* (): Generator<{
      type: string;
      value?: unknown;
    }> {
      calls += 1;
      if (calls === 1) {
        yield {
          type: 'tool_call_request',
          value: { callId: 't1', name: 'test_tool', args: {} },
        };
        return;
      }
      throw new Error('429 rate limited');
    });
    const recordMidTurnUserMessage = vi.fn();
    const config = createFakeConfig(sendMessageStream, undefined, undefined, {
      recordMidTurnUserMessage,
    });
    const restoreSteering = vi.fn();

    await expect(
      drain(
        livePromptEvents(config, 'start', undefined, {
          drainSteering: () => steering('also check the tests'),
          restoreSteering,
        }),
      ),
    ).rejects.toThrow('429 rate limited');

    // The steer reached the send but the send died before delivering it: no
    // mid-turn recording for content the model never saw, and the drained
    // text goes back raw so the retried turn re-expands it.
    expect(sendMessageStream).toHaveBeenCalledTimes(2);
    expect(recordMidTurnUserMessage).not.toHaveBeenCalled();
    expect(restoreSteering).toHaveBeenCalledWith(
      steering('also check the tests'),
    );
  });

  it('gives up on a hung mid-turn read instead of parking the boundary', async () => {
    const sendMessageStream = oneToolBatchStream({
      callId: 't1',
      name: 'test_tool',
      args: {},
    });
    const config = createFakeConfig(sendMessageStream);
    const restoreSteering = vi.fn();
    // Empty hook: nothing aborts, so only the read deadline frees the boundary.
    atMocks.hang = () => {};

    vi.useFakeTimers();
    try {
      const pending = drain(
        livePromptEvents(config, 'start', undefined, {
          drainSteering: () => steering('read @hanging.ts'),
          restoreSteering,
        }),
      );
      // The turn reaches the boundary through several microtask hops; pump
      // until the read deadline is armed.
      let armed = false;
      for (let i = 0; i < 40 && !armed; i++) {
        await vi.advanceTimersByTimeAsync(1);
        armed = vi.getTimerCount() > 0;
      }
      expect(armed).toBe(true);
      // ink's MID_TURN_AT_COMMAND_RESOLVE_TIMEOUT_MS is 10 s.
      await vi.advanceTimersByTimeAsync(10_500);
      const events = (await pending) as OpenTuiStreamEvent[];

      expect(events.filter((e) => e.type === 'warning')).toEqual([
        {
          type: 'warning',
          text: 'Could not attach file: Mid-turn @ command resolution timed out',
        },
      ]);
      // A timeout is the read's failure, not the turn's: the text is dropped
      // like any declined expansion rather than requeued forever.
      expect(restoreSteering).not.toHaveBeenCalled();
      const [secondPrompt] = sendMessageStream.mock.calls[1] as unknown[];
      expect(secondPrompt).toEqual([toolResponse]);
    } finally {
      vi.useRealTimers();
    }
  });

  // --- U-12: the steer shows up as an unsent user row (ink accept()) -------

  it('echoes each surviving steered text as an unsent user row', async () => {
    const sendMessageStream = oneToolBatchStream({
      callId: 't1',
      name: 'test_tool',
      args: {},
    });
    const config = createFakeConfig(sendMessageStream);

    const events = (await drain(
      livePromptEvents(config, 'start', undefined, {
        drainSteering: () => steering('first', 'second'),
      }),
    )) as OpenTuiStreamEvent[];

    expect(events.filter((e) => e.type === 'user')).toEqual([
      { type: 'user', text: 'first', sentToModel: false },
      { type: 'user', text: 'second', sentToModel: false },
    ]);
  });

  it('echoes the steer after the resolved read cards, like ink accept()', async () => {
    const sendMessageStream = oneToolBatchStream({
      callId: 't1',
      name: 'test_tool',
      args: {},
    });
    const config = createFakeConfig(sendMessageStream);
    atMocks.result = {
      processedQuery: [
        { text: 'look @src/a.ts' },
        { text: '--- Content from src/a.ts ---\nFILE BODY' },
      ],
      shouldProceed: true,
      toolDisplays: [readDisplay()],
    };

    const events = (await drain(
      livePromptEvents(config, 'start', undefined, {
        drainSteering: () => steering('look @src/a.ts'),
      }),
    )) as OpenTuiStreamEvent[];

    // accept() order: the read cards first, then the USER row at grant.
    const cardIndex = events.findIndex(
      (e) => e.type === 'tool-end' && e.id === 'client-read-1',
    );
    const echoIndex = events.findIndex(
      (e) => e.type === 'user' && e.text === 'look @src/a.ts',
    );
    expect(cardIndex).toBeGreaterThan(-1);
    expect(echoIndex).toBeGreaterThan(cardIndex);
    expect(events[echoIndex]).toEqual({
      type: 'user',
      text: 'look @src/a.ts',
      sentToModel: false,
    });
  });

  it('renders each steered message with its own cards before its own echo', async () => {
    const sendMessageStream = oneToolBatchStream({
      callId: 't1',
      name: 'test_tool',
      args: {},
    });
    const config = createFakeConfig(sendMessageStream);
    atMocks.result = {
      processedQuery: [{ text: 'expanded' }],
      shouldProceed: true,
      toolDisplays: [readDisplay()],
    };

    const events = (await drain(
      livePromptEvents(config, 'start', undefined, {
        drainSteering: () => steering('one @src/a.ts', 'two @src/b.ts'),
      }),
    )) as OpenTuiStreamEvent[];

    // ink accept() runs each message's side effects and then adds its USER row,
    // so the pairs interleave rather than grouping all cards before all rows.
    expect(
      events
        .filter(
          (e) =>
            e.type === 'user' ||
            (e.type === 'tool-end' && e.id === 'client-read-1'),
        )
        .map((e) => (e.type === 'user' ? `echo:${e.text}` : 'card')),
    ).toEqual(['card', 'echo:one @src/a.ts', 'card', 'echo:two @src/b.ts']);
  });

  it('does not echo a steer the expander declined', async () => {
    const sendMessageStream = oneToolBatchStream({
      callId: 't1',
      name: 'test_tool',
      args: {},
    });
    const config = createFakeConfig(sendMessageStream);
    atMocks.result = { processedQuery: null, shouldProceed: false };

    const events = (await drain(
      livePromptEvents(config, 'start', undefined, {
        drainSteering: () => steering('@declined.ts'),
      }),
    )) as OpenTuiStreamEvent[];

    expect(events.filter((e) => e.type === 'user')).toEqual([]);
  });

  it('reports a declined mixed mention and image without partial delivery or retry', async () => {
    const sendMessageStream = oneToolBatchStream({
      callId: 't1',
      name: 'test_tool',
      args: {},
    });
    const recordMidTurnUserMessage = vi.fn();
    const config = createFakeConfig(sendMessageStream, undefined, undefined, {
      recordMidTurnUserMessage,
    });
    const restoreSteering = vi.fn();
    const drainSteering = vi.fn(() => [
      {
        text: 'read @missing.ts',
        submittedPrompt: 'read @missing.ts',
        imagePaths: ['/attached.png'],
        content: [
          { text: 'read @missing.ts' },
          { inlineData: { mimeType: 'image/png', data: 'AAECAw==' } },
        ],
      },
    ]);
    atMocks.result = {
      processedQuery: null,
      shouldProceed: false,
      toolDisplays: [
        readDisplay({
          description: 'Error attempting to read files',
          status: ToolCallStatus.Error,
          resultDisplay: 'Error reading files (missing.ts): no such file',
        }),
      ],
    };

    const events = (await drain(
      livePromptEvents(config, 'start', undefined, {
        drainSteering,
        restoreSteering,
      }),
    )) as OpenTuiStreamEvent[];

    expect(atMocks.calls).toHaveLength(1);
    expect(drainSteering).toHaveBeenCalledOnce();
    expect(sendMessageStream).toHaveBeenCalledTimes(2);
    expect(sendMessageStream.mock.calls[1][0]).toEqual([toolResponse]);
    expect(restoreSteering).not.toHaveBeenCalled();
    expect(recordMidTurnUserMessage).not.toHaveBeenCalled();
    expect(events.filter((event) => event.type === 'user')).toEqual([]);
    const canonical = expectMentionCanonicalSource(events);
    expect(events).toEqual(
      expect.arrayContaining([
        {
          type: 'tool-result',
          id: 'client-read-1',
          ...canonical,
          display: 'Error reading files (missing.ts): no such file',
        },
        {
          type: 'tool-end',
          id: 'client-read-1',
          ...canonical,
          success: false,
          summary: 'error',
        },
      ]),
    );
  });

  it('echoes a steer whose expansion resolved to no parts', async () => {
    const sendMessageStream = oneToolBatchStream({
      callId: 't1',
      name: 'test_tool',
      args: {},
    });
    const config = createFakeConfig(sendMessageStream);
    // Proceeded, but nothing came back. The echo is deliberately decoupled from
    // this message's own parts, which over-shows against ink in the all-empty
    // hop — its caller drops the whole hop (use-llm-stream.ts:3394), so accept()
    // never runs there. That is the divergence Decision 4 of the batch-9 design
    // doc records, not a parity claim.
    atMocks.result = { processedQuery: [], shouldProceed: true };

    const events = (await drain(
      livePromptEvents(config, 'start', undefined, {
        drainSteering: () => steering('@empty.ts'),
      }),
    )) as OpenTuiStreamEvent[];

    expect(events.filter((e) => e.type === 'user')).toEqual([
      { type: 'user', text: '@empty.ts', sentToModel: false },
    ]);
  });

  // --- The prompt-side vision bridge (U-25) --------------------------------

  const bridgeModel: VisionBridgeModelSelection = { id: 'qwen3-vl' };

  it('converts a composer image through the bridge and discloses the egress', async () => {
    const sendMessageStream = vi.fn(function* () {});
    const config = createFakeConfig(sendMessageStream, bridgeModel);
    visionMocks.run.mockResolvedValue({
      applied: true,
      status: 'ok',
      parts: [{ text: 'what is this?' }, { text: 'IMAGE TRANSCRIPT' }],
      convertedCount: 1,
      omittedCount: 0,
      modelId: 'qwen3-vl',
      egressOccurred: true,
    });
    const parts = [{ text: 'what is this?' }, imagePart];

    const events = (await drain(
      livePromptEvents(config, parts, undefined, {
        submittedPrompt: 'what is this?',
      }),
    )) as OpenTuiStreamEvent[];

    const [prompt] = sendMessageStream.mock.calls[0] as unknown[];
    expect(prompt).toEqual([
      { text: 'what is this?' },
      { text: 'IMAGE TRANSCRIPT' },
    ]);
    expect(visionMocks.run).toHaveBeenCalledWith(
      expect.objectContaining({ config, parts }),
    );
    const notice = events.find((e) => e.type === 'info');
    expect(notice?.text).toContain('Converted 1 image(s) to text via qwen3-vl');
    expect(notice?.text).toContain('sent to that model');
  });

  it('drops the image rather than forwarding it when the bridge yields nothing', async () => {
    const sendMessageStream = vi.fn(function* () {});
    const config = createFakeConfig(sendMessageStream, bridgeModel);
    visionMocks.run.mockResolvedValue({
      applied: false,
      status: 'failed',
      convertedCount: 0,
      omittedCount: 1,
      modelId: 'qwen3-vl',
      error: 'the vision model request failed',
    });

    const events = (await drain(
      livePromptEvents(config, [{ text: 'look' }, imagePart]),
    )) as OpenTuiStreamEvent[];

    // A text-only model must never receive raw inlineData.
    const [prompt] = sendMessageStream.mock.calls[0] as unknown[];
    expect(prompt).toEqual([{ text: 'look' }]);
    expect(events.some((e) => e.type === 'error')).toBe(true);
  });

  it('routes the whole turn onto an agent-capable vision model without bridging', async () => {
    const sendMessageStream = oneToolBatchStream({
      callId: 't1',
      name: 'test_tool',
      args: {},
    });
    const config = createFakeConfig(sendMessageStream, {
      id: 'qwen3-vl',
      agentCapable: true,
    });
    atMocks.result = {
      processedQuery: [{ text: 'read @shot.png' }, imagePart],
      shouldProceed: true,
    };

    const events = (await drain(
      livePromptEvents(config, [{ text: 'look' }, imagePart], undefined, {
        drainSteering: () => steering('read @shot.png'),
      }),
    )) as OpenTuiStreamEvent[];

    expect(visionMocks.run).not.toHaveBeenCalled();
    // The images stay: the model reading them can see them.
    const [firstPrompt, secondPrompt] = sendMessageStream.mock.calls.map(
      (call) => (call as unknown[])[0],
    );
    expect(firstPrompt).toEqual([{ text: 'look' }, imagePart]);
    expect(secondPrompt).toEqual([
      toolResponse,
      { text: 'read @shot.png' },
      imagePart,
    ]);
    // The pick is a trailing-NUL selector, and it holds for the continuation.
    const overrides = sendMessageStream.mock.calls.map(
      (call) =>
        (call as unknown[])[3] as { modelOverride?: string } | undefined,
    );
    expect(overrides.map((o) => o?.modelOverride)).toEqual([
      'qwen3-vl\0',
      'qwen3-vl\0',
    ]);
    expect(events.filter((e) => e.type === 'info').map((e) => e.text)).toEqual([
      'Routing this image turn to qwen3-vl; retries and tool continuations will stay on that model until the turn ends.',
    ]);
  });

  it('carries a full-turn pick made mid-turn into the rest of the turn', async () => {
    // Here the image arrives only through the steered `@` mention, so the pick
    // happens at the boundary — after the first send already went out on the
    // primary model. A per-turn override read once would leave both the
    // continuation call and the model named in its own notice on the old one.
    let calls = 0;
    const sendMessageStream = vi.fn(function* (...args: unknown[]): Generator<{
      type: string;
      value?: unknown;
    }> {
      calls += 1;
      if (calls === 1) {
        yield {
          type: 'tool_call_request',
          value: { callId: 't1', name: 'test_tool', args: {} },
        };
        return;
      }
      (args[3] as SendMessageOptions).steerInput?.accept();
      yield { type: 'chat_compressed', value: {} };
      yield { type: 'finished', value: {} };
    });
    const config = createFakeConfig(sendMessageStream, {
      id: 'qwen3-vl',
      agentCapable: true,
    });
    atMocks.result = {
      processedQuery: [{ text: 'read @shot.png' }, imagePart],
      shouldProceed: true,
    };

    const events = (await drain(
      livePromptEvents(config, 'start', undefined, {
        drainSteering: () => steering('read @shot.png'),
      }),
    )) as OpenTuiStreamEvent[];

    const readOptions = (call: unknown[]) =>
      call[3] as { modelOverride?: string } | undefined;
    expect(readOptions(sendMessageStream.mock.calls[0])).toEqual({
      type: SendMessageType.UserQuery,
    });
    const [secondPrompt] = sendMessageStream.mock.calls[1] as unknown[];
    expect(secondPrompt).toEqual([
      toolResponse,
      { text: 'read @shot.png' },
      imagePart,
    ]);
    expect(readOptions(sendMessageStream.mock.calls[1])?.modelOverride).toBe(
      'qwen3-vl\0',
    );
    expect(events.filter((e) => e.type === 'info').map((e) => e.text)).toEqual([
      'Routing this image turn to qwen3-vl; retries and tool continuations will stay on that model until the turn ends.',
      expect.stringContaining('input token limit for qwen3-vl'),
    ]);
  });

  it('leaves an inline submit_prompt override off the bridge', async () => {
    const sendMessageStream = vi.fn(function* () {});
    const config = createFakeConfig(sendMessageStream, bridgeModel);
    const parts = [{ text: 'look' }, imagePart];

    const events = (await drain(
      livePromptEvents(config, parts, undefined, {
        modelOverride: 'fast-x',
        submittedPrompt: 'look',
      }),
    )) as OpenTuiStreamEvent[];

    expect(visionMocks.run).not.toHaveBeenCalled();
    const [prompt, , , options] = sendMessageStream.mock.calls[0] as unknown[];
    expect(prompt).toBe(parts);
    expect(options).toEqual({
      type: SendMessageType.UserQuery,
      modelOverride: 'fast-x',
      submittedPrompt: 'look',
    });
    expect(events.filter((e) => e.type === 'info')).toEqual([]);
  });

  it('converts an image a steered @-mention pulled into the message', async () => {
    const sendMessageStream = oneToolBatchStream({
      callId: 't1',
      name: 'test_tool',
      args: {},
    });
    const config = createFakeConfig(sendMessageStream, bridgeModel);
    atMocks.result = {
      processedQuery: [{ text: 'read @shot.png' }, imagePart],
      shouldProceed: true,
    };
    visionMocks.run.mockResolvedValue({
      applied: true,
      status: 'ok',
      parts: [{ text: 'read @shot.png' }, { text: 'BRIDGE TRANSCRIPT' }],
      convertedCount: 1,
      omittedCount: 0,
      modelId: 'qwen3-vl',
      egressOccurred: true,
    });

    await drain(
      livePromptEvents(config, 'start', undefined, {
        drainSteering: () => steering('read @shot.png'),
      }),
    );

    const [secondPrompt] = sendMessageStream.mock.calls[1] as unknown[];
    expect(secondPrompt).toEqual([
      toolResponse,
      { text: 'read @shot.png' },
      { text: 'BRIDGE TRANSCRIPT' },
    ]);
  });

  it('discloses the egress when the bridge is cancelled after sending', async () => {
    const sendMessageStream = vi.fn(function* () {});
    const config = createFakeConfig(sendMessageStream, bridgeModel);
    const controller = new AbortController();
    visionMocks.run.mockImplementation(async () => {
      controller.abort();
      return {
        applied: false,
        status: 'skipped',
        convertedCount: 0,
        omittedCount: 0,
        modelId: 'qwen3-vl',
        egressOccurred: true,
      };
    });

    const events = (await drain(
      livePromptEvents(
        config,
        [{ text: 'look' }, imagePart],
        controller.signal,
      ),
    )) as OpenTuiStreamEvent[];

    // Esc stops the send, but the images already left: the notice survives.
    expect(sendMessageStream).not.toHaveBeenCalled();
    const notice = events.find((e) => e.type === 'info');
    expect(notice?.text).toContain('Vision bridge cancelled.');
    expect(notice?.text).toContain('were sent to qwen3-vl');
  });

  // --- U-27: unsupported image formats are disclosed on both hops ----------

  it('discloses an unsupported image format once before the first send', async () => {
    const yielded: OpenTuiStreamEvent[] = [];
    let disclosedAtSend: boolean | undefined;
    // Captured in the call body, not in a generator body: the request goes out
    // when the client is called, and a generator's body would only run at the
    // first `next()`. A check moved after the send leaves `yielded` empty here.
    const sendMessageStream = vi.fn(() => {
      disclosedAtSend = yielded.some(
        (e) =>
          e.type === 'info' && e.text === getUnsupportedImageFormatWarning(),
      );
      return (function* () {})();
    });
    const config = createFakeConfig(sendMessageStream);
    const avif = { inlineData: { mimeType: 'image/avif', data: 'aGk=' } };

    for await (const ev of livePromptEvents(config, [{ text: 'look' }, avif])) {
      yielded.push(ev);
    }

    expect(disclosedAtSend).toBe(true);
    // Exactly one notice, with ink's own text naming the supported set.
    expect(yielded.filter((e) => e.type === 'info')).toEqual([
      { type: 'info', text: getUnsupportedImageFormatWarning() },
    ]);
    // ink forwards the image anyway; only the disclosure is added.
    const [prompt] = sendMessageStream.mock.calls[0] as unknown[];
    expect(prompt).toEqual([{ text: 'look' }, avif]);
  });

  it('does not disclose an accepted format (png rides through silently)', async () => {
    const sendMessageStream = vi.fn(function* () {});
    const config = createFakeConfig(sendMessageStream);

    const events = (await drain(
      livePromptEvents(config, [{ text: 'look' }, imagePart]),
    )) as OpenTuiStreamEvent[];

    expect(events.filter((e) => e.type === 'info')).toEqual([]);
  });

  it('discloses an unsupported format carried as fileData', async () => {
    const sendMessageStream = vi.fn(function* () {});
    const config = createFakeConfig(sendMessageStream);
    const avif = {
      fileData: { mimeType: 'image/avif', fileUri: 'gs://bucket/shot.avif' },
    };

    const events = (await drain(
      livePromptEvents(config, [{ text: 'look' }, avif]),
    )) as OpenTuiStreamEvent[];

    expect(events.filter((e) => e.type === 'info')).toEqual([
      { type: 'info', text: getUnsupportedImageFormatWarning() },
    ]);
    // ink forwards the part anyway — the disclosure is the only addition.
    const [prompt] = sendMessageStream.mock.calls[0] as unknown[];
    expect(prompt).toEqual([{ text: 'look' }, avif]);
  });

  it('discloses the format warning on the steering hop before the echo', async () => {
    const sendMessageStream = oneToolBatchStream({
      callId: 't1',
      name: 'test_tool',
      args: {},
    });
    const config = createFakeConfig(sendMessageStream);
    const avif = { inlineData: { mimeType: 'image/avif', data: 'aGk=' } };
    atMocks.result = {
      processedQuery: [{ text: 'see @shot.avif' }, avif],
      shouldProceed: true,
      toolDisplays: [readDisplay()],
    };

    const events = (await drain(
      livePromptEvents(config, 'start', undefined, {
        drainSteering: () => steering('see @shot.avif'),
      }),
    )) as OpenTuiStreamEvent[];

    const warnIndex = events.findIndex(
      (e) => e.type === 'info' && e.text === getUnsupportedImageFormatWarning(),
    );
    const echoIndex = events.findIndex(
      (e) => e.type === 'user' && e.text === 'see @shot.avif',
    );
    expect(warnIndex).toBeGreaterThan(-1);
    expect(echoIndex).toBeGreaterThan(warnIndex);
  });

  it('attributes the steering disclosure to the message that carries the image', async () => {
    const sendMessageStream = oneToolBatchStream({
      callId: 't1',
      name: 'test_tool',
      args: {},
    });
    const config = createFakeConfig(sendMessageStream);
    const avif = { inlineData: { mimeType: 'image/avif', data: 'aGk=' } };
    atMocks.result = {
      processedQuery: [{ text: 'see @shot.avif' }, avif],
      shouldProceed: true,
      toolDisplays: [readDisplay()],
    };

    const events = (await drain(
      livePromptEvents(config, 'start', undefined, {
        drainSteering: () => steering('plain steer', 'see @shot.avif'),
      }),
    )) as OpenTuiStreamEvent[];

    const indexOf = (match: (e: OpenTuiStreamEvent) => boolean): number =>
      events.findIndex(match);
    const firstEcho = indexOf(
      (e) => e.type === 'user' && e.text === 'plain steer',
    );
    const warn = indexOf(
      (e) => e.type === 'info' && e.text === getUnsupportedImageFormatWarning(),
    );
    const secondEcho = indexOf(
      (e) => e.type === 'user' && e.text === 'see @shot.avif',
    );

    // One warning for the drain, and it sits inside the second message's
    // window: a check hoisted above the loop lands after both echoes.
    expect(events.filter((e) => e.type === 'info')).toHaveLength(1);
    expect(firstEcho).toBeGreaterThan(-1);
    expect(warn).toBeGreaterThan(firstEcho);
    expect(secondEcho).toBeGreaterThan(warn);
  });

  it('publishes actual executing shell PID/controllers, excluding queued and non-shell calls, then clears the owner', async () => {
    let requests = 0;
    const send = vi.fn(function* (): Generator<{
      type: string;
      value?: unknown;
    }> {
      if (++requests === 1) {
        yield {
          type: 'tool_call_request',
          value: {
            callId: 'shell-owner',
            name: 'run_shell_command',
            args: { __foreground: true },
          },
        };
        yield {
          type: 'tool_call_request',
          value: { callId: 'not-shell', name: 'read_file', args: {} },
        };
      } else yield { type: 'finished', value: {} };
    });
    const onExecutingShells = vi.fn();
    await drain(
      livePromptEvents(createFakeConfig(send), 'q', undefined, {
        onExecutingShells,
      }),
    );
    const snapshots = onExecutingShells.mock.calls.map(([calls]) => calls);
    expect(snapshots[0]).toEqual([]);
    expect(snapshots).toContainEqual([
      {
        callId: 'shell-owner',
        pid: 4300,
        promoteAbortController: expect.any(AbortController),
      },
    ]);
    expect(snapshots.at(-1)).toEqual([]);
    expect(snapshots.flat().some((call) => call.pid === 9999)).toBe(false);
    expect(snapshots.flat().some((call) => call.callId === 'not-shell')).toBe(
      false,
    );
  });

  it('forwards awaiting_approval calls to onWaitingCall exactly once per callId', async () => {
    let calls = 0;
    const sendMessageStream = vi.fn(function* (): Generator<{
      type: string;
      value?: unknown;
    }> {
      calls += 1;
      if (calls === 1) {
        yield {
          type: 'tool_call_request',
          value: { callId: 'w1', name: 'ask_user_question', args: {} },
        };
        return;
      }
      yield { type: 'finished', value: {} };
    });
    const config = createFakeConfig(sendMessageStream);
    const onWaitingCall = vi.fn();

    await drain(livePromptEvents(config, 'q', undefined, { onWaitingCall }));

    // The fake scheduler reports the waiting call twice; dedupe must surface it once.
    expect(onWaitingCall).toHaveBeenCalledTimes(1);
    expect(onWaitingCall.mock.calls[0][0]).toMatchObject({
      callId: 'w1',
      name: 'ask_user_question',
    });
  });

  it('re-surfaces a call that bounces back to awaiting_approval (R1-102)', async () => {
    let calls = 0;
    const sendMessageStream = vi.fn(function* (): Generator<{
      type: string;
      value?: unknown;
    }> {
      calls += 1;
      if (calls === 1) {
        yield {
          type: 'tool_call_request',
          value: {
            callId: 'b1',
            name: 'run_shell_command',
            args: { __bounceApproval: true },
          },
        };
        return;
      }
      yield { type: 'finished', value: {} };
    });
    const config = createFakeConfig(sendMessageStream);
    const onWaitingCall = vi.fn();

    await drain(livePromptEvents(config, 'q', undefined, { onWaitingCall }));

    // The call left awaiting_approval (executing) and re-entered it via a
    // PreToolUse 'ask' bounce under the same callId — the second waiting
    // state must surface its dialog again, with the bounced details.
    expect(onWaitingCall).toHaveBeenCalledTimes(2);
    expect(onWaitingCall.mock.calls[0][0]).toMatchObject({ callId: 'b1' });
    expect(onWaitingCall.mock.calls[1][0]).toMatchObject({
      callId: 'b1',
      confirmationDetails: {
        title: 'Hook requested confirmation to run',
      },
    });
  });

  it('yields a confirm event per awaiting_approval entrance (transcript pending marker)', async () => {
    let calls = 0;
    const sendMessageStream = vi.fn(function* (): Generator<{
      type: string;
      value?: unknown;
    }> {
      calls += 1;
      if (calls === 1) {
        yield {
          type: 'tool_call_request',
          value: {
            callId: 'b2',
            name: 'run_shell_command',
            args: { __bounceApproval: true },
          },
        };
        return;
      }
      yield { type: 'finished', value: {} };
    });
    const config = createFakeConfig(sendMessageStream);

    const events = (await drain(
      livePromptEvents(config, 'q'),
    )) as OpenTuiStreamEvent[];

    // One event per entrance: the initial parking and the PreToolUse 'ask'
    // bounce back under the same callId, with the pending marker released
    // in between (the executing update drops the call from awaiting).
    const confirms = events.filter(
      (e) => e.type === 'confirm' || e.type === 'confirm-resolved',
    );
    expect(confirms).toEqual([
      {
        type: 'confirm',
        id: 'b2',
        tool: 'run_shell_command',
        title: 'original',
      },
      { type: 'confirm-resolved', id: 'b2', outcome: 'approved' },
      {
        type: 'confirm',
        id: 'b2',
        tool: 'run_shell_command',
        title: 'Hook requested confirmation to run',
      },
    ]);
  });

  it('reports an approved call as queued while its sibling still awaits', async () => {
    let requests = 0;
    const queuedArgs = { __queuedApproval: true };
    const sendMessageStream = vi.fn(function* (): Generator<{
      type: string;
      value?: unknown;
    }> {
      requests += 1;
      if (requests === 1) {
        yield {
          type: 'tool_call_request',
          value: { callId: 'q1', name: 'run_shell_command', args: queuedArgs },
        };
        yield {
          type: 'tool_call_request',
          value: { callId: 'q2', name: 'run_shell_command', args: queuedArgs },
        };
        return;
      }
      yield { type: 'finished', value: {} };
    });
    const config = createFakeConfig(sendMessageStream);

    const events = (await drain(
      livePromptEvents(config, 'q'),
    )) as OpenTuiStreamEvent[];

    // Approving the first call does not start it while the second still
    // awaits: ink shows it as queued, not running, for exactly that span. The
    // call that never left awaiting_approval carries no event at all.
    expect(events.filter((e) => e.type === 'tool-queued')).toEqual([
      { type: 'tool-queued', id: 'q1', queued: true },
      { type: 'tool-queued', id: 'q1', queued: false },
    ]);
  });

  it('tells the turn when every tool of a round was declined', async () => {
    const sendMessageStream = vi.fn(function* (): Generator<{
      type: string;
      value?: unknown;
    }> {
      yield {
        type: 'tool_call_request',
        value: {
          callId: 'c9',
          name: 'run_shell_command',
          args: { __cancelApproval: true },
        },
      };
      yield { type: 'finished', value: {} };
    });
    const config = {
      ...createFakeConfig(sendMessageStream),
      getGeminiClient: () => ({
        sendMessageStream,
        addHistory: vi.fn(),
        isInitialized: () => true,
        getChat: () => ({ getGenerationConfig: () => ({ tools: [] }) }),
      }),
    } as unknown as Config;
    const onToolsCancelled = vi.fn();

    await drain(livePromptEvents(config, 'q', undefined, { onToolsCancelled }));

    expect(onToolsCancelled).toHaveBeenCalledOnce();
    expect(sendMessageStream).toHaveBeenCalledOnce();
  });

  it('records the No/Esc cancellation as a rejected resolution (R1-18)', async () => {
    const sendMessageStream = vi.fn(function* (): Generator<{
      type: string;
      value?: unknown;
    }> {
      yield {
        type: 'tool_call_request',
        value: {
          callId: 'c9',
          name: 'run_shell_command',
          args: { __cancelApproval: true },
        },
      };
      yield { type: 'finished', value: {} };
    });
    const config = {
      ...createFakeConfig(sendMessageStream),
      getGeminiClient: () => ({
        sendMessageStream,
        addHistory: vi.fn(),
        isInitialized: () => true,
        getChat: () => ({ getGenerationConfig: () => ({ tools: [] }) }),
      }),
    } as unknown as Config;

    const events = (await drain(
      livePromptEvents(config, 'q'),
    )) as OpenTuiStreamEvent[];

    // coreToolScheduler sets status 'cancelled' when the user picks
    // No/Esc — the resolved event must carry 'rejected', not blanket
    // 'approved', or the transcript mislabels a declined tool.
    const resolved = events.find((e) => e.type === 'confirm-resolved');
    expect(resolved).toEqual({
      type: 'confirm-resolved',
      id: 'c9',
      outcome: 'rejected',
    });
  });

  it('pushes the real invocation description once per callId (R1-104)', async () => {
    let calls = 0;
    const sendMessageStream = vi.fn(function* (): Generator<{
      type: string;
      value?: unknown;
    }> {
      calls += 1;
      if (calls === 1) {
        yield {
          type: 'tool_call_request',
          value: {
            callId: 'd1',
            name: 'run_shell_command',
            args: { __invocationDesc: 'Running `npm test` in ./pkg' },
          },
        };
        return;
      }
      yield { type: 'finished', value: {} };
    });
    const config = createFakeConfig(sendMessageStream);

    const events = (await drain(
      livePromptEvents(config, 'run'),
    )) as OpenTuiStreamEvent[];

    // The fake scheduler reports the waiting call twice; the invocation
    // description rides the stream exactly once per callId (descriptionSeen
    // dedupe, ink mapToDisplay parity).
    const descs = events.filter((e) => e.type === 'tool-description');
    expect(descs).toEqual([
      {
        type: 'tool-description',
        id: 'd1',
        description: 'Running `npm test` in ./pkg',
      },
    ]);
  });

  it('relabels a deferred consultation with the scheduler-resolved Advisor', async () => {
    let calls = 0;
    const sendMessageStream = vi.fn(function* () {
      if (++calls === 1) {
        yield {
          type: 'tool_call_request',
          value: {
            callId: 'advisor-bridge',
            name: 'tool_call',
            args: {
              __resolvedName: 'advisor',
              __invocationDesc: 'advisor-model',
            },
          },
        };
        return;
      }
      yield { type: 'finished', value: {} };
    });
    const events = await drain(
      livePromptEvents(createFakeConfig(sendMessageStream), 'review'),
    );
    expect(events).toContainEqual({
      type: 'tool-start',
      id: 'advisor-bridge',
      tool: 'advisor',
      title: 'Advisor',
    });
  });

  it('emits no tool-description without an invocation (R1-104)', async () => {
    let calls = 0;
    const sendMessageStream = vi.fn(function* (): Generator<{
      type: string;
      value?: unknown;
    }> {
      calls += 1;
      if (calls === 1) {
        yield {
          type: 'tool_call_request',
          value: { callId: 'p1', name: 'run_shell_command', args: {} },
        };
        return;
      }
      yield { type: 'finished', value: {} };
    });
    const config = createFakeConfig(sendMessageStream);

    const events = (await drain(
      livePromptEvents(config, 'run'),
    )) as OpenTuiStreamEvent[];

    expect(events.some((e) => e.type === 'tool-description')).toBe(false);
  });

  it.each(['cancelled', 'error'])(
    'rejects a %s batch after draining UI-only terminal states without committing results',
    async (summary) => {
      const send = oneToolBatchStream({
        callId: 'revoked',
        name: 'test_tool',
        args: { __scheduleFailure: summary },
      });
      const recordToolResult = vi.fn();
      const config = {
        ...createFakeConfig(send),
        getChatRecordingService: () => ({ recordToolResult }),
      } as unknown as Config;
      const events: OpenTuiStreamEvent[] = [];
      const run = (async () => {
        for await (const event of livePromptEvents(config, 'run'))
          events.push(event);
      })();
      await expect(run).rejects.toThrow(
        summary === 'cancelled' ? 'Mod generation revoked' : 'Scheduler failed',
      );
      expect(events).toContainEqual({
        type: 'tool-end',
        id: 'revoked',
        success: false,
        summary,
      });
      expect(events).toContainEqual({
        type: 'tool-queued',
        id: 'revoked',
        queued: false,
      });
      expect(events).toContainEqual({
        type: 'confirm-resolved',
        id: 'revoked',
        outcome: 'rejected',
      });
      expect(events.some((event) => event.type === 'error')).toBe(false);
      expect(send).toHaveBeenCalledOnce();
      expect(config.getGeminiClient().addHistory).not.toHaveBeenCalled();
      expect(recordToolResult).not.toHaveBeenCalled();
    },
  );

  it('keeps the native queue open when schedule resolves before completion', async () => {
    const send = oneToolBatchStream({
      callId: 'deferred',
      name: 'test_tool',
      args: { __deferred: true },
    });
    let settled = false;
    const run = drain(livePromptEvents(createFakeConfig(send), 'run')).then(
      (events) => {
        settled = true;
        return events;
      },
    );
    await vi.waitFor(() => expect(schedulerControl.finish).not.toBeNull());
    expect(settled).toBe(false);
    expect(send).toHaveBeenCalledOnce();
    await schedulerControl.finish!();
    expect(await run).toContainEqual({
      type: 'tool-end',
      id: 'deferred',
      success: true,
      summary: 'ok',
    });
    expect(send).toHaveBeenCalledTimes(2);
  });

  it('ends the turn without a follow-up request when the whole batch was cancelled', async () => {
    const sendMessageStream = oneToolBatchStream({
      callId: 'c1',
      name: 'test_tool',
      args: { __cancelled: true },
    });
    const addHistory = vi.fn();
    const config = {
      ...createFakeConfig(sendMessageStream),
      getGeminiClient: () => ({
        sendMessageStream,
        addHistory,
        isInitialized: () => true,
        getChat: () => ({ getGenerationConfig: () => ({ tools: [] }) }),
      }),
    } as unknown as Config;

    await drain(livePromptEvents(config, 'run'));

    // ink use-llm-stream parity: cancelled responses go to history only,
    // so the model is never asked to continue the turn.
    expect(sendMessageStream).toHaveBeenCalledTimes(1);
    expect(addHistory).toHaveBeenCalledTimes(1);
    const content = addHistory.mock.calls[0][0] as {
      role: string;
      parts: Array<{ functionResponse?: { id?: string } }>;
    };
    expect(content.role).toBe('user');
    expect(content.parts.some((p) => p.functionResponse?.id === 'c1')).toBe(
      true,
    );
  });

  describe('tool execution live output (outputUpdateHandler)', () => {
    it('streams tool-output events while the tool executes', async () => {
      const sendMessageStream = oneToolBatchStream({
        callId: 't1',
        name: 'run_shell_command',
      });
      const config = createFakeConfig(sendMessageStream);

      const events = (await drain(
        livePromptEvents(config, 'run'),
      )) as OpenTuiStreamEvent[];

      const outputIdx = events.findIndex((e) => e.type === 'tool-output');
      expect(outputIdx).toBeGreaterThanOrEqual(0);
      expect(events[outputIdx]).toEqual({
        type: 'tool-output',
        id: 't1',
        output: 'live output\n',
      });
      // Live output arrives before the tool-end settlement.
      const endIdx = events.findIndex((e) => e.type === 'tool-end');
      expect(outputIdx).toBeLessThan(endIdx);
    });

    it('ignores shell_progress heartbeats', async () => {
      const sendMessageStream = oneToolBatchStream({
        callId: 't1',
        name: 'run_shell_command',
        args: { __liveChunks: [{ type: 'shell_progress', elapsedMs: 5 }] },
      });
      const config = createFakeConfig(sendMessageStream);

      const events = (await drain(
        livePromptEvents(config, 'run'),
      )) as OpenTuiStreamEvent[];

      expect(events.some((e) => e.type === 'tool-output')).toBe(false);
    });

    it('maps task_execution chunks to task card events', async () => {
      const running = {
        type: 'task_execution',
        subagentName: 'researcher',
        taskDescription: 'benchmark renders',
        status: 'running',
        toolCalls: [{ callId: 'x1', name: 'grep_search', status: 'executing' }],
      };
      const completed = {
        ...running,
        status: 'completed',
        toolCalls: [
          { callId: 'x1', name: 'grep_search', status: 'success' },
          {
            callId: 'x2',
            name: 'read_file',
            status: 'success',
            description: 'Read app.tsx',
          },
        ],
        executionSummary: {
          totalToolCalls: 2,
          totalDurationMs: 12400,
          totalTokens: 2100,
        },
      };
      const sendMessageStream = oneToolBatchStream({
        callId: 'agent1',
        name: 'agent',
        args: { __liveChunks: [running, completed] },
      });
      const config = createFakeConfig(sendMessageStream);

      const events = (await drain(
        livePromptEvents(config, 'delegate'),
      )) as OpenTuiStreamEvent[];

      expect(events).toContainEqual({
        type: 'task-start',
        id: 'agent1',
        name: 'researcher',
        description: 'benchmark renders',
      });
      expect(events).toContainEqual({
        type: 'task-progress',
        id: 'agent1',
        line: '↳ grep_search',
      });
      expect(events).toContainEqual({
        type: 'task-progress',
        id: 'agent1',
        line: '↳ Read app.tsx',
      });
      expect(events).toContainEqual({
        type: 'task-end',
        id: 'agent1',
      });
      // Progress for already-seen subagent tool calls is not repeated.
      expect(
        events.filter(
          (e) => e.type === 'task-progress' && e.line === '↳ grep_search',
        ),
      ).toHaveLength(1);
    });
  });
});

describe('approval-mode helpers', () => {
  it('cycles through the core order including PLAN', () => {
    expect(nextApprovalMode(ApprovalMode.PLAN)).toBe(ApprovalMode.DEFAULT);
    expect(nextApprovalMode(ApprovalMode.DEFAULT)).toBe(ApprovalMode.AUTO_EDIT);
    expect(nextApprovalMode(ApprovalMode.AUTO_EDIT)).toBe(ApprovalMode.AUTO);
    expect(nextApprovalMode(ApprovalMode.AUTO)).toBe(ApprovalMode.YOLO);
    expect(nextApprovalMode(ApprovalMode.YOLO)).toBe(ApprovalMode.PLAN);
    expect(nextApprovalMode(undefined)).toBe(ApprovalMode.AUTO_EDIT);
  });

  const waitingCall = (
    callId: string,
    name: string,
    extra?: Partial<{ hideAlwaysAllow: boolean }>,
  ): WaitingCallInfo => ({
    callId,
    name,
    confirmationDetails: {
      type: 'exec',
      title: name,
      command: 'ls',
      rootCommand: 'ls',
      onConfirm: async () => {},
      ...extra,
    } as ToolCallConfirmationDetails,
  });

  it('YOLO auto-approves every waiting call except hideAlwaysAllow', () => {
    const waiting = [
      waitingCall('a', 'run_shell_command'),
      waitingCall('b', 'ask_user_question'),
      waitingCall('c', 'edit', { hideAlwaysAllow: true }),
    ];
    const approved = selectAutoApprovals(ApprovalMode.YOLO, waiting);
    expect(approved.map((c) => c.callId)).toEqual(['a', 'b']);
  });

  it('AUTO_EDIT auto-approves only edit tools', () => {
    const waiting = [
      waitingCall('a', 'run_shell_command'),
      waitingCall('b', 'edit'),
      waitingCall('c', 'write_file'),
      waitingCall('d', 'notebook_edit'),
      waitingCall('e', 'replace'),
    ];
    const approved = selectAutoApprovals(ApprovalMode.AUTO_EDIT, waiting);
    expect(approved.map((c) => c.callId)).toEqual(['b', 'c', 'd', 'e']);
  });

  it('other mode switches auto-approve nothing', () => {
    const waiting = [waitingCall('a', 'edit')];
    expect(selectAutoApprovals(ApprovalMode.DEFAULT, waiting)).toEqual([]);
    expect(selectAutoApprovals(ApprovalMode.AUTO, waiting)).toEqual([]);
    expect(selectAutoApprovals(ApprovalMode.PLAN, waiting)).toEqual([]);
  });
});

describe('live checkpoint producer and approval ownership', () => {
  beforeEach(() => {
    resetPromptCountForTesting();
    atMocks.calls.length = 0;
    atMocks.result = { processedQuery: null, shouldProceed: true };
    atMocks.hang = null;
    atMocks.abortAfter = null;
    visionMocks.run.mockReset();
    modMocks.get.mockReset();
  });
  const deferred = () => {
    let resolve!: () => void;
    const promise = new Promise<void>((done) => {
      resolve = done;
    });
    return { promise, resolve };
  };

  async function scenario(options: {
    enabled?: boolean;
    clientInitiated?: boolean;
    port?: boolean;
    boundary?: 'mkdir' | 'write';
    invalidate?:
      | 'approval resolved'
      | 'same call reentered'
      | 'session changed'
      | 'turn changed'
      | 'aborted';
  }) {
    const directory = await mkdtemp(
      path.join(tmpdir(), 'qwen-live-checkpoint-'),
    );
    const abort = new AbortController();
    let session = 'session-1';
    let current = true;
    const stream = oneToolBatchStream({
      callId: 'edit-1',
      name: 'replace',
      args: { file_path: '/owned/a.ts', old_string: 'A', new_string: 'B' },
      ...{
        isClientInitiated: options.clientInitiated ?? false,
        prompt_id: 'session-1########0',
      },
    });
    const config = createFakeConfig(stream);
    const storageRead = vi.fn(() => directory);
    Object.assign(config, {
      getSessionId: () => session,
      getProjectRoot: () => directory,
      getFileCheckpointingEnabled: () => options.enabled !== false,
      storage: { getProjectTempCheckpointsDir: storageRead },
    });
    Object.assign(config.getGeminiClient(), {
      getHistoryShallow: () => [{ role: 'user', parts: [{ text: 'edit' }] }],
    });
    let items: readonly LiveHistoryItem[] = [];
    const observed: OpenTuiStreamEvent[] = [];
    const snapshot = vi.fn(() => {
      expect(observed.at(-1)?.type).toBe('confirm');
      const cards = items.filter((item) => item.kind === 'tool');
      expect(cards).toHaveLength(1);
      expect(cards[0].canonicalHistoryItem).toMatchObject({
        type: 'tool_group',
        tools: [
          {
            args: {
              file_path: '/owned/a.ts',
              old_string: 'A',
              new_string: 'B',
            },
          },
        ],
      });
      expect(cards[0].canonicalPending).toBe(true);
      return snapshotCanonicalHistory(
        items.filter((item) => !item.canonicalPending),
      );
    });
    const enteredWrite = deferred();
    const releaseWrite = deferred();
    checkpointControl.held = true;
    const expectedWrite =
      options.enabled !== false &&
      !options.clientInitiated &&
      options.port !== false;
    if (expectedWrite) {
      const atBoundary = async () => {
        enteredWrite.resolve();
        await releaseWrite.promise;
      };
      if (options.boundary === 'mkdir')
        checkpointControl.afterMkdir = atBoundary;
      else checkpointControl.afterWrite = atBoundary;
    }
    const gen = livePromptEvents(config, 'edit', abort.signal, {
      isCurrentTurn: () => current,
      ...(options.port === false
        ? {}
        : { checkpointHistory: { allocateId: () => -1, snapshot } }),
    });
    const fold = (event: OpenTuiStreamEvent) => {
      observed.push(event);
      items = foldLiveEvent(items, event);
    };
    let resumed: Promise<IteratorResult<OpenTuiStreamEvent>> | undefined;
    try {
      for (;;) {
        const step = await gen.next();
        expect(step.done).toBe(false);
        if (step.done) throw new Error('Scheduler never reached approval');
        fold(step.value);
        if (step.value.type === 'confirm') break;
      }
      // Exactly the real for-await contract: all prior source events and
      // confirm are folded before the generator resumes its writer.
      resumed = gen.next();
      if (expectedWrite) {
        checkpointControl.update?.('repeated');
        await Promise.race([
          enteredWrite.promise,
          resumed.then(() => {
            throw new Error(
              'Writer did not reach the actual async write boundary',
            );
          }),
        ]);
        switch (options.invalidate) {
          case 'approval resolved':
            checkpointControl.update?.('resolved');
            break;
          case 'same call reentered':
            checkpointControl.update?.('reentered');
            break;
          case 'session changed':
            session = 'session-2';
            break;
          case 'turn changed':
            current = false;
            break;
          case 'aborted':
            abort.abort();
            break;
          default:
            break;
        }
        releaseWrite.resolve();
      }
      // A no-write route can otherwise be waiting for the next scheduler event.
      if (!expectedWrite) checkpointControl.release?.();
      const next = await resumed;
      if (!next.done) fold(next.value);
      const filesBeforeCleanup = await readdir(directory);
      const json = filesBeforeCleanup.filter((name) => name.endsWith('.json'));
      if (
        options.enabled === false ||
        options.clientInitiated ||
        options.port === false
      ) {
        expect(snapshot).not.toHaveBeenCalled();
        expect(storageRead).not.toHaveBeenCalled();
        expect(filesBeforeCleanup).toEqual([]);
      } else if (
        options.invalidate &&
        options.invalidate !== 'approval resolved'
      ) {
        expect(snapshot).toHaveBeenCalledOnce();
        expect(filesBeforeCleanup).toEqual([]);
      } else {
        expect(snapshot).toHaveBeenCalledOnce();
        expect(json).toHaveLength(1);
        expect(
          JSON.parse(await readFile(path.join(directory, json[0]), 'utf8')),
        ).toMatchObject({
          history: [],
          toolCall: {
            name: 'replace',
            args: { old_string: 'A', new_string: 'B' },
          },
          promptId: 'session-1########0',
          filePath: '/owned/a.ts',
        });
      }
    } finally {
      releaseWrite.resolve();
      checkpointControl.afterWrite = null;
      checkpointControl.afterMkdir = null;
      checkpointControl.release?.();
      // Drain/return the same generator; never start a replacement attempt.
      if (resumed) await resumed.catch(() => {});
      await gen.return(undefined);
      checkpointControl.held = false;
      checkpointControl.update = null;
      await rm(directory, { recursive: true, force: true });
    }
  }

  it('captures after the actual queued tool source is folded', () =>
    scenario({}));
  it('does not read storage or capture when disabled', () =>
    scenario({ enabled: false }));
  it('does not checkpoint a client-initiated edit', () =>
    scenario({ clientInitiated: true }));
  it('keeps the pre-existing caller without a checkpoint port working', () =>
    scenario({ port: false }));
  it('retains the captured restore point when approval completes during the write', () =>
    scenario({ invalidate: 'approval resolved' }));
  it('does not publish when aborted while the real mkdir awaits', () =>
    scenario({ invalidate: 'aborted', boundary: 'mkdir' }));
  it.each([
    'same call reentered',
    'session changed',
    'turn changed',
    'aborted',
  ] as const)(
    'does not publish after async temporary write when %s',
    (invalidate) => scenario({ invalidate }),
  );
});
