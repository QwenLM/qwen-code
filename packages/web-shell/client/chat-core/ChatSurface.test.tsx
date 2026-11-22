// @vitest-environment jsdom
/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, startTransition, Suspense, useState } from 'react';
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
import {
  cleanupReact,
  mountReact,
  rerenderReact,
} from '../test/reactHarness.js';

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

  it('defaults history pagination facts to the controller while letting page props override them', () => {
    // Light one controller pagination fact at a time so every per-field
    // fallback is distinguished from its siblings (kills cross-wiring).
    const keys = [
      'hasOlderHistory',
      'loadingOlderHistory',
      'historyCapacityReached',
      'historyPaginationError',
    ] as const;
    for (let i = 0; i < keys.length; i++) {
      const controller = fakeController({
        hasOlderHistory: i === 0,
        loadingOlderHistory: i === 1,
        historyCapacityReached: i === 2,
        historyPaginationError: i === 3,
      });
      mountReact(<ChatSurface controller={controller} />);
      expect([
        captured.transcript?.hasOlderHistory,
        captured.transcript?.loadingOlderHistory,
        captured.transcript?.historyCapacityReached,
        captured.transcript?.historyPaginationError,
      ]).toEqual(keys.map((_, j) => i === j));
      cleanupReact();
    }
    // Explicit false page props must override true controller facts (pins ??
    // against || on all four pagination flags).
    const allTrue = fakeController({
      hasOlderHistory: true,
      loadingOlderHistory: true,
      historyCapacityReached: true,
      historyPaginationError: true,
    });
    const container = mountReact(<ChatSurface controller={allTrue} />);
    expect([
      captured.transcript?.hasOlderHistory,
      captured.transcript?.loadingOlderHistory,
      captured.transcript?.historyCapacityReached,
      captured.transcript?.historyPaginationError,
    ]).toEqual([true, true, true, true]);
    rerenderReact(
      container,
      <ChatSurface
        controller={allTrue}
        hasOlderHistory={false}
        loadingOlderHistory={false}
        historyCapacityReached={false}
        historyPaginationError={false}
      />,
    );
    expect([
      captured.transcript?.hasOlderHistory,
      captured.transcript?.loadingOlderHistory,
      captured.transcript?.historyCapacityReached,
      captured.transcript?.historyPaginationError,
    ]).toEqual([false, false, false, false]);
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

  it('clears the admission lock on a session switch, including out of a locked new chat', async () => {
    const onError = vi.fn();
    // Start in an unallocated new chat ('') whose submit settles unknown, then
    // sidebar-switch to an existing session ('s2') while no submit is in flight.
    // An unconditional '' -> id exception would wrongly carry the lock into s2.
    const first = fakeController({
      sessionId: '',
      submit: vi.fn(async () => ({
        admission: 'unknown',
        target: { sessionId: '' },
      })),
    });
    const container = mountReact(
      <ChatSurface controller={first} onError={onError} />,
    );
    await act(async () => {
      (captured.editor?.onSubmit as SubmitHandler)(
        'hello',
        undefined,
        undefined,
        vi.fn(),
        undefined,
      );
    });
    await vi.waitFor(() => expect(captured.editor?.submitDisabled).toBe(true));
    expect(
      container.querySelector('[data-testid="admission-locked-banner"]'),
    ).not.toBeNull();
    const second = fakeController({ sessionId: 's2' });
    rerenderReact(
      container,
      <ChatSurface controller={second} onError={onError} />,
    );
    expect(captured.editor?.submitDisabled).toBe(false);
    expect(
      container.querySelector('[data-testid="admission-locked-banner"]'),
    ).toBeNull();
    // The ref half must clear too: a submit in the new session must dispatch.
    await act(async () => {
      (captured.editor?.onSubmit as SubmitHandler)(
        'hi',
        undefined,
        undefined,
        vi.fn(),
        undefined,
      );
    });
    expect(second.submit).toHaveBeenCalledTimes(1);
    // An unallocated '' new chat has no durable session id and must never be
    // parked: returning to a brand-new '' chat renders clean and unlocked
    // (parking '' on switch-out turns this red — M7 / cell P4).
    const freshNewChat = fakeController({ sessionId: '' });
    rerenderReact(
      container,
      <ChatSurface controller={freshNewChat} onError={onError} />,
    );
    expect(captured.editor?.submitDisabled).toBe(false);
    expect(
      container.querySelector('[data-testid="admission-locked-banner"]'),
    ).toBeNull();
  });

  it('clears the in-flight latch when switching from an unallocated new chat to an existing session mid-submit', async () => {
    let resolveFirst: ((value: { admission: string }) => void) | undefined;
    const first = fakeController({
      sessionId: '',
      submit: vi.fn(
        () =>
          new Promise<{ admission: string }>((resolve) => {
            resolveFirst = resolve;
          }),
      ),
    });
    const onError = vi.fn();
    const container = mountReact(
      <ChatSurface controller={first} onError={onError} />,
    );
    const firstCommit = vi.fn();
    await act(async () => {
      (captured.editor?.onSubmit as SubmitHandler)(
        'hello',
        undefined,
        undefined,
        firstCommit,
        undefined,
      );
    });
    expect(captured.editor?.submitDisabled).toBe(true);
    // The user clicks an existing session ('s2') in the sidebar while the new
    // chat's first submit is still in flight: the latch must clear and the
    // owner token must rotate. Treating an in-flight '' -> id change as an
    // allocation turns this red (verify-pr F1 / cell C4).
    const existing = fakeController({ sessionId: 's2' });
    rerenderReact(
      container,
      <ChatSurface controller={existing} onError={onError} />,
    );
    expect(captured.editor?.submitDisabled).toBe(false);
    await act(async () => {
      resolveFirst?.({ admission: 'unknown' });
    });
    expect(captured.editor?.submitDisabled).toBe(false);
    expect(
      container.querySelector('[data-testid="admission-locked-banner"]'),
    ).toBeNull();
    expect(firstCommit).not.toHaveBeenCalled();
    expect(onError).not.toHaveBeenCalled();
  });

  it('clears the in-flight latch on a session switch and ignores the abandoned settlement', async () => {
    let resolveFirst: ((value: { admission: string }) => void) | undefined;
    const first = fakeController({
      sessionId: 's1',
      submit: vi.fn(
        () =>
          new Promise<{ admission: string }>((resolve) => {
            resolveFirst = resolve;
          }),
      ),
    });
    const onError = vi.fn();
    const container = mountReact(
      <ChatSurface controller={first} onError={onError} />,
    );
    const firstCommit = vi.fn();
    await act(async () => {
      (captured.editor?.onSubmit as SubmitHandler)(
        'hello',
        undefined,
        undefined,
        firstCommit,
        undefined,
      );
    });
    expect(captured.editor?.submitDisabled).toBe(true);
    // Switch to s2 while s1's submit is still in flight: the latch clears
    // immediately (both state and ref halves), so s2 can dispatch its own
    // in-flight submit.
    let resolveSecond: ((value: { admission: string }) => void) | undefined;
    const second = fakeController({
      sessionId: 's2',
      submit: vi.fn(
        () =>
          new Promise<{ admission: string }>((resolve) => {
            resolveSecond = resolve;
          }),
      ),
    });
    rerenderReact(
      container,
      <ChatSurface controller={second} onError={onError} />,
    );
    expect(captured.editor?.submitDisabled).toBe(false);
    await act(async () => {
      (captured.editor?.onSubmit as SubmitHandler)(
        's2 prompt',
        undefined,
        undefined,
        vi.fn(),
        undefined,
      );
    });
    // Deleting submitInFlightRef.current reset leaves s2's ref gate armed so
    // this call count would be 0 (R1-5).
    expect(second.submit).toHaveBeenCalledTimes(1);
    expect(captured.editor?.submitDisabled).toBe(true);
    // s1's abandoned submit now settles as 'unknown': without the owner token
    // in .then and .finally, its callback would lock s2's composer, report an
    // error on s2, or clear s2's own in-flight latch so a second send in s2
    // would slip through (R1-5).
    await act(async () => {
      resolveFirst?.({ admission: 'unknown' });
    });
    expect(captured.editor?.submitDisabled).toBe(true);
    await act(async () => {
      (captured.editor?.onSubmit as SubmitHandler)(
        's2 duplicate',
        undefined,
        undefined,
        vi.fn(),
        undefined,
      );
    });
    expect(second.submit).toHaveBeenCalledTimes(1);
    expect(
      container.querySelector('[data-testid="admission-locked-banner"]'),
    ).toBeNull();
    expect(firstCommit).not.toHaveBeenCalled();
    expect(onError).not.toHaveBeenCalled();
    await act(async () => {
      resolveSecond?.({ admission: 'accepted' });
    });
  });

  it('commits the submitting session draft on accepted settlement after a switch and ignores a rejected settlement', async () => {
    let resolveFirst: ((value: { admission: string }) => void) | undefined;
    const first = fakeController({
      sessionId: 's1',
      submit: vi.fn(
        () =>
          new Promise<{ admission: string }>((resolve) => {
            resolveFirst = resolve;
          }),
      ),
    });
    const onError = vi.fn();
    const container = mountReact(
      <ChatSurface controller={first} onError={onError} />,
    );
    const firstCommit = vi.fn();
    await act(async () => {
      (captured.editor?.onSubmit as SubmitHandler)(
        'hello',
        undefined,
        undefined,
        firstCommit,
        undefined,
      );
    });
    let rejectSecond: ((reason: unknown) => void) | undefined;
    const second = fakeController({
      sessionId: 's2',
      submit: vi.fn(
        () =>
          new Promise<{ admission: string }>((_resolve, reject) => {
            rejectSecond = reject;
          }),
      ),
    });
    rerenderReact(
      container,
      <ChatSurface controller={second} onError={onError} />,
    );
    // R1-3: s1's accepted settlement must still invoke s1's identity-scoped
    // commitAccepted callback while leaving s2 untouched.
    await act(async () => {
      resolveFirst?.({ admission: 'accepted' });
    });
    expect(firstCommit).toHaveBeenCalledTimes(1);
    expect(captured.editor?.submitDisabled).toBe(false);
    expect(onError).not.toHaveBeenCalled();
    // Start a submit in s2, switch to s3, and reject s2's submit: the .catch
    // token guard must keep s3 silent (R1-5).
    await act(async () => {
      (captured.editor?.onSubmit as SubmitHandler)(
        's2 will throw',
        undefined,
        undefined,
        vi.fn(),
        undefined,
      );
    });
    const third = fakeController({ sessionId: 's3' });
    rerenderReact(
      container,
      <ChatSurface controller={third} onError={onError} />,
    );
    await act(async () => {
      rejectSecond?.(new Error('network lost'));
    });
    expect(onError).not.toHaveBeenCalled();
  });

  it('parks and restores both the admission lock and an in-flight submit across a session round-trip (R1-4)', async () => {
    const onError = vi.fn();
    const s1Locked = fakeController({
      sessionId: 's1',
      submit: vi.fn(async () => ({
        admission: 'unknown',
        target: { sessionId: 's1' },
      })),
    });
    const container = mountReact(
      <ChatSurface controller={s1Locked} onError={onError} />,
    );
    await act(async () => {
      (captured.editor?.onSubmit as SubmitHandler)(
        'hello',
        undefined,
        undefined,
        vi.fn(),
        undefined,
      );
    });
    await vi.waitFor(() => expect(captured.editor?.submitDisabled).toBe(true));
    expect(
      container.querySelector('[data-testid="admission-locked-banner"]'),
    ).not.toBeNull();
    // Switch to s2: s2 is unlocked and shows no banner.
    let resolveS2: ((value: { admission: string }) => void) | undefined;
    const s2 = fakeController({
      sessionId: 's2',
      submit: vi.fn(
        () =>
          new Promise<{ admission: string }>((resolve) => {
            resolveS2 = resolve;
          }),
      ),
    });
    rerenderReact(container, <ChatSurface controller={s2} onError={onError} />);
    expect(captured.editor?.submitDisabled).toBe(false);
    expect(
      container.querySelector('[data-testid="admission-locked-banner"]'),
    ).toBeNull();
    // Start an in-flight submit in s2, then round-trip s2 -> s1 -> s2.
    const s2Commit = vi.fn();
    await act(async () => {
      (captured.editor?.onSubmit as SubmitHandler)(
        'in s2',
        undefined,
        undefined,
        s2Commit,
        undefined,
      );
    });
    expect(captured.editor?.submitDisabled).toBe(true);
    // Back in s1: s1's parked unknown-admission lock and banner are restored.
    rerenderReact(
      container,
      <ChatSurface controller={s1Locked} onError={onError} />,
    );
    expect(captured.editor?.submitDisabled).toBe(true);
    expect(
      container.querySelector('[data-testid="admission-locked-banner"]'),
    ).not.toBeNull();
    // Back in s2 while s2's submit is still pending: s2's in-flight latch and
    // owner token are restored, so a duplicate send in s2 is refused and the
    // pending settlement still commits.
    rerenderReact(container, <ChatSurface controller={s2} onError={onError} />);
    expect(captured.editor?.submitDisabled).toBe(true);
    await act(async () => {
      (captured.editor?.onSubmit as SubmitHandler)(
        'duplicate in s2',
        undefined,
        undefined,
        vi.fn(),
        undefined,
      );
    });
    expect(s2.submit).toHaveBeenCalledTimes(1);
    await act(async () => {
      resolveS2?.({ admission: 'accepted' });
    });
    expect(s2Commit).toHaveBeenCalledTimes(1);
    expect(captured.editor?.submitDisabled).toBe(false);
    // N3 / M6 / cell P2: start another in-flight submit in s2, switch to s3 so
    // s2 is parked, settle s2's submit as 'unknown' while s3 is visible, then
    // return to s2 — the parked entry must have recorded admissionLocked = true
    // so s2 restores the banner and lock (and acknowledging clears it durably).
    await act(async () => {
      (captured.editor?.onSubmit as SubmitHandler)(
        'second in s2',
        undefined,
        undefined,
        vi.fn(),
        undefined,
      );
    });
    expect(captured.editor?.submitDisabled).toBe(true);
    const s3 = fakeController({ sessionId: 's3' });
    rerenderReact(container, <ChatSurface controller={s3} onError={onError} />);
    expect(captured.editor?.submitDisabled).toBe(false);
    await act(async () => {
      resolveS2?.({ admission: 'unknown' });
    });
    expect(captured.editor?.submitDisabled).toBe(false);
    expect(
      container.querySelector('[data-testid="admission-locked-banner"]'),
    ).toBeNull();
    rerenderReact(container, <ChatSurface controller={s2} onError={onError} />);
    expect(captured.editor?.submitDisabled).toBe(true);
    const bannerButton = container.querySelector(
      '[data-testid="admission-locked-banner"] button',
    ) as HTMLButtonElement | null;
    expect(bannerButton).not.toBeNull();
    await act(async () => {
      bannerButton?.click();
    });
    expect(captured.editor?.submitDisabled).toBe(false);
    rerenderReact(container, <ChatSurface controller={s3} onError={onError} />);
    rerenderReact(container, <ChatSurface controller={s2} onError={onError} />);
    expect(captured.editor?.submitDisabled).toBe(false);
    expect(
      container.querySelector('[data-testid="admission-locked-banner"]'),
    ).toBeNull();
    // Settling a parked submit as 'rejected' while s3 is visible must NOT lock
    // s2 on return (pins result.admission === 'unknown' on the parked branch).
    await act(async () => {
      (captured.editor?.onSubmit as SubmitHandler)(
        'third in s2',
        undefined,
        undefined,
        vi.fn(),
        undefined,
      );
    });
    rerenderReact(container, <ChatSurface controller={s3} onError={onError} />);
    await act(async () => {
      resolveS2?.({ admission: 'rejected' });
    });
    rerenderReact(container, <ChatSurface controller={s2} onError={onError} />);
    expect(captured.editor?.submitDisabled).toBe(false);
    expect(
      container.querySelector('[data-testid="admission-locked-banner"]'),
    ).toBeNull();
  });

  it('scopes cancel settlement errors to the session that requested the stop', async () => {
    let resolveS1Cancel: ((value: { admission: string }) => void) | undefined;
    const s1 = fakeController({
      sessionId: 's1',
      cancel: vi.fn(
        () =>
          new Promise<{ admission: string }>((resolve) => {
            resolveS1Cancel = resolve;
          }),
      ),
    });
    let rejectS2Cancel: ((reason: unknown) => void) | undefined;
    const s2 = fakeController({
      sessionId: 's2',
      cancel: vi.fn(
        () =>
          new Promise<{ admission: string }>((_resolve, reject) => {
            rejectS2Cancel = reject;
          }),
      ),
    });
    let resolveS3Cancel: ((value: { admission: string }) => void) | undefined;
    const s3 = fakeController({
      sessionId: 's3',
      cancel: vi.fn(
        () =>
          new Promise<{ admission: string }>((resolve) => {
            resolveS3Cancel = resolve;
          }),
      ),
    });
    const onError = vi.fn();
    const container = mountReact(
      <ChatSurface controller={s1} onError={onError} />,
    );
    await act(async () => {
      (captured.editor?.onCancel as () => void)();
    });
    // Switch s1 -> s2 before s1's cancel settles: s1's unconfirmed cancel must
    // not report on s2.
    rerenderReact(container, <ChatSurface controller={s2} onError={onError} />);
    await act(async () => {
      resolveS1Cancel?.({ admission: 'unknown' });
    });
    expect(onError).not.toHaveBeenCalled();
    // Start a cancel in s2, switch to s3, and reject s2's cancel: s3 stays silent.
    await act(async () => {
      (captured.editor?.onCancel as () => void)();
    });
    rerenderReact(container, <ChatSurface controller={s3} onError={onError} />);
    await act(async () => {
      rejectS2Cancel?.(new Error('transport failed'));
    });
    expect(onError).not.toHaveBeenCalled();
    // Start a cancel in s3, round-trip s3 -> s1 -> s3, then settle s3's cancel
    // as 'rejected' while back on s3: s3 is active again and receives the error.
    await act(async () => {
      (captured.editor?.onCancel as () => void)();
    });
    rerenderReact(container, <ChatSurface controller={s1} onError={onError} />);
    rerenderReact(container, <ChatSurface controller={s3} onError={onError} />);
    await act(async () => {
      resolveS3Cancel?.({ admission: 'rejected' });
    });
    expect(onError).toHaveBeenCalledTimes(1);
    onError.mockClear();
    // Start a cancel in an unallocated '' new chat, switch '' -> s1 -> '' (a
    // brand-new '' chat), then settle the abandoned '' cancel as 'unknown':
    // the rotated owner token keeps the brand-new '' chat silent.
    let resolveUnallocCancel:
      | ((value: { admission: string }) => void)
      | undefined;
    const unalloc1 = fakeController({
      sessionId: '',
      cancel: vi.fn(
        () =>
          new Promise<{ admission: string }>((resolve) => {
            resolveUnallocCancel = resolve;
          }),
      ),
    });
    rerenderReact(
      container,
      <ChatSurface controller={unalloc1} onError={onError} />,
    );
    await act(async () => {
      (captured.editor?.onCancel as () => void)();
    });
    rerenderReact(container, <ChatSurface controller={s1} onError={onError} />);
    const unalloc2 = fakeController({ sessionId: '' });
    rerenderReact(
      container,
      <ChatSurface controller={unalloc2} onError={onError} />,
    );
    await act(async () => {
      resolveUnallocCancel?.({ admission: 'unknown' });
    });
    expect(onError).not.toHaveBeenCalled();
    // An unallocated '' chat that stays active (no switch) must still report
    // both an unconfirmed cancel and a rejected cancel transport (R1-2).
    const activeUnallocUnknown = fakeController({
      sessionId: '',
      cancel: vi.fn(async () => ({
        admission: 'unknown',
        target: { sessionId: '' },
      })),
    });
    rerenderReact(
      container,
      <ChatSurface controller={activeUnallocUnknown} onError={onError} />,
    );
    await act(async () => {
      (captured.editor?.onCancel as () => void)();
    });
    expect(onError).toHaveBeenCalledTimes(1);
    expect(onError.mock.calls[0]?.[1]).toBe('localized:chat.stopNotConfirmed');
    onError.mockClear();
    const activeUnallocThrow = fakeController({
      sessionId: '',
      cancel: vi.fn(async () => {
        throw new Error('stop transport error');
      }),
    });
    rerenderReact(
      container,
      <ChatSurface controller={activeUnallocThrow} onError={onError} />,
    );
    await act(async () => {
      (captured.editor?.onCancel as () => void)();
    });
    expect(onError).toHaveBeenCalledTimes(1);
    expect(onError.mock.calls[0]?.[1]).toBe('localized:chat.stopNotConfirmed');
    onError.mockClear();
    // R2-4: any transition out of an unallocated '' chat ('' -> 'abc',
    // including a mid-flight session allocation) is treated as a session
    // switch, so an in-flight cancel started under '' stays silent.
    let resolveAllocCancel:
      | ((value: { admission: string }) => void)
      | undefined;
    const unallocToAlloc = fakeController({
      sessionId: '',
      cancel: vi.fn(
        () =>
          new Promise<{ admission: string }>((resolve) => {
            resolveAllocCancel = resolve;
          }),
      ),
    });
    rerenderReact(
      container,
      <ChatSurface controller={unallocToAlloc} onError={onError} />,
    );
    await act(async () => {
      (captured.editor?.onCancel as () => void)();
    });
    const allocated = fakeController({ sessionId: 'abc' });
    rerenderReact(
      container,
      <ChatSurface controller={allocated} onError={onError} />,
    );
    await act(async () => {
      resolveAllocCancel?.({ admission: 'unknown' });
    });
    expect(onError).not.toHaveBeenCalled();
  });

  it('scopes cancel settlement errors to the active turn within the same session', async () => {
    const onError = vi.fn();
    // Negative 1: same session S, T1 stop delayed, S advances to T2 -> no error against T2.
    let resolveT1Cancel:
      | ((value: {
          admission: string;
          target: { sessionId: string; turnId?: string };
        }) => void)
      | undefined;
    const s1T1 = fakeController({
      sessionId: 's1',
      activeTurnId: 't1',
      cancel: vi.fn(
        () =>
          new Promise<{
            admission: string;
            target: { sessionId: string; turnId?: string };
          }>((resolve) => {
            resolveT1Cancel = resolve;
          }),
      ),
    });
    const container = mountReact(
      <ChatSurface controller={s1T1} onError={onError} />,
    );
    await act(async () => {
      (captured.editor?.onCancel as () => void)();
    });
    // Swap to a second controller snapshot with the same sessionId but newer activeTurnId.
    let rejectT2Cancel: ((reason: unknown) => void) | undefined;
    const s1T2 = fakeController({
      sessionId: 's1',
      activeTurnId: 't2',
      cancel: vi.fn(
        () =>
          new Promise<{ admission: string }>((_resolve, reject) => {
            rejectT2Cancel = reject;
          }),
      ),
    });
    rerenderReact(
      container,
      <ChatSurface controller={s1T2} onError={onError} />,
    );
    await act(async () => {
      resolveT1Cancel?.({
        admission: 'unknown',
        target: { sessionId: 's1', turnId: 't1' },
      });
    });
    expect(onError).not.toHaveBeenCalled();

    // Negative 2: same session S, T2 stop throws after S advances to idle (activeTurnId undefined).
    await act(async () => {
      (captured.editor?.onCancel as () => void)();
    });
    const s1Idle = fakeController({ sessionId: 's1', activeTurnId: undefined });
    rerenderReact(
      container,
      <ChatSurface controller={s1Idle} onError={onError} />,
    );
    await act(async () => {
      rejectT2Cancel?.(new Error('delayed stop throw'));
    });
    expect(onError).not.toHaveBeenCalled();

    // Negative 3: result.target.turnId identifies t1 when dispatch had no activeTurnId,
    // and S is now idle (activeTurnId undefined) -> silent (pins resultTurnId ?? cancelTurnId).
    let resolveResultTagged:
      | ((value: {
          admission: string;
          target: { sessionId: string; turnId?: string };
        }) => void)
      | undefined;
    const s1UnknownDispatch = fakeController({
      sessionId: 's1',
      activeTurnId: undefined,
      cancel: vi.fn(
        () =>
          new Promise<{
            admission: string;
            target: { sessionId: string; turnId?: string };
          }>((resolve) => {
            resolveResultTagged = resolve;
          }),
      ),
    });
    rerenderReact(
      container,
      <ChatSurface controller={s1UnknownDispatch} onError={onError} />,
    );
    await act(async () => {
      (captured.editor?.onCancel as () => void)();
    });
    rerenderReact(
      container,
      <ChatSurface controller={s1Idle} onError={onError} />,
    );
    await act(async () => {
      resolveResultTagged?.({
        admission: 'rejected',
        target: { sessionId: 's1', turnId: 't1' },
      });
    });
    expect(onError).not.toHaveBeenCalled();

    // Positive: same session S and same turn T3 still active -> reports on both
    // unknown settlement and thrown transport.
    const s1T3Unknown = fakeController({
      sessionId: 's1',
      activeTurnId: 't3',
      cancel: vi.fn(async () => ({
        admission: 'unknown',
        target: { sessionId: 's1', turnId: 't3' },
      })),
    });
    rerenderReact(
      container,
      <ChatSurface controller={s1T3Unknown} onError={onError} />,
    );
    await act(async () => {
      (captured.editor?.onCancel as () => void)();
    });
    expect(onError).toHaveBeenCalledTimes(1);
    expect(onError.mock.calls[0]?.[1]).toBe('localized:chat.stopNotConfirmed');
    onError.mockClear();

    const s1T3Throw = fakeController({
      sessionId: 's1',
      activeTurnId: 't3',
      cancel: vi.fn(async () => {
        throw new Error('stop transport error');
      }),
    });
    rerenderReact(
      container,
      <ChatSurface controller={s1T3Throw} onError={onError} />,
    );
    await act(async () => {
      (captured.editor?.onCancel as () => void)();
    });
    expect(onError).toHaveBeenCalledTimes(1);
    expect(onError.mock.calls[0]?.[1]).toBe('localized:chat.stopNotConfirmed');
    onError.mockClear();

    // Round-trip S1(T4) -> S2 -> S1(T5): returning to S1 after T5 started stays silent;
    // returning to S1 while T4 is still active reports.
    let resolveT4Cancel:
      | ((value: {
          admission: string;
          target: { sessionId: string; turnId?: string };
        }) => void)
      | undefined;
    const s1T4 = fakeController({
      sessionId: 's1',
      activeTurnId: 't4',
      cancel: vi.fn(
        () =>
          new Promise<{
            admission: string;
            target: { sessionId: string; turnId?: string };
          }>((resolve) => {
            resolveT4Cancel = resolve;
          }),
      ),
    });
    const s2 = fakeController({ sessionId: 's2', activeTurnId: 'other' });
    const s1T5 = fakeController({ sessionId: 's1', activeTurnId: 't5' });
    rerenderReact(
      container,
      <ChatSurface controller={s1T4} onError={onError} />,
    );
    await act(async () => {
      (captured.editor?.onCancel as () => void)();
    });
    rerenderReact(container, <ChatSurface controller={s2} onError={onError} />);
    rerenderReact(
      container,
      <ChatSurface controller={s1T5} onError={onError} />,
    );
    await act(async () => {
      resolveT4Cancel?.({
        admission: 'unknown',
        target: { sessionId: 's1', turnId: 't4' },
      });
    });
    expect(onError).not.toHaveBeenCalled();

    let resolveT5Cancel:
      | ((value: {
          admission: string;
          target: { sessionId: string; turnId?: string };
        }) => void)
      | undefined;
    const s1T5Pending = fakeController({
      sessionId: 's1',
      activeTurnId: 't5',
      cancel: vi.fn(
        () =>
          new Promise<{
            admission: string;
            target: { sessionId: string; turnId?: string };
          }>((resolve) => {
            resolveT5Cancel = resolve;
          }),
      ),
    });
    rerenderReact(
      container,
      <ChatSurface controller={s1T5Pending} onError={onError} />,
    );
    await act(async () => {
      (captured.editor?.onCancel as () => void)();
    });
    rerenderReact(container, <ChatSurface controller={s2} onError={onError} />);
    // Return to s1 with a fresh controller instance carrying the preserved
    // activeTurnId ('t5'), matching useDaemonChatController's seeded rebuild.
    const s1T5Returned = fakeController({
      sessionId: 's1',
      activeTurnId: 't5',
    });
    rerenderReact(
      container,
      <ChatSurface controller={s1T5Returned} onError={onError} />,
    );
    await act(async () => {
      resolveT5Cancel?.({
        admission: 'unknown',
        target: { sessionId: 's1', turnId: 't5' },
      });
    });
    expect(onError).toHaveBeenCalledTimes(1);
    expect(onError.mock.calls[0]?.[1]).toBe('localized:chat.stopNotConfirmed');
    onError.mockClear();

    // R2-1: a stop pressed while submitting (no dispatch turnId, no stamped
    // result turnId) must still report if the turn is admitted before the stop
    // settles.
    let resolveSubmittingCancel:
      | ((value: { admission: string; target: { sessionId: string } }) => void)
      | undefined;
    const s1Submitting = fakeController({
      sessionId: 's1',
      activeTurnId: undefined,
      cancel: vi.fn(
        () =>
          new Promise<{ admission: string; target: { sessionId: string } }>(
            (resolve) => {
              resolveSubmittingCancel = resolve;
            },
          ),
      ),
    });
    rerenderReact(
      container,
      <ChatSurface controller={s1Submitting} onError={onError} />,
    );
    await act(async () => {
      (captured.editor?.onCancel as () => void)();
    });
    const s1AdmittedP6 = fakeController({
      sessionId: 's1',
      activeTurnId: 'p6',
    });
    rerenderReact(
      container,
      <ChatSurface controller={s1AdmittedP6} onError={onError} />,
    );
    await act(async () => {
      resolveSubmittingCancel?.({
        admission: 'unknown',
        target: { sessionId: 's1' },
      });
    });
    expect(onError).toHaveBeenCalledTimes(1);
    expect(onError.mock.calls[0]?.[1]).toBe('localized:chat.stopNotConfirmed');
  });

  it('reports a cancel error against the committed session when an incoming switch render is discarded before commit and stays silent after unmount (R2-5 / P2)', async () => {
    const onError = vi.fn();
    let resolveS1Cancel:
      | ((value: {
          admission: string;
          target: { sessionId: string; turnId?: string };
        }) => void)
      | undefined;
    const s1 = fakeController({
      sessionId: 's1',
      activeTurnId: 't1',
      cancel: vi.fn(
        () =>
          new Promise<{
            admission: string;
            target: { sessionId: string; turnId?: string };
          }>((resolve) => {
            resolveS1Cancel = resolve;
          }),
      ),
    });
    let resolveS2Cancel:
      | ((value: {
          admission: string;
          target: { sessionId: string; turnId?: string };
        }) => void)
      | undefined;
    const s2 = fakeController({
      sessionId: 's2',
      activeTurnId: 't2',
      cancel: vi.fn(
        () =>
          new Promise<{
            admission: string;
            target: { sessionId: string; turnId?: string };
          }>((resolve) => {
            resolveS2Cancel = resolve;
          }),
      ),
    });
    let pendingSuspense: Promise<void> | null = null;
    function SuspendingSibling() {
      if (pendingSuspense) {
        throw pendingSuspense;
      }
      return null;
    }
    let switchTo: ((next: SessionChatController) => void) | undefined;
    function TransitionHost() {
      const [active, setActive] = useState<SessionChatController>(s1);
      switchTo = (next) => {
        startTransition(() => {
          setActive(next);
        });
      };
      return (
        <Suspense fallback={null}>
          <ChatSurface controller={active} onError={onError} />
          <SuspendingSibling />
        </Suspense>
      );
    }
    mountReact(<TransitionHost />);
    await act(async () => {
      (captured.editor?.onCancel as () => void)();
    });
    // Start a concurrent transition to s2 while a sibling suspends:
    // ChatSurface's render body runs with s2 (updating render-time refs),
    // React discards that render without committing the fallback, and s1
    // remains the committed tree on screen. Settling s1's cancel as 'unknown'
    // during this window must still report chat.stopNotConfirmed (pins
    // commit-time refs — R2-5).
    let resolveSuspense!: () => void;
    pendingSuspense = new Promise<void>((resolve) => {
      resolveSuspense = resolve;
    });
    await act(async () => {
      switchTo?.(s2);
    });
    // Confirm the discarded render actually ran ChatSurface with s2 while s1
    // stayed committed on screen.
    expect(captured.editor?.sessionId).toBe('s2');
    await act(async () => {
      resolveS1Cancel?.({
        admission: 'unknown',
        target: { sessionId: 's1', turnId: 't1' },
      });
    });
    expect(onError).toHaveBeenCalledTimes(1);
    expect(onError.mock.calls[0]?.[1]).toBe('localized:chat.stopNotConfirmed');
    onError.mockClear();
    // Commit s2, start a cancel on s2, then unmount before it settles: a
    // settlement after unmount must stay silent (P2).
    pendingSuspense = null;
    await act(async () => {
      resolveSuspense();
    });
    expect(captured.editor?.sessionId).toBe('s2');
    await act(async () => {
      (captured.editor?.onCancel as () => void)();
    });
    cleanupReact();
    await act(async () => {
      resolveS2Cancel?.({
        admission: 'unknown',
        target: { sessionId: 's2', turnId: 't2' },
      });
    });
    expect(onError).not.toHaveBeenCalled();
  });

  it('preserves a parked in-flight latch when the switch render is discarded before commit (R1-4)', async () => {
    let resolveS1: ((value: { admission: string }) => void) | undefined;
    const s1 = fakeController({
      sessionId: 's1',
      submit: vi.fn(
        () =>
          new Promise<{ admission: string }>((resolve) => {
            resolveS1 = resolve;
          }),
      ),
    });
    const s2 = fakeController({ sessionId: 's2' });
    let pendingSuspense: Promise<void> | null = null;
    function SuspendingSibling() {
      if (pendingSuspense) {
        throw pendingSuspense;
      }
      return null;
    }
    const container = mountReact(
      <Suspense fallback={null}>
        <ChatSurface controller={s1} />
        <SuspendingSibling />
      </Suspense>,
    );
    const s1Commit = vi.fn();
    await act(async () => {
      (captured.editor?.onSubmit as SubmitHandler)(
        'in s1',
        undefined,
        undefined,
        s1Commit,
        undefined,
      );
    });
    expect(captured.editor?.submitDisabled).toBe(true);
    // Switch to s2 on a render whose sibling suspends so React discards the
    // uncommitted state update after ChatSurface has run its render body, then
    // resolve the suspension so React retries the s1 -> s2 render. Without
    // gating the ref park/restore on refOwnerRef, the retry re-enters with
    // lockOwner === 's1' and submitInFlightRef.current === false and deletes
    // s1's parked entry.
    let resolveSuspense!: () => void;
    pendingSuspense = new Promise<void>((resolve) => {
      resolveSuspense = resolve;
    });
    rerenderReact(
      container,
      <Suspense fallback={null}>
        <ChatSurface controller={s2} />
        <SuspendingSibling />
      </Suspense>,
    );
    pendingSuspense = null;
    await act(async () => {
      resolveSuspense();
    });
    expect(captured.editor?.sessionId).toBe('s2');
    expect(captured.editor?.submitDisabled).toBe(false);
    // Switch back to s1 while s1's submit is still in flight: s1's parked
    // in-flight latch must still be intact, blocking a duplicate send.
    rerenderReact(
      container,
      <Suspense fallback={null}>
        <ChatSurface controller={s1} />
        <SuspendingSibling />
      </Suspense>,
    );
    expect(captured.editor?.submitDisabled).toBe(true);
    await act(async () => {
      (captured.editor?.onSubmit as SubmitHandler)(
        'duplicate in s1',
        undefined,
        undefined,
        vi.fn(),
        undefined,
      );
    });
    expect(s1.submit).toHaveBeenCalledTimes(1);
    await act(async () => {
      resolveS1?.({ admission: 'accepted' });
    });
    expect(s1Commit).toHaveBeenCalledTimes(1);
    expect(captured.editor?.submitDisabled).toBe(false);
  });
});
