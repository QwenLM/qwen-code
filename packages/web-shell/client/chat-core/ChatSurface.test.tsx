// @vitest-environment jsdom
/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import type {
  Message,
  PermissionRequest,
  TodoItem,
} from '../adapters/types.js';
import type { SessionChatController } from './contract.js';
import { regionsToCapabilities } from './capabilities.js';

const captured = vi.hoisted(() => ({
  transcript: undefined as Record<string, unknown> | undefined,
  approval: undefined as Record<string, unknown> | undefined,
  question: undefined as Record<string, unknown> | undefined,
  editor: undefined as Record<string, unknown> | undefined,
}));

vi.mock('../components/TranscriptViewport.js', () => ({
  TranscriptViewport: (props: Record<string, unknown>) => {
    captured.transcript = props;
    return <div data-testid="transcript-viewport" />;
  },
}));
vi.mock('../components/messages/ToolApproval.js', () => ({
  ToolApproval: (props: Record<string, unknown>) => {
    captured.approval = props;
    return <div data-testid="tool-approval" />;
  },
}));
vi.mock('../components/messages/AskUserQuestion.js', () => ({
  AskUserQuestion: (props: Record<string, unknown>) => {
    captured.question = props;
    return <div data-testid="ask-user-question" />;
  },
}));
vi.mock('../components/ChatEditor.js', () => ({
  ChatEditor: (props: Record<string, unknown>) => {
    captured.editor = props;
    return <div data-testid="chat-editor" />;
  },
}));
vi.mock('../i18n.js', () => ({
  useI18n: () => ({ t: (key: string) => `localized:${key}` }),
}));

import { ChatSurface } from './ChatSurface.js';
import { cleanupReact, mountReact } from '../test/reactHarness.js';

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

function permissionRequest(id: string): PermissionRequest {
  return {
    id,
    content: [],
    options: [
      { id: 'submit', label: 'Submit', kind: 'allow_once' },
      { id: 'cancel', label: 'Cancel', kind: 'reject_once' },
    ],
    rawInput: {},
  } as PermissionRequest;
}

function fakeController(
  overrides: Partial<SessionChatController> = {},
): SessionChatController {
  return {
    kind: 'daemon',
    sessionId: 's1',
    storageKey: 'draft:s1',
    operations: [],
    messages: [],
    transcriptState: 'ready',
    phase: 'idle',
    submit: vi.fn(async () => ({
      admission: 'accepted',
      target: { sessionId: 's1' },
    })),
    cancel: vi.fn(async () => ({
      admission: 'accepted',
      target: { sessionId: 's1' },
    })),
    pendingApprovals: [],
    pendingQuestions: [],
    respondApproval: vi.fn(async () => ({
      admission: 'accepted',
      target: { sessionId: 's1' },
    })),
    respondQuestion: vi.fn(async () => ({
      admission: 'accepted',
      target: { sessionId: 's1' },
    })),
    statusFacts: { queueLength: 0, goalActive: false },
    capabilities: regionsToCapabilities([]),
    ...overrides,
  } as SessionChatController;
}

type SubmitHandler = (
  text: string,
  images?: unknown,
  files?: unknown,
  commitAccepted?: () => void,
  metadata?: unknown,
) => boolean | undefined;
type QuestionConfirm = (
  id: string,
  optionId: string,
  answers?: Record<string, string>,
) => Promise<boolean>;
type ApprovalConfirm = (id: string, optionId: string) => Promise<void>;

beforeEach(() => {
  captured.transcript = undefined;
  captured.approval = undefined;
  captured.question = undefined;
  captured.editor = undefined;
});

afterEach(() => {
  cleanupReact();
});

describe('ChatSurface', () => {
  it('renders the transcript from the controller messages and session', () => {
    const messages = [{ id: 'm1' }] as unknown as Message[];
    const controller = fakeController({ messages });
    mountReact(<ChatSurface controller={controller} />);
    expect(captured.transcript?.messages).toEqual(messages);
    expect(captured.transcript?.sessionKey).toBe('s1');
    expect(captured.transcript?.pendingApproval).toBeNull();
    expect(captured.transcript?.loadingTranscript).toBe(false);
  });

  it('renders the transcript-error slot instead of the transcript when unavailable', () => {
    const controller = fakeController({ transcriptState: 'error' });
    const container = mountReact(
      <ChatSurface
        controller={controller}
        transcriptError={<div role="alert">gone</div>}
      />,
    );
    expect(captured.transcript).toBeUndefined();
    expect(container.querySelector('[role="alert"]')).not.toBeNull();
  });

  it('passes the first pending approval request, skipping superseded ones', () => {
    const superseded = {
      id: 'a0',
      status: 'superseded',
      request: permissionRequest('a0'),
    } as const;
    const pending = {
      id: 'a1',
      status: 'pending',
      request: permissionRequest('a1'),
    } as const;
    const controller = fakeController({
      pendingApprovals: [superseded, pending],
    });
    mountReact(<ChatSurface controller={controller} />);
    expect(captured.approval?.request).toBe(pending.request);
    expect(captured.transcript?.pendingApproval).toBe(pending.request);
  });

  it('routes ToolApproval confirmation to respondApproval', async () => {
    const request = permissionRequest('a1');
    const controller = fakeController({
      pendingApprovals: [{ id: 'a1', status: 'pending', request }],
    });
    mountReact(<ChatSurface controller={controller} />);
    const onConfirm = captured.approval?.onConfirm as ApprovalConfirm;
    await onConfirm('a1', 'submit');
    expect(controller.respondApproval).toHaveBeenCalledWith('a1', 'submit');
  });

  it('rejects the approval confirmation when the admission is not accepted', async () => {
    const request = permissionRequest('a1');
    const onError = vi.fn();
    const controller = fakeController({
      pendingApprovals: [{ id: 'a1', status: 'pending', request }],
      respondApproval: vi.fn(async () => ({
        admission: 'rejected',
        target: { sessionId: 's1' },
      })),
    });
    mountReact(<ChatSurface controller={controller} onError={onError} />);
    const onConfirm = captured.approval?.onConfirm as ApprovalConfirm;
    // ToolApproval re-arms only through rejection, so a non-accepted admission
    // must reject rather than resolve into a latched, inert card.
    await expect(onConfirm('a1', 'submit')).rejects.toThrow();
    expect(onError).toHaveBeenCalled();
    // The host sink displays error.message, so the localized copy must be the
    // Error's own message, not an English literal.
    expect((onError.mock.calls[0][0] as Error).message).toBe(
      'localized:chat.approvalNotAccepted',
    );
  });

  it('normalizes question answers and reports admission as the confirm boolean', async () => {
    const request = permissionRequest('q1');
    const controller = fakeController({
      pendingQuestions: [{ id: 'q1', request }],
    });
    mountReact(<ChatSurface controller={controller} />);
    const onConfirm = captured.question?.onConfirm as QuestionConfirm;
    const accepted = await onConfirm('q1', 'submit', { '0': 'Alice' });
    expect(controller.respondQuestion).toHaveBeenCalledWith('q1', [
      { questionId: '0', value: 'Alice' },
    ]);
    expect(controller.respondApproval).not.toHaveBeenCalled();
    expect(accepted).toBe(true);
  });

  it('routes the question reject option through respondApproval, not respondQuestion', async () => {
    const request = permissionRequest('q1');
    const controller = fakeController({
      pendingQuestions: [{ id: 'q1', request }],
    });
    mountReact(<ChatSurface controller={controller} />);
    const onConfirm = captured.question?.onConfirm as QuestionConfirm;
    const accepted = await onConfirm('q1', 'cancel', undefined);
    expect(controller.respondApproval).toHaveBeenCalledWith('q1', 'cancel');
    expect(controller.respondQuestion).not.toHaveBeenCalled();
    expect(accepted).toBe(true);
  });

  it('returns false from question confirm when the admission is rejected', async () => {
    const request = permissionRequest('q1');
    const controller = fakeController({
      pendingQuestions: [{ id: 'q1', request }],
      respondQuestion: vi.fn(async () => ({
        admission: 'rejected',
        target: { sessionId: 's1' },
      })),
    });
    mountReact(<ChatSurface controller={controller} />);
    const onConfirm = captured.question?.onConfirm as QuestionConfirm;
    expect(await onConfirm('q1', 'submit', {})).toBe(false);
  });

  it('defers the composer commit by returning false and clears the draft on admission', async () => {
    const controller = fakeController();
    mountReact(<ChatSurface controller={controller} />);
    const onSubmit = captured.editor?.onSubmit as SubmitHandler;
    const commitAccepted = vi.fn();
    let returned: boolean | undefined;
    await act(async () => {
      returned = onSubmit(
        'hello',
        undefined,
        undefined,
        commitAccepted,
        undefined,
      );
    });
    // Only the literal false defers useComposerCore's synchronous commit; the
    // draft is then cleared on admission (the fake transport resolves at once).
    expect(returned).toBe(false);
    await vi.waitFor(() => expect(commitAccepted).toHaveBeenCalled());
    expect(controller.submit).toHaveBeenCalledWith({
      text: 'hello',
      images: undefined,
      files: undefined,
      metadata: undefined,
    });
  });

  it('forwards the submit payload images, files, and metadata to the controller', async () => {
    const controller = fakeController();
    mountReact(<ChatSurface controller={controller} />);
    const onSubmit = captured.editor?.onSubmit as SubmitHandler;
    const images = [{ data: 'aW1n', media_type: 'image/png' }];
    const files = [{ name: 'a.ts', media_type: 'text/plain' }];
    const metadata = { inputAnnotations: [] };
    await act(async () => {
      onSubmit('hello', images, files, vi.fn(), metadata);
    });
    await vi.waitFor(() => expect(controller.submit).toHaveBeenCalled());
    // Dropping any of the three payload fields at the surface must turn this red.
    expect(controller.submit).toHaveBeenCalledWith({
      text: 'hello',
      images,
      files,
      metadata,
    });
  });

  it('does not clear the draft when the submit admission is rejected', async () => {
    const controller = fakeController({
      submit: vi.fn(async () => ({
        admission: 'rejected',
        target: { sessionId: 's1' },
      })),
    });
    mountReact(<ChatSurface controller={controller} />);
    const onSubmit = captured.editor?.onSubmit as SubmitHandler;
    const commitAccepted = vi.fn();
    let returned: boolean | undefined;
    await act(async () => {
      returned = onSubmit(
        'hello',
        undefined,
        undefined,
        commitAccepted,
        undefined,
      );
    });
    expect(returned).toBe(false);
    await vi.waitFor(() => expect(controller.submit).toHaveBeenCalled());
    expect(commitAccepted).not.toHaveBeenCalled();
  });

  it('routes the composer cancel to the controller', () => {
    const controller = fakeController();
    mountReact(<ChatSurface controller={controller} />);
    const onCancel = captured.editor?.onCancel as () => void;
    onCancel();
    expect(controller.cancel).toHaveBeenCalled();
  });

  it('reports a non-accepted stop admission instead of failing silent', async () => {
    const onError = vi.fn();
    const controller = fakeController({
      cancel: vi.fn(async () => ({
        admission: 'unknown',
        target: { sessionId: 's1' },
      })),
    });
    mountReact(<ChatSurface controller={controller} onError={onError} />);
    const onCancel = captured.editor?.onCancel as () => void;
    await act(async () => {
      onCancel();
    });
    await vi.waitFor(() => expect(onError).toHaveBeenCalled());
    expect((onError.mock.calls[0][0] as Error).message).toBe(
      'localized:chat.stopNotConfirmed',
    );
  });

  it('reports a rejected stop admission, not only an unknown one', async () => {
    const onError = vi.fn();
    const controller = fakeController({
      cancel: vi.fn(async () => ({
        admission: 'rejected',
        target: { sessionId: 's1' },
      })),
    });
    mountReact(<ChatSurface controller={controller} onError={onError} />);
    const onCancel = captured.editor?.onCancel as () => void;
    await act(async () => {
      onCancel();
    });
    await vi.waitFor(() => expect(onError).toHaveBeenCalled());
    expect((onError.mock.calls[0][0] as Error).message).toBe(
      'localized:chat.stopNotConfirmed',
    );
  });

  it('preserves the transport cause when a stop throws', async () => {
    const onError = vi.fn();
    const boom = new Error('cancel transport down');
    const controller = fakeController({
      cancel: vi.fn(async () => {
        throw boom;
      }),
    });
    mountReact(<ChatSurface controller={controller} onError={onError} />);
    const onCancel = captured.editor?.onCancel as () => void;
    await act(async () => {
      onCancel();
    });
    await vi.waitFor(() => expect(onError).toHaveBeenCalled());
    const reported = onError.mock.calls[0][0] as Error;
    expect(reported.message).toBe('localized:chat.stopNotConfirmed');
    expect(reported.cause).toBe(boom);
  });

  it('does not report on an accepted stop', async () => {
    const onError = vi.fn();
    const controller = fakeController({
      cancel: vi.fn(async () => ({
        admission: 'accepted',
        target: { sessionId: 's1' },
      })),
    });
    mountReact(<ChatSurface controller={controller} onError={onError} />);
    const onCancel = captured.editor?.onCancel as () => void;
    await act(async () => {
      onCancel();
    });
    // Let any erroneous report settle before asserting silence, so a change that
    // reports on every cancel settlement turns this red.
    await act(async () => {
      await Promise.resolve();
    });
    expect(onError).not.toHaveBeenCalled();
  });

  it('keeps the running affordance while submitting, running, or cancelling', () => {
    for (const phase of ['submitting', 'running', 'cancelling'] as const) {
      const controller = fakeController({ phase });
      mountReact(<ChatSurface controller={controller} />);
      expect(captured.editor?.isRunning).toBe(true);
      expect(captured.transcript?.isResponding).toBe(true);
      cleanupReact();
    }
    const idle = fakeController({ phase: 'idle' });
    mountReact(<ChatSurface controller={idle} />);
    expect(captured.editor?.isRunning).toBe(false);
    expect(captured.transcript?.isResponding).toBe(false);
  });

  it('renders distinct in-flow cards and yields the composer when both decision kinds are pending', () => {
    const controller = fakeController({
      pendingApprovals: [
        { id: 'a1', status: 'pending', request: permissionRequest('a1') },
      ],
      pendingQuestions: [{ id: 'q1', request: permissionRequest('q1') }],
    });
    const container = mountReact(<ChatSurface controller={controller} />);
    expect(
      container.querySelectorAll('[data-testid="approval-overlay"]'),
    ).toHaveLength(1);
    expect(
      container.querySelectorAll('[data-testid="question-overlay"]'),
    ).toHaveLength(1);
    expect(captured.editor?.dialogOpen).toBe(true);
    expect(captured.transcript?.approvalOverlayActive).toBe(true);
    // Both decision cards render as floating variants; dropping either forward
    // must turn this red.
    expect(captured.approval?.variant).toBe('floating');
    expect(captured.question?.variant).toBe('floating');
    // Visibility comes solely from composerHidden (dialogOpen hides nothing),
    // so pin the positive class, not just dialogOpen.
    const composerWrap = container.querySelector(
      '[data-testid="chat-editor"]',
    )?.parentElement;
    expect(composerWrap?.className).toContain('composerHidden');
  });

  it('threads the plan facts and focus/notification gating to the approval card', () => {
    const planTodos = [{ content: 'task' }] as unknown as TodoItem[];
    const controller = fakeController({
      pendingApprovals: [
        { id: 'a1', status: 'pending', request: permissionRequest('a1') },
      ],
    });
    const generateContent = vi.fn();
    mountReact(
      <ChatSurface
        controller={controller}
        planTodos={planTodos}
        planExecutionMode="default"
        approvalDisabled
        approvalKeyboardActive={false}
        showBrowserNotifications
        generateContent={generateContent}
      />,
    );
    expect(captured.approval?.planTodos).toBe(planTodos);
    expect(captured.approval?.planExecutionMode).toBe('default');
    expect(captured.approval?.disabled).toBe(true);
    expect(captured.approval?.keyboardActive).toBe(false);
    expect(captured.approval?.showBrowserNotifications).toBe(true);
    // The exec-command explain action is only reachable with a generator.
    expect(captured.approval?.generateContent).toBe(generateContent);
    expect(captured.question).toBeUndefined();
  });

  it('forwards history pagination to the transcript', async () => {
    const loadOlder = vi.fn(async () => {});
    const controller = fakeController({ loadOlder });
    mountReact(<ChatSurface controller={controller} hasOlderHistory />);
    expect(captured.transcript?.hasOlderHistory).toBe(true);
    const onLoadOlderHistory = captured.transcript
      ?.onLoadOlderHistory as (options?: { force?: boolean }) => Promise<void>;
    await onLoadOlderHistory();
    expect(loadOlder).toHaveBeenCalled();
  });

  it('defaults the error sink to an observable report', () => {
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const controller = fakeController({
      pendingQuestions: [{ id: 'q1', request: permissionRequest('q1') }],
    });
    mountReact(<ChatSurface controller={controller} />);
    const onError = captured.question?.onError as (
      error: unknown,
      fallback: string,
    ) => void;
    onError(new Error('boom'), 'Question failed');
    expect(spy).toHaveBeenCalledWith('Question failed', expect.any(Error));
    spy.mockRestore();
  });

  it('renders the header, panel, and composer-status slots', () => {
    const controller = fakeController();
    const container = mountReact(
      <ChatSurface
        controller={controller}
        header={<div data-testid="header-slot" />}
        panels={<div data-testid="panel-slot" />}
        composerStatus={<div data-testid="status-slot" />}
      />,
    );
    expect(
      container.querySelector('[data-testid="header-slot"]'),
    ).not.toBeNull();
    expect(
      container.querySelector('[data-testid="panel-slot"]'),
    ).not.toBeNull();
    expect(
      container.querySelector('[data-testid="status-slot"]'),
    ).not.toBeNull();
  });

  it('reports an unknown submit admission and keeps the draft', async () => {
    const onError = vi.fn();
    const controller = fakeController({
      submit: vi.fn(async () => ({
        admission: 'unknown',
        target: { sessionId: 's1' },
      })),
    });
    const container = mountReact(
      <ChatSurface controller={controller} onError={onError} />,
    );
    const onSubmit = captured.editor?.onSubmit as SubmitHandler;
    const commitAccepted = vi.fn();
    await act(async () => {
      onSubmit('hello', undefined, undefined, commitAccepted, undefined);
    });
    await vi.waitFor(() => expect(onError).toHaveBeenCalled());
    expect(commitAccepted).not.toHaveBeenCalled();
    // The reported Error is built from the localized string, not an English
    // literal, because the host sink displays error.message.
    expect((onError.mock.calls[0][0] as Error).message).toBe(
      'localized:chat.promptNotConfirmed',
    );
    // Delivery is uncertain: the payload stays locked (draft kept, every submit
    // path rejected) so a resend cannot duplicate a turn the daemon may run.
    expect(captured.editor?.submitDisabled).toBe(true);
    await act(async () => {
      onSubmit('hello', undefined, undefined, vi.fn(), undefined);
    });
    expect(controller.submit).toHaveBeenCalledTimes(1);
    // Only an explicit acknowledgement unlocks the payload.
    const banner = container.querySelector(
      '[data-testid="admission-locked-banner"]',
    );
    expect(banner).not.toBeNull();
    await act(async () => {
      banner?.querySelector('button')?.click();
    });
    expect(captured.editor?.submitDisabled).toBe(false);
    // The ref half of the lock must clear too: a following submit must reach the
    // controller. submitDisabled alone is state-driven and would stay green with
    // the ref-clear line deleted.
    await act(async () => {
      onSubmit('hello', undefined, undefined, vi.fn(), undefined);
    });
    expect(controller.submit).toHaveBeenCalledTimes(2);
  });

  it('reports a rejected submit admission and keeps the draft', async () => {
    const onError = vi.fn();
    const controller = fakeController({
      submit: vi.fn(async () => ({
        admission: 'rejected',
        target: { sessionId: 's1' },
      })),
    });
    mountReact(<ChatSurface controller={controller} onError={onError} />);
    const onSubmit = captured.editor?.onSubmit as SubmitHandler;
    const commitAccepted = vi.fn();
    await act(async () => {
      onSubmit('hello', undefined, undefined, commitAccepted, undefined);
    });
    await vi.waitFor(() => expect(onError).toHaveBeenCalled());
    expect(commitAccepted).not.toHaveBeenCalled();
    expect((onError.mock.calls[0][0] as Error).message).toBe(
      'localized:chat.promptNotAdmitted',
    );
    // A rejected submit must not arm the admission lock: the composer stays
    // dispatchable so the user can edit and retry. Arming the lock on any
    // non-accepted result must turn this red.
    await act(async () => {
      await Promise.resolve();
    });
    expect(captured.editor?.submitDisabled).toBe(false);
  });

  it('reports a submit transport rejection without wiping the draft', async () => {
    const onError = vi.fn();
    const boom = new Error('network');
    const controller = fakeController({
      submit: vi.fn(async () => {
        throw boom;
      }),
    });
    mountReact(<ChatSurface controller={controller} onError={onError} />);
    const onSubmit = captured.editor?.onSubmit as SubmitHandler;
    const commitAccepted = vi.fn();
    await act(async () => {
      onSubmit('hello', undefined, undefined, commitAccepted, undefined);
    });
    await vi.waitFor(() => expect(onError).toHaveBeenCalled());
    expect(commitAccepted).not.toHaveBeenCalled();
    // The localized text must be the Error's own message (the host sink displays
    // error.message), with the raw transport error preserved as the cause.
    const reported = onError.mock.calls[0][0] as Error;
    expect(reported.message).toBe('localized:chat.failedToSend');
    expect(reported.cause).toBe(boom);
  });

  it('blocks a repeat send while a submit is in flight', () => {
    const submitting = fakeController({ phase: 'submitting' });
    mountReact(<ChatSurface controller={submitting} />);
    expect(captured.editor?.submitDisabled).toBe(true);
    cleanupReact();
    // Mid-turn sends must stay allowed (ChatPane does not disable send while
    // streaming), so only 'submitting' arms the phase guard.
    for (const phase of ['idle', 'running', 'cancelling'] as const) {
      const controller = fakeController({ phase });
      mountReact(<ChatSurface controller={controller} />);
      expect(captured.editor?.submitDisabled).toBe(false);
      cleanupReact();
    }
  });

  it('latches an in-flight submit even when the phase never re-renders', async () => {
    let resolveSubmit: ((value: { admission: string }) => void) | undefined;
    const submit = vi.fn(
      () =>
        new Promise<{ admission: string }>((resolve) => {
          resolveSubmit = resolve;
        }),
    );
    // phase stays 'idle': no optimistic echo, no reactive re-render.
    const controller = fakeController({ phase: 'idle', submit });
    mountReact(<ChatSurface controller={controller} />);
    const onSubmit = captured.editor?.onSubmit as SubmitHandler;
    await act(async () => {
      onSubmit('hello', undefined, undefined, vi.fn(), undefined);
      onSubmit('hello', undefined, undefined, vi.fn(), undefined);
    });
    expect(submit).toHaveBeenCalledTimes(1);
    expect(captured.editor?.submitDisabled).toBe(true);
    await act(async () => {
      resolveSubmit?.({ admission: 'accepted' });
    });
    expect(captured.editor?.submitDisabled).toBe(false);
    // The latch re-arms after settlement: a later submit must dispatch again.
    // submitDisabled is state-driven, so only the dispatch count observes the
    // ref reset in .finally.
    await act(async () => {
      onSubmit('again', undefined, undefined, vi.fn(), undefined);
    });
    expect(submit).toHaveBeenCalledTimes(2);
  });

  it('returns undefined for commit-less submit entrances so they clear synchronously', async () => {
    const controller = fakeController();
    mountReact(<ChatSurface controller={controller} />);
    const onSubmit = captured.editor?.onSubmit as SubmitHandler;
    let returned: boolean | undefined;
    await act(async () => {
      returned = onSubmit('hello', undefined, undefined);
    });
    expect(returned).not.toBe(false);
    expect(returned).toBeUndefined();
    await vi.waitFor(() => expect(controller.submit).toHaveBeenCalled());
  });

  it('blocks submit while the transcript is loading or the page blocks writes', () => {
    const loading = fakeController({ transcriptState: 'loading' });
    mountReact(<ChatSurface controller={loading} />);
    expect(captured.editor?.submitDisabled).toBe(true);
    cleanupReact();
    const blocked = fakeController();
    mountReact(<ChatSurface controller={blocked} composerSubmitBlocked />);
    expect(captured.editor?.submitDisabled).toBe(true);
  });

  it('leaves the composer visible and ungated when nothing is pending', () => {
    const controller = fakeController();
    const container = mountReact(<ChatSurface controller={controller} />);
    expect(captured.editor?.dialogOpen).toBe(false);
    expect(captured.transcript?.approvalOverlayActive).toBe(false);
    const composerWrap = container.querySelector(
      '[data-testid="chat-editor"]',
    )?.parentElement;
    expect(composerWrap?.className).not.toContain('composerHidden');
  });

  it('prefers an explicit onLoadOlderHistory override over the controller capability', async () => {
    const loadOlder = vi.fn(async () => {});
    const override = vi.fn(async () => {});
    const controller = fakeController({ loadOlder });
    mountReact(
      <ChatSurface controller={controller} onLoadOlderHistory={override} />,
    );
    const onLoadOlderHistory = captured.transcript
      ?.onLoadOlderHistory as (options?: { force?: boolean }) => Promise<void>;
    await onLoadOlderHistory();
    expect(override).toHaveBeenCalled();
    expect(loadOlder).not.toHaveBeenCalled();
  });

  it('returns false when the question reject vote is not accepted', async () => {
    const request = permissionRequest('q1');
    const controller = fakeController({
      pendingQuestions: [{ id: 'q1', request }],
      respondApproval: vi.fn(async () => ({
        admission: 'rejected',
        target: { sessionId: 's1' },
      })),
    });
    mountReact(<ChatSurface controller={controller} />);
    const onConfirm = captured.question?.onConfirm as QuestionConfirm;
    expect(await onConfirm('q1', 'cancel', undefined)).toBe(false);
  });

  it('threads keyboard focus gating to the question card', () => {
    const controller = fakeController({
      pendingQuestions: [{ id: 'q1', request: permissionRequest('q1') }],
    });
    mountReact(
      <ChatSurface controller={controller} approvalKeyboardActive={false} />,
    );
    expect(captured.question?.keyboardActive).toBe(false);
  });

  it('forwards the question free-text label and details escape hatch', () => {
    const askUserDetails = vi.fn();
    const controller = fakeController({
      pendingQuestions: [{ id: 'q1', request: permissionRequest('q1') }],
    });
    mountReact(
      <ChatSurface
        controller={controller}
        askUserFreeTextLabel="Custom other"
        askUserDetails={askUserDetails}
      />,
    );
    expect(captured.question?.customInputLabel).toBe('Custom other');
    expect(captured.question?.onAskDetails).toBe(askUserDetails);
  });

  it('forwards the history pagination error flag', () => {
    const controller = fakeController();
    mountReact(<ChatSurface controller={controller} historyPaginationError />);
    expect(captured.transcript?.historyPaginationError).toBe(true);
  });

  it('forwards the older-history spinner and capacity facts to the transcript', () => {
    const controller = fakeController();
    mountReact(
      <ChatSurface
        controller={controller}
        loadingOlderHistory
        historyCapacityReached
      />,
    );
    expect(captured.transcript?.loadingOlderHistory).toBe(true);
    expect(captured.transcript?.historyCapacityReached).toBe(true);
  });

  it('forwards the composer draft scope for a new chat', () => {
    const controller = fakeController({ sessionId: '' });
    mountReact(
      <ChatSurface
        controller={controller}
        atWorkspaceCwd="/w"
        composerScopeKey="standalone"
      />,
    );
    expect(captured.editor?.atWorkspaceCwd).toBe('/w');
    expect(captured.editor?.composerScopeKey).toBe('standalone');
  });
});
