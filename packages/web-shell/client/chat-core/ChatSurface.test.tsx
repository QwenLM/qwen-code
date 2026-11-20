// @vitest-environment jsdom
/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Message, PermissionRequest } from '../adapters/types.js';
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

import { ChatSurface } from './ChatSurface.js';
import { cleanupReact, mountReact } from '../test/reactHarness.js';

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

function permissionRequest(id: string): PermissionRequest {
  return {
    id,
    content: [],
    options: [],
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
    const onConfirm = captured.approval?.onConfirm as (
      id: string,
      optionId: string,
    ) => Promise<void>;
    await onConfirm('a1', 'allow');
    expect(controller.respondApproval).toHaveBeenCalledWith('a1', 'allow');
  });

  it('normalizes question answers and reports admission as the confirm boolean', async () => {
    const request = permissionRequest('q1');
    const controller = fakeController({
      pendingQuestions: [{ id: 'q1', request }],
    });
    mountReact(<ChatSurface controller={controller} />);
    const onConfirm = captured.question?.onConfirm as (
      id: string,
      optionId: string,
      answers?: Record<string, string>,
    ) => Promise<boolean>;
    const accepted = await onConfirm('q1', 'submit', { '0': 'Alice' });
    expect(controller.respondQuestion).toHaveBeenCalledWith('q1', [
      { questionId: '0', value: 'Alice' },
    ]);
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
    const onConfirm = captured.question?.onConfirm as (
      id: string,
      optionId: string,
      answers?: Record<string, string>,
    ) => Promise<boolean>;
    expect(await onConfirm('q1', 'submit', {})).toBe(false);
  });

  it('submits through the controller and clears the draft only on admission', async () => {
    const controller = fakeController();
    mountReact(<ChatSurface controller={controller} />);
    const onSubmit = captured.editor?.onSubmit as (
      text: string,
      images?: unknown,
      files?: unknown,
      commitAccepted?: () => void,
      metadata?: unknown,
    ) => void;
    const commitAccepted = vi.fn();
    onSubmit('hello', undefined, undefined, commitAccepted, undefined);
    await vi.waitFor(() => expect(commitAccepted).toHaveBeenCalled());
    expect(controller.submit).toHaveBeenCalledWith({
      text: 'hello',
      images: undefined,
      files: undefined,
      metadata: undefined,
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
    const onSubmit = captured.editor?.onSubmit as (
      text: string,
      images?: unknown,
      files?: unknown,
      commitAccepted?: () => void,
      metadata?: unknown,
    ) => void;
    const commitAccepted = vi.fn();
    onSubmit('hello', undefined, undefined, commitAccepted, undefined);
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

  it('marks the composer running only while a turn is submitting or running', () => {
    const running = fakeController({ phase: 'running' });
    mountReact(<ChatSurface controller={running} />);
    expect(captured.editor?.isRunning).toBe(true);
    cleanupReact();
    const idle = fakeController({ phase: 'idle' });
    mountReact(<ChatSurface controller={idle} />);
    expect(captured.editor?.isRunning).toBe(false);
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
});
