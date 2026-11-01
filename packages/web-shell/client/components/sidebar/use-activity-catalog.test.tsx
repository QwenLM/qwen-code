// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DaemonClient, DaemonEvent } from '@qwen-code/sdk/daemon';
import type {
  SessionCatalogSnapshot,
  SessionCatalogQuery,
} from '../../session-catalog/session-catalog-store';
import {
  activityBatch,
  activityKey,
  activityPreview,
  useActivityCatalog,
} from './use-activity-catalog';

const fixtures = vi.hoisted(() => ({
  snapshots: [] as SessionCatalogSnapshot[],
  queries: [] as readonly SessionCatalogQuery[],
  byCursor: undefined as Map<string, SessionCatalogSnapshot> | undefined,
  patch: vi.fn(),
  invalidate: vi.fn(),
  reload: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('../../session-catalog/session-catalog-hooks', () => ({
  useSessionCatalogQueries: (
    _client: unknown,
    queries: readonly SessionCatalogQuery[],
  ) => {
    fixtures.queries = queries;
    return fixtures.byCursor
      ? queries.map(
          (query) => fixtures.byCursor!.get(query.options.cursor ?? '')!,
        )
      : fixtures.snapshots;
  },
}));
vi.mock('../../session-catalog/session-catalog-store', () => ({
  getSessionCatalogStore: () => ({
    patchSession: fixtures.patch,
    invalidateWorkspace: fixtures.invalidate,
    loadOnce: fixtures.reload,
    refresh: fixtures.reload,
  }),
}));

function event(sessionUpdate: string, text: string): DaemonEvent {
  return {
    v: 1,
    type: 'session_update',
    data: { update: { sessionUpdate, content: { type: 'text', text } } },
  };
}

describe('activity reads', () => {
  it('extracts assistant text without exposing analysis, tool JSON or user input', () => {
    expect(
      activityPreview([
        event('agent_message_chunk', 'Old reply'),
        event('user_message_chunk', 'Secret user prompt'),
        event('agent_thought_chunk', 'Private analysis'),
        event('tool_call', '{"raw":"tool"}'),
        event('agent_message_chunk', 'Final '),
        event('agent_message_chunk', 'reply'),
      ]),
    ).toBe('Final reply');
    expect([
      ...activityPreview([event('agent_message_chunk', '😀'.repeat(700))])!,
    ]).toHaveLength(600);
    expect(
      activityPreview([event('agent_thought_chunk', 'thinking')]),
    ).toBeUndefined();
  });

  it('bounds bulk work and continues after individual failures', async () => {
    let active = 0;
    let peak = 0;
    const results = await activityBatch(
      Array.from({ length: 19 }, (_, i) => i),
      async (value) => {
        peak = Math.max(peak, ++active);
        await Promise.resolve();
        active--;
        if (value === 3) throw new Error('unavailable');
        return value;
      },
    );
    expect(peak).toBe(8);
    expect(results).toHaveLength(19);
    expect(
      results.filter((result) => result.status === 'fulfilled'),
    ).toHaveLength(18);
  });
});

describe('activity controller', () => {
  let root: Root;
  let container: HTMLDivElement;
  let controller: ReturnType<typeof useActivityCatalog>;
  const stamp = '2026-10-31T03:00:00.000Z';
  const organizationWrite = vi.fn();
  const archived = vi.fn();
  const onArchivedCurrent = vi.fn();
  let currentKey: string | undefined;
  let open = true;
  const client = {
    workspaceByCwd: vi.fn(() => ({
      updateSessionOrganization: organizationWrite,
      archiveSessionsData: archived,
      unarchiveSessionsData: vi.fn(),
      getSessionTranscriptPage: vi.fn().mockResolvedValue({ events: [] }),
    })),
  } as unknown as DaemonClient;
  function Harness() {
    controller = useActivityCatalog({
      client,
      workspaceCwds: ['/work'],
      enabled: true,
      open,
      liveStateEnabled: true,
      currentKey,
      onArchivedCurrent,
    });
    return null;
  }
  const render = async () => {
    await act(async () => {
      root.render(<Harness />);
    });
  };
  beforeEach(() => {
    vi.clearAllMocks();
    fixtures.reload.mockResolvedValue(undefined);
    vi.spyOn(document, 'hasFocus').mockReturnValue(true);
    fixtures.snapshots = [
      {
        loading: false,
        stale: false,
        page: {
          sessions: [
            { sessionId: 'one', workspaceCwd: '/work', updatedAt: stamp },
          ],
        },
      },
    ];
    currentKey = activityKey('/work', 'one');
    open = true;
    fixtures.byCursor = undefined;
    container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
  });
  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    vi.restoreAllMocks();
  });
  it('does not write read state when hydrating or previewing the current conversation', async () => {
    await render();
    await controller.loadPreview(controller.entries[0]!);
    expect(organizationWrite).not.toHaveBeenCalled();
    expect(fixtures.patch).not.toHaveBeenCalled();
    expect(controller.entries[0]).toEqual({
      key: activityKey('/work', 'one'),
      session: { sessionId: 'one', workspaceCwd: '/work', updatedAt: stamp },
    });
  });
  it('replaces obsolete cursor chains and releases extra pages on close', async () => {
    fixtures.byCursor = new Map([
      [
        '',
        {
          loading: false,
          stale: false,
          page: { sessions: [], nextCursor: 'a' },
        },
      ],
      ['a', { loading: false, stale: false, page: { sessions: [] } }],
      ['b', { loading: false, stale: false, page: { sessions: [] } }],
    ]);
    await render();
    expect(fixtures.queries.map((query) => query.options.cursor)).toEqual([
      undefined,
      'a',
    ]);
    fixtures.byCursor.set('', {
      loading: false,
      stale: false,
      page: { sessions: [], nextCursor: 'b' },
    });
    await render();
    expect(fixtures.queries.map((query) => query.options.cursor)).toEqual([
      undefined,
      'b',
    ]);
    open = false;
    await render();
    expect(fixtures.queries).toHaveLength(1);
  });
  it('retries unavailable catalogs without writing session organization', async () => {
    fixtures.snapshots[0] = {
      ...fixtures.snapshots[0]!,
      error: new Error('offline'),
    };
    await render();
    expect(controller.unavailable).toBe(true);
    await act(async () => controller.retry());
    expect(fixtures.reload).toHaveBeenCalledWith(fixtures.queries[0], {
      interactive: true,
    });
    expect(organizationWrite).not.toHaveBeenCalled();
  });
  it('does not navigate away from a different conversation when an archive finishes late', async () => {
    let complete!: (value: {
      archived: string[];
      alreadyArchived: string[];
      errors: never[];
      notFound: never[];
    }) => void;
    archived.mockReturnValue(
      new Promise((resolve) => {
        complete = resolve;
      }),
    );
    await render();
    let operation!: ReturnType<typeof controller.archive>;
    await act(async () => {
      operation = controller.archive(controller.entries);
    });
    currentKey = activityKey('/work', 'different');
    await render();
    await act(async () => {
      complete({
        archived: ['one'],
        alreadyArchived: [],
        errors: [],
        notFound: [],
      });
      await operation;
    });
    expect(onArchivedCurrent).not.toHaveBeenCalled();
    expect(client.workspaceByCwd).toHaveBeenCalledWith('/work');
  });
  it('leaves the archived conversation after the daemon clears its attachment before replying', async () => {
    let complete!: (value: {
      archived: string[];
      alreadyArchived: string[];
      errors: never[];
      notFound: never[];
    }) => void;
    archived.mockReturnValue(
      new Promise((resolve) => {
        complete = resolve;
      }),
    );
    await render();
    let operation!: ReturnType<typeof controller.archive>;
    await act(async () => {
      operation = controller.archive(controller.entries);
    });
    currentKey = undefined;
    await render();
    await act(async () => {
      complete({
        archived: ['one'],
        alreadyArchived: [],
        errors: [],
        notFound: [],
      });
      await operation;
    });
    expect(onArchivedCurrent).toHaveBeenCalledOnce();
  });
});
