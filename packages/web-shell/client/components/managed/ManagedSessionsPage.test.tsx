// @vitest-environment jsdom

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { JavaManagedAgentHttpError } from './java-managed-agent-client';
import { I18nProvider } from '../../i18n';
import type {
  ManagedAgentProvider,
  ManagedAgentSessionSummary,
  ManagedAgentSessionEvent,
  ManagedAgentSessionTranscript,
} from './managed-agent-provider';

const mocks = vi.hoisted(() => ({
  useWorkspace: vi.fn(),
  client: {
    listSessions: vi.fn(),
    getSession: vi.fn(),
    getTranscript: vi.fn(),
    subscribeEvents: vi.fn(),
    createSession: vi.fn(),
    submitPrompt: vi.fn(),
    cancel: vi.fn(),
  },
  features: ['managed_sessions', 'managed_session_cancel'],
}));

vi.mock('@qwen-code/web-shell/daemon-react-sdk', () => ({
  useWorkspace: mocks.useWorkspace,
}));
vi.mock('../MessageList', () => ({
  MessageList: ({
    messages,
    hasOlderHistory,
    onLoadOlderHistory,
  }: {
    messages: unknown[];
    hasOlderHistory: boolean;
    onLoadOlderHistory: () => Promise<void>;
  }) => (
    <>
      <pre data-testid="messages">{JSON.stringify(messages)}</pre>
      {hasOlderHistory && (
        <button onClick={() => void onLoadOlderHistory()}>Older history</button>
      )}
    </>
  ),
}));

import { ManagedSessionsPage } from './ManagedSessionsPage';

function summary(
  sessionId = 's1',
  extra: Partial<ManagedAgentSessionSummary> = {},
): ManagedAgentSessionSummary {
  return {
    sessionId,
    activeTurnId: 'p1',
    title: `Task ${sessionId}`,
    workspaceCwd: '/workspace',
    createdAt: 10,
    updatedAt: 20,
    admittedAt: 10,
    phase: 'completed',
    runtimeReady: true,
    runtimeState: 'ready',
    capabilities: { canSend: true, canCancel: false },
    ...extra,
  };
}

function event(id: number, text: string): ManagedAgentSessionEvent {
  return {
    id,
    at: id,
    type: 'assistant_delta',
    sessionId: 's1',
    turnId: 'p1',
    data: { text },
  };
}

async function flush() {
  for (let i = 0; i < 8; i++) await Promise.resolve();
}

describe('ManagedSessionsPage', () => {
  let container: HTMLDivElement;
  let root: Root;
  let onSelect: ReturnType<typeof vi.fn>;
  let provider: ManagedAgentProvider;

  beforeEach(() => {
    vi.clearAllMocks();
    provider = {
      kind: 'java',
      storageKey: 'http://managed-test',
      canCancel: true,
      acceptsWorkspaceCwd: false,
      ...mocks.client,
    };
    sessionStorage.clear();
    mocks.features = ['managed_sessions', 'managed_session_cancel'];
    mocks.useWorkspace.mockImplementation(() => ({
      client: mocks.client,
      baseUrl: 'http://managed-test',
      capabilities: { features: mocks.features },
    }));
    mocks.client.listSessions.mockResolvedValue({
      sessions: [summary()],
    });
    mocks.client.getSession.mockImplementation(async (id: string) =>
      summary(id),
    );
    mocks.client.getTranscript.mockResolvedValue({
      events: [
        event(1, 'Persisted answer'),
        { ...event(2, ''), type: 'completed' },
      ],
      lastEventId: 2,
    });
    mocks.client.subscribeEvents.mockImplementation(async function* (
      _id: string,
      opts: { signal: AbortSignal },
    ) {
      await new Promise<void>((resolve) => {
        if (opts.signal.aborted) resolve();
        else
          opts.signal.addEventListener('abort', () => resolve(), {
            once: true,
          });
      });
      yield* [];
    });
    mocks.client.createSession.mockResolvedValue({
      sessionId: 'created',
      turnId: 'p-new',
    });
    mocks.client.submitPrompt.mockResolvedValue({
      sessionId: 's1',
      turnId: 'p-next',
    });
    mocks.client.cancel.mockResolvedValue({ accepted: true });
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    onSelect = vi.fn();
  });

  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    vi.useRealTimers();
  });

  async function render(
    sessionId?: string,
    language: 'en' | 'zh-CN' = 'en',
    managedAgentProvider: ManagedAgentProvider | null = provider,
  ) {
    await act(async () => {
      root.render(
        <I18nProvider language={language}>
          <ManagedSessionsPage
            sessionId={sessionId}
            onSelectSession={onSelect}
            workspaceCwd="/workspace"
            managedAgentProvider={managedAgentProvider ?? undefined}
          />
        </I18nProvider>,
      );
      await flush();
    });
  }

  it('uses an explicit Java provider without daemon Managed capabilities', async () => {
    mocks.features = [];
    const listSessions = vi.fn().mockResolvedValue({
      sessions: [summary('java-session')],
    });
    const provider: ManagedAgentProvider = {
      kind: 'java',
      storageKey: 'https://java.example/agent',
      canCancel: true,
      acceptsWorkspaceCwd: false,
      listSessions,
      getSession: vi.fn(),
      getTranscript: vi.fn(),
      createSession: vi.fn(),
      submitPrompt: vi.fn(),
      cancel: vi.fn(),
      async *subscribeEvents() {
        yield* [];
      },
    };

    await render(undefined, 'en', provider);

    expect(container.textContent).toContain('Task java-session');
    expect(listSessions).toHaveBeenCalledWith(
      expect.objectContaining({ workspaceCwd: undefined }),
    );
    expect(mocks.useWorkspace).not.toHaveBeenCalled();
    expect(mocks.client.listSessions).not.toHaveBeenCalled();
  });

  it('shows an existing empty bound Session without execution controls', async () => {
    const bound = summary('bound', {
      activeTurnId: undefined,
      phase: 'created',
      runtimeReady: false,
      runtimeState: 'unknown',
      workspace: { workspaceId: 'ws-a', cwdRelative: 'services/api' },
      capabilities: { canSend: false, canCancel: false },
    });
    mocks.client.getSession.mockResolvedValue(bound);
    mocks.client.getTranscript.mockResolvedValue({
      events: [],
      lastEventId: 0,
    });
    await render('bound');
    expect(
      container.querySelector('[data-managed-workspace-binding]')?.textContent,
    ).toContain('ws-a');
    expect(
      container.querySelector('[data-managed-workspace-binding]')?.textContent,
    ).toContain('services/api');
    expect(container.querySelector('[data-managed-progress]')).toBeNull();
    expect(container.querySelector('textarea')).toBeNull();
    expect(container.textContent).not.toContain('Preparing environment');
  });

  async function click(label: string) {
    const button = [...container.querySelectorAll('button')].find(
      (item) => item.textContent === label,
    );
    expect(button).toBeDefined();
    await act(async () => {
      button!.click();
      await flush();
    });
  }

  async function input(text: string) {
    const textarea = container.querySelector('textarea')!;
    await act(async () => {
      Object.getOwnPropertyDescriptor(
        HTMLTextAreaElement.prototype,
        'value',
      )!.set!.call(textarea, text);
      textarea.dispatchEvent(new Event('input', { bubbles: true }));
    });
  }

  it('opens durable history without creating or restoring a Runtime and subscribes after its watermark', async () => {
    await render('s1');
    expect(container.textContent).toContain('Persisted answer');
    expect(mocks.client.subscribeEvents).toHaveBeenCalledWith(
      's1',
      expect.objectContaining({ lastEventId: 2 }),
    );
    expect(mocks.client.getTranscript).toHaveBeenCalledWith(
      's1',
      expect.objectContaining({ limit: 100 }),
    );
    expect(mocks.client.createSession).not.toHaveBeenCalled();
    expect(mocks.client.submitPrompt).not.toHaveBeenCalled();
  });

  it('renders Chinese Managed labels and states without English fallback overriding them', async () => {
    await render('s1', 'zh-CN');
    expect(container.querySelector('nav')?.getAttribute('aria-label')).toBe(
      '托管会话',
    );
    expect(
      container.querySelector('textarea')?.getAttribute('aria-label'),
    ).toBe('向托管 Agent 发送消息');
    expect(container.textContent).toContain('新建托管任务');
    expect(container.textContent).toContain('执行环境: 已就绪');
    expect(container.textContent).toContain('已完成');
    expect(container.textContent).not.toContain('Completed');
  });

  it('keeps creation payload, correlation and idempotency key on an uncertain retry', async () => {
    mocks.client.createSession.mockRejectedValueOnce(
      new TypeError('Network failed'),
    );
    await render();
    await input('Do the work');
    await click('Send');
    expect(container.textContent).toContain('request outcome is unconfirmed');
    expect(container.querySelector('textarea')?.disabled).toBe(true);
    await click('Retry the same request');
    const [first, retry] = mocks.client.createSession.mock.calls;
    expect(first?.[0]).toEqual({
      text: 'Do the work',
      workspaceCwd: undefined,
    });
    expect(retry?.[0]).toEqual(first?.[0]);
    expect(retry?.[1].idempotencyKey).toBe(first?.[1].idempotencyKey);
    expect(retry?.[1].clientId).toBe(first?.[1].clientId);
    expect(onSelect).toHaveBeenLastCalledWith('created');
  });

  it('gates sending and cancels the captured Prompt without treating acceptance as terminal', async () => {
    mocks.client.getSession.mockResolvedValue(
      summary('s1', {
        phase: 'tool_running',
        capabilities: { canSend: false, canCancel: true },
      }),
    );
    await render('s1');
    expect(container.querySelector('textarea')?.disabled).toBe(true);
    await click('Cancel turn');
    expect(mocks.client.cancel).toHaveBeenCalledWith(
      's1',
      'p1',
      expect.objectContaining({ clientId: expect.any(String) }),
    );
    expect(container.textContent).toContain('Executing tool');
    expect(container.textContent).not.toContain('Cancelled');
  });

  it('shows submission and loading feedback before the first model event', async () => {
    let accept!: (value: { sessionId: string; turnId: string }) => void;
    mocks.client.createSession.mockImplementationOnce(
      () => new Promise((resolve) => (accept = resolve)),
    );
    await render();
    await input('Inspect the workspace');
    await click('Send');
    expect(
      container.querySelector('[data-managed-progress] span[role="status"]')
        ?.textContent,
    ).toBe('Submitting…');

    let load!: (value: ManagedAgentSessionTranscript) => void;
    mocks.client.getSession.mockResolvedValue(
      summary('s1', {
        phase: 'admitted',
        capabilities: { canSend: false, canCancel: true },
      }),
    );
    mocks.client.getTranscript.mockImplementationOnce(
      () => new Promise((resolve) => (load = resolve)),
    );
    await act(async () => {
      accept({ sessionId: 's1', turnId: 'p1' });
      await flush();
    });
    await render('s1');
    expect(
      container.querySelector('[data-managed-progress]')?.textContent,
    ).toBe('Loading…');
    await act(async () => {
      load({
        events: [
          {
            ...event(1, ''),
            type: 'accepted',
            data: { prompt: [{ type: 'text', text: 'Inspect the workspace' }] },
          },
          { ...event(2, ''), type: 'agent_started' },
        ],
        lastEventId: 2,
      });
      await flush();
    });
    expect(
      container.querySelector('[data-managed-progress]')?.textContent,
    ).toContain('Accepted');
    expect(
      container.querySelector('[data-managed-progress]')?.textContent,
    ).toContain('This turn is running');
    expect(container.querySelector('textarea')?.disabled).toBe(true);
    expect(mocks.client.createSession).toHaveBeenCalledTimes(1);
  });

  it.each(['completed', 'failed', 'cancelled'] as const)(
    'keeps elapsed progress during silent intervals and removes it on %s',
    async (phase) => {
      vi.useFakeTimers();
      vi.setSystemTime(10_000);
      mocks.client.getSession.mockResolvedValue(
        summary('s1', {
          admittedAt: 8000,
          phase: 'agent_running',
          capabilities: { canSend: false, canCancel: true },
        }),
      );
      mocks.client.getTranscript.mockResolvedValue({
        events: [],
        lastEventId: 0,
      });
      await render('s1', 'zh-CN');
      expect(
        container.querySelector('[data-managed-progress]')?.textContent,
      ).toContain('已用时 2 秒');
      await act(async () => {
        await vi.advanceTimersByTimeAsync(5000);
      });
      expect(
        container.querySelector('[data-managed-progress]')?.textContent,
      ).toContain('已用时 7 秒');
      expect(
        container.querySelector('[data-managed-progress]')?.textContent,
      ).toContain('本轮执行中');
      mocks.client.getSession.mockResolvedValue(
        summary('s1', {
          phase,
          runtimeState: 'starting',
          runtimeReady: false,
        }),
      );
      await act(async () => {
        await vi.advanceTimersByTimeAsync(3000);
      });
      expect(container.querySelector('[data-managed-progress]')).toBeNull();
      expect(container.querySelector('textarea')?.disabled).toBe(false);
    },
  );

  it('preserves an uncertain attempt across a remount and restores its text after a definitive rejection', async () => {
    mocks.client.createSession.mockRejectedValueOnce(
      new TypeError('Network failed'),
    );
    await render();
    await input('Keep this prompt');
    await click('Send');
    const originalKey =
      mocks.client.createSession.mock.calls[0]?.[1].idempotencyKey;
    await act(async () => root.unmount());
    root = createRoot(container);
    mocks.client.createSession.mockRejectedValueOnce(
      new JavaManagedAgentHttpError(400, 'invalid_request', 'Invalid request'),
    );
    await render();
    expect(container.querySelector('textarea')?.value).toBe('Keep this prompt');
    await click('Retry the same request');
    expect(mocks.client.createSession.mock.calls[1]?.[1].idempotencyKey).toBe(
      originalKey,
    );
    expect(container.querySelector('textarea')?.value).toBe('Keep this prompt');
    expect(container.querySelector('textarea')?.disabled).toBe(false);
  });

  it('does not fetch Managed endpoints when the feature is unavailable', async () => {
    await render('s1', 'en', null);
    expect(container.textContent).toContain('unavailable');
    expect(mocks.client.getSession).not.toHaveBeenCalled();
    expect(mocks.client.listSessions).not.toHaveBeenCalled();
  });

  it.each(['accepted', 'rejected'] as const)(
    'does not apply an old submission to the new selection when it is %s',
    async (outcome) => {
      mocks.client.listSessions.mockResolvedValue({
        sessions: [summary('s1'), summary('s2')],
      });
      let resolveSubmission!: (value: {
        sessionId: string;
        turnId: string;
      }) => void;
      let rejectSubmission!: (error: Error) => void;
      mocks.client.submitPrompt.mockImplementationOnce(
        () =>
          new Promise((resolve, reject) => {
            resolveSubmission = resolve;
            rejectSubmission = reject;
          }),
      );
      await render('s1');
      await input('Old session prompt');
      await click('Send');
      await click('Task s2Completed');
      await render('s2');
      expect(container.querySelector('[data-managed-progress]')).toBeNull();
      await act(async () => {
        if (outcome === 'accepted')
          resolveSubmission({ sessionId: 's1', turnId: 'p2' });
        else
          rejectSubmission(
            new JavaManagedAgentHttpError(
              400,
              'invalid_request',
              'Old session rejection',
            ),
          );
        await flush();
      });
      expect(onSelect).toHaveBeenCalledExactlyOnceWith('s2');
      expect(container.querySelector('textarea')?.value).toBe('');
      expect(container.textContent).not.toContain('Old session rejection');
      expect(container.textContent).toContain('Task s2');
    },
  );

  it('updates late Runtime failure after a completed turn through detail polling', async () => {
    vi.useFakeTimers();
    mocks.client.getSession.mockResolvedValue(
      summary('s1', { runtimeState: 'starting', runtimeReady: false }),
    );
    await render('s1');
    expect(container.textContent).toContain('Environment: Preparing');
    mocks.client.getSession.mockResolvedValue(
      summary('s1', {
        updatedAt: 30,
        runtimeState: 'failed',
        runtimeReady: false,
      }),
    );
    await act(async () => {
      await vi.advanceTimersByTimeAsync(3000);
      await flush();
    });
    expect(container.textContent).toContain('Environment: Preparation failed');
    expect(container.textContent).toContain('Completed');
    expect(container.textContent).toContain('Persisted answer');
  });

  it('prepends older transcript pages without losing current messages', async () => {
    mocks.client.getTranscript
      .mockResolvedValueOnce({
        events: [event(3, 'Recent')],
        olderCursor: '3',
        lastEventId: 3,
      })
      .mockResolvedValue({
        events: [
          {
            ...event(1, ''),
            type: 'accepted',
            data: { prompt: [{ type: 'text', text: 'Original question' }] },
          },
          event(2, 'Earlier '),
        ],
        lastEventId: 3,
      });
    await render('s1');
    await click('Older history');
    expect(container.textContent).toContain('Original question');
    expect(container.textContent).toContain('Earlier Recent');
    expect(mocks.client.getTranscript).toHaveBeenLastCalledWith(
      's1',
      expect.objectContaining({ before: '3', limit: 100 }),
    );
  });

  it('ignores delayed snapshot responses after selection switches', async () => {
    let resolveFirst!: (value: ManagedAgentSessionTranscript) => void;
    mocks.client.getTranscript.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          resolveFirst = resolve;
        }),
    );
    await render('s1');
    mocks.client.getTranscript.mockResolvedValue({
      events: [{ ...event(1, 'Second answer'), sessionId: 's2' }],
      lastEventId: 1,
    });
    await render('s2');
    await act(async () => {
      resolveFirst({
        events: [event(1, 'Stale first answer')],
        lastEventId: 1,
      });
      await flush();
    });
    expect(container.textContent).toContain('Second answer');
    expect(container.textContent).not.toContain('Stale first answer');
  });

  it('retries a transient initial history failure before subscribing without resubmitting a prompt', async () => {
    vi.useFakeTimers();
    mocks.client.getTranscript.mockRejectedValueOnce(
      new TypeError('Temporary history failure'),
    );
    await render('s1');
    expect(container.textContent).toContain('Temporary history failure');
    expect(mocks.client.subscribeEvents).not.toHaveBeenCalled();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(3000);
      await flush();
    });
    expect(container.textContent).toContain('Persisted answer');
    expect(container.textContent).not.toContain('Temporary history failure');
    expect(mocks.client.getTranscript).toHaveBeenCalledTimes(2);
    expect(mocks.client.subscribeEvents).toHaveBeenCalledWith(
      's1',
      expect.objectContaining({ lastEventId: 2 }),
    );
    expect(mocks.client.createSession).not.toHaveBeenCalled();
    expect(mocks.client.submitPrompt).not.toHaveBeenCalled();
  });

  it('aborts a waiting initial snapshot retry when the selection changes', async () => {
    vi.useFakeTimers();
    mocks.client.getTranscript.mockRejectedValueOnce(
      new TypeError('Temporary history failure'),
    );
    await render('s1');
    await render('s2');
    await act(async () => {
      await vi.advanceTimersByTimeAsync(3000);
      await flush();
    });
    expect(mocks.client.getTranscript.mock.calls.map(([id]) => id)).toEqual([
      's1',
      's2',
    ]);
    expect(mocks.client.subscribeEvents).toHaveBeenCalledTimes(1);
    expect(mocks.client.subscribeEvents).toHaveBeenCalledWith(
      's2',
      expect.objectContaining({ lastEventId: 2 }),
    );
  });

  it('backs off when gap recovery fails instead of repeatedly requesting the same missing range', async () => {
    vi.useFakeTimers();
    mocks.client.getTranscript
      .mockResolvedValueOnce({
        events: [event(1, 'Before gap')],
        lastEventId: 1,
      })
      .mockRejectedValueOnce(new TypeError('Recovery temporarily unavailable'))
      .mockResolvedValue({
        events: [event(1, 'Restored history')],
        lastEventId: 1,
      });
    const gapStream = async function* () {
      yield { ...event(2, ''), type: 'stream_gap' };
    };
    mocks.client.subscribeEvents
      .mockImplementationOnce(gapStream)
      .mockImplementationOnce(gapStream);
    await render('s1');
    expect(container.textContent).toContain('Recovery temporarily unavailable');
    await act(async () => {
      await vi.advanceTimersByTimeAsync(2999);
      await flush();
    });
    expect(mocks.client.subscribeEvents).toHaveBeenCalledTimes(1);
    expect(mocks.client.getTranscript).toHaveBeenCalledTimes(2);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1);
      await flush();
    });
    expect(container.textContent).toContain('Restored history');
    expect(mocks.client.getTranscript).toHaveBeenCalledTimes(3);
  });

  it('deduplicates replay and replaces a gapped stream with a durable snapshot', async () => {
    vi.useFakeTimers();
    mocks.client.getTranscript
      .mockResolvedValueOnce({ events: [event(1, 'First')], lastEventId: 1 })
      .mockResolvedValue({
        events: [event(1, 'First'), event(2, ' second'), event(3, ' restored')],
        lastEventId: 3,
      });
    mocks.client.subscribeEvents.mockImplementationOnce(async function* () {
      yield event(1, 'First');
      yield event(2, ' second');
      yield { ...event(3, ''), type: 'stream_gap' };
    });
    await render('s1');
    await act(async () => {
      await vi.advanceTimersByTimeAsync(1);
      await flush();
    });
    expect(
      container.querySelector('[data-testid="messages"]')?.textContent,
    ).toContain('First second restored');
    expect(container.textContent).not.toContain('FirstFirst');
    expect(mocks.client.getTranscript).toHaveBeenCalledTimes(2);
    for (const [, options] of mocks.client.getTranscript.mock.calls) {
      expect(options.limit).toBe(100);
    }
    expect(mocks.client.subscribeEvents).toHaveBeenLastCalledWith(
      's1',
      expect.objectContaining({ lastEventId: 3 }),
    );
    expect(mocks.client.submitPrompt).not.toHaveBeenCalled();
  });
});
