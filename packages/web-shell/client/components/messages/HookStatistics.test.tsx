// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, expect, it, vi } from 'vitest';
import {
  summarizeHookExecutions,
  type HookExecutionEntry,
  type HookTurnPage,
  type DaemonEvent,
} from '@qwen-code/sdk/daemon';
import { I18nProvider } from '../../i18n';
import { WebShellPortalRootContext } from '../../portalRoot';
import { createDaemonTurnNavigationStore } from '../../daemon/session/turn-navigation-store';
import {
  HookStatisticsContext,
  type HookStatisticsSource,
  type HookStatisticsTurn,
} from './hook-statistics-context';
import { HookStatistics } from './HookStatistics';
import { TrajectoryLiveContext } from '../../trajectory/trajectory-live-context';
import {
  createTrajectoryLiveStore,
  type TrajectoryLiveStore,
} from '../../trajectory/trajectory-live-store';

let root: Root;
let container: HTMLDivElement;
let portal: HTMLDivElement;
afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
  portal?.remove();
  container = undefined!;
  vi.restoreAllMocks();
  vi.useRealTimers();
});

const entries: HookExecutionEntry[] = Array.from(
  { length: 51 },
  (_, index) => ({
    event: {
      v: 1,
      kind: 'hook',
      executionId: String(index),
      runtimeId: 'runtime',
      sessionId: 'session',
      promptId: 'history',
      agentId: null,
      name: index === 0 ? '<script>safe text</script>' : `Hook ${index}`,
      source: 'user',
      hookType: 'command',
      eventName: 'UserPromptSubmit',
      startedAt: 1000,
      phase: 'ended',
      endedAt: 1100,
      durationMs: 100,
      outcome: 'success',
    },
    status: 'success',
    conflicted: false,
  }),
);
function page(start = 0, limit = 1): HookTurnPage {
  return {
    sessionId: 'session',
    promptId: 'history',
    snapshot: 'frozen',
    start,
    totalExecutions: 51,
    executions: entries.slice(start, start + limit),
    summary: summarizeHookExecutions(entries),
    nextStart: start + limit < 51 ? start + limit : undefined,
    coverage: 'recorded',
  };
}
function source(
  readPage: HookStatisticsSource['readPage'],
): HookStatisticsSource {
  const navigation = createDaemonTurnNavigationStore();
  const state = {
    ...navigation.getSnapshot(),
    sessionId: 'session',
    indexPages: new Map([
      [
        0,
        {
          start: 0,
          end: 1,
          snapshot: 'index',
          retainedBytes: 100,
          turns: [
            {
              ordinal: 0,
              turnId: 'record',
              promptId: 'admission',
              historyPromptId: 'history',
              kind: 'prompt' as const,
              label: 'Question',
            },
          ],
        },
      ],
    ]),
  };
  vi.spyOn(navigation, 'getSnapshot').mockReturnValue(state);
  return { sessionId: 'session', navigation, readPage };
}
const turn: HookStatisticsTurn = {
  sessionId: 'session',
  recordId: 'record',
  promptId: 'admission',
};
async function render(
  value: HookStatisticsSource,
  selected: HookStatisticsTurn | HookStatisticsTurn[] = turn,
  liveStore: TrajectoryLiveStore | null = null,
) {
  if (!container) {
    container = document.createElement('div');
    portal = document.createElement('div');
    document.body.append(container, portal);
    root = createRoot(container);
  }
  await act(async () =>
    root.render(
      <I18nProvider language="en">
        <WebShellPortalRootContext.Provider value={portal}>
          <HookStatisticsContext.Provider value={value}>
            <TrajectoryLiveContext.Provider value={liveStore}>
              {(Array.isArray(selected) ? selected : [selected]).map((item) => (
                <HookStatistics
                  key={`${item.sessionId}:${item.recordId}`}
                  turn={item}
                />
              ))}
            </TrajectoryLiveContext.Provider>
          </HookStatisticsContext.Provider>
        </WebShellPortalRootContext.Provider>
      </I18nProvider>,
    ),
  );
}
function button(label: string, parent: ParentNode = document) {
  const found = [...parent.querySelectorAll('button')].find(
    (node) =>
      node.getAttribute('aria-label') === label || node.textContent === label,
  );
  if (!found) throw new Error(`Missing button ${label}`);
  return found;
}
async function click(label: string, parent?: ParentNode) {
  await act(async () => button(label, parent).click());
}

it('uses canonical identity, complete totals and frozen detail pages, escaping names', async () => {
  const read = vi.fn<HookStatisticsSource['readPage']>(async (_id, options) =>
    page(options.start, options.limit),
  );
  await render(source(read));
  expect(read).toHaveBeenCalledWith('history', { limit: 1 });
  await act(async () => button('Hook statistics').focus());
  const tooltip = portal.querySelector('[role="tooltip"]');
  expect(tooltip?.textContent).toContain('Hook statistics');
  expect(tooltip?.textContent).toContain(
    '51 runs · 0 blocked · 0 failed · 5.10 s',
  );
  expect(tooltip?.querySelector('dl')).toBeNull();
  expect(read).toHaveBeenCalledTimes(1);
  await click('Hook statistics');
  const dialog = portal.querySelector('[role="dialog"]')!;
  expect(dialog).not.toBeNull();
  expect(dialog.querySelector('dd')?.textContent).toBe('51');
  expect(dialog.textContent).toContain('5.10 s');
  expect(dialog.textContent).not.toContain('Succeeded:');
  expect(dialog.textContent).not.toContain('Parallel durations overlap');
  expect(dialog.textContent).not.toContain(
    'Some execution durations are unavailable.',
  );
  expect(dialog.textContent).not.toContain('Refresh');
  expect(dialog.querySelectorAll('[data-slot="collapsible"]')).toHaveLength(50);
  expect(dialog.textContent).toContain('<script>safe text</script>');
  expect(dialog.querySelector('script')).toBeNull();
  await click('Load 50 more', dialog);
  expect(read).toHaveBeenLastCalledWith('history', {
    snapshot: 'frozen',
    start: 50,
    limit: 50,
  });
  expect(dialog.querySelectorAll('[data-slot="collapsible"]')).toHaveLength(51);
});

it.each(['unrecorded', 'unsupported'] as const)(
  'hides an empty %s turn',
  async (coverage) => {
    container = undefined!;
    await render(
      source(async () => ({
        ...page(),
        coverage,
        totalExecutions: 0,
        executions: [],
        summary: null,
      })),
    );
    expect(
      container.querySelector('[aria-label="Hook statistics"]'),
    ).toBeNull();
  },
);

it('keeps pagination failures retryable without losing the first page', async () => {
  container = undefined!;
  let fail = true;
  const read = vi.fn<HookStatisticsSource['readPage']>(async (_id, options) => {
    if (options.start && fail) {
      fail = false;
      throw new Error('unavailable');
    }
    return page(options.start, options.limit);
  });
  await render(source(read));
  await click('Hook statistics');
  await click('Load 50 more');
  expect(portal.querySelector('[role="alert"]')).not.toBeNull();
  expect(portal.querySelectorAll('[data-slot="collapsible"]')).toHaveLength(50);
  await click('Retry');
  expect(portal.querySelectorAll('[data-slot="collapsible"]')).toHaveLength(51);
  expect(portal.querySelector('[role="alert"]')).toBeNull();
});

it('does not display a late response after switching session', async () => {
  container = undefined!;
  let resolve!: (value: HookTurnPage) => void;
  const pending = new Promise<HookTurnPage>((done) => {
    resolve = done;
  });
  const original = source(() => pending);
  await render(original);
  await render(original, { sessionId: 'other', recordId: 'record' });
  await act(async () => resolve(page()));
  expect(container.querySelector('button')).toBeNull();
  expect(portal.querySelector('[role="dialog"]')).toBeNull();
});

it('keeps an initial summary failure reachable and retries through the dialog', async () => {
  const read = vi
    .fn<HookStatisticsSource['readPage']>()
    .mockRejectedValueOnce(new Error('temporary failure'))
    .mockImplementation(async (_id, options) =>
      page(options.start, options.limit),
    );
  await render(source(read));
  expect(read).toHaveBeenCalledTimes(1);
  expect(
    container.querySelector('[aria-label="Hook statistics"]'),
  ).not.toBeNull();
  await act(async () => button('Hook statistics').focus());
  const tooltip = portal.querySelector('[role="tooltip"]');
  expect(tooltip?.textContent).toContain('Hook statistics');
  expect(tooltip?.textContent).toContain('Could not load hook records.');
  expect(portal.querySelector('dl')).toBeNull();
  await click('Hook statistics');
  expect(portal.querySelector('[role="dialog"] dd')?.textContent).toBe('51');
  expect(read).toHaveBeenLastCalledWith('history', { limit: 50 });
});

it('refreshes only the affected turn when another turn receives live hook events', async () => {
  vi.useFakeTimers();
  const read = vi.fn<HookStatisticsSource['readPage']>(async (promptId) => ({
    ...page(),
    promptId,
  }));
  const value = source(read);
  const initial = value.navigation.getSnapshot();
  const index = initial.indexPages.get(0)!;
  vi.spyOn(value.navigation, 'getSnapshot').mockReturnValue({
    ...initial,
    indexPages: new Map([
      [
        0,
        {
          ...index,
          end: 2,
          turns: [
            ...index.turns,
            {
              ordinal: 1,
              turnId: 'record-2',
              promptId: 'admission-2',
              historyPromptId: 'history-2',
              kind: 'prompt',
              label: 'Second question',
            },
          ],
        },
      ],
    ]),
  });
  const store = createTrajectoryLiveStore();
  const owner = {};
  store.begin(owner, {
    sessionId: 'session',
    scope: 'test',
    events: [],
    incomplete: false,
  });
  store.ingest(owner, { v: 1, type: 'replay_complete', data: {} });
  await render(
    value,
    [
      turn,
      { sessionId: 'session', recordId: 'record-2', promptId: 'admission-2' },
    ],
    store,
  );
  expect(read.mock.calls.map(([promptId]) => promptId)).toEqual([
    'history',
    'history-2',
  ]);
  const event: DaemonEvent = {
    v: 1,
    id: 1,
    type: 'session_update',
    promptId: 'admission-2',
    data: {
      sessionId: 'session',
      update: {
        sessionUpdate: 'agent_message_chunk',
        content: { type: 'text', text: '' },
        _meta: {
          hookLifecycle: {
            ...entries[0].event,
            promptId: 'history-2',
            executionId: 'second-hook',
          },
        },
      },
    },
  };
  await act(async () => store.ingest(owner, event));
  await act(async () => {
    await vi.advanceTimersByTimeAsync(300);
  });
  expect(
    read.mock.calls.filter(([promptId]) => promptId === 'history'),
  ).toHaveLength(1);
  expect(
    read.mock.calls.filter(([promptId]) => promptId === 'history-2'),
  ).toHaveLength(2);
});
