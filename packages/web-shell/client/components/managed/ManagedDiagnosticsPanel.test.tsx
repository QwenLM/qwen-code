// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { I18nProvider } from '../../i18n';
import { ManagedDiagnosticsPanel } from './ManagedDiagnosticsPanel';
import {
  activityStatistics,
  activityPage,
} from './managed-activity.test-fixtures';
import type { ManagedDiagnosticsProvider } from './managed-agent-provider';
import {
  diagnosticContext,
  diagnosticResources,
  diagnosticStats,
  diagnosticTrace,
} from './managed-diagnostics.test-fixtures';

describe('ManagedDiagnosticsPanel', () => {
  let root: Root;
  let container: HTMLDivElement;
  let provider: ManagedDiagnosticsProvider;
  let onOpenChild: ReturnType<typeof vi.fn>;
  beforeEach(() => {
    container = document.createElement('div');
    document.body.append(container);
    root = createRoot(container);
    onOpenChild = vi.fn();
    provider = {
      getContextUsage: vi.fn().mockResolvedValue(diagnosticContext),
      getStatistics: vi.fn().mockResolvedValue(diagnosticStats),
      getResources: vi.fn().mockResolvedValue(diagnosticResources),
      listAgentTrace: vi.fn().mockResolvedValue(diagnosticTrace),
      getActivityStatistics: vi.fn().mockResolvedValue(activityStatistics),
      listActivity: vi.fn().mockResolvedValue(activityPage),
    };
  });
  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    vi.restoreAllMocks();
    vi.useRealTimers();
  });
  async function render(language: 'en' | 'zh-CN' = 'en') {
    await act(async () =>
      root.render(
        <I18nProvider language={language}>
          <ManagedDiagnosticsPanel
            provider={provider}
            sessionId="s1"
            clientId="actor"
            running={false}
            onClose={vi.fn()}
            restoreFocus={vi.fn()}
            onOpenChild={onOpenChild}
          />
        </I18nProvider>,
      ),
    );
  }
  async function selectTab(text: string) {
    const element = [
      ...document.querySelectorAll<HTMLButtonElement>('[role="tab"]'),
    ].find((item) => item.textContent === text)!;
    expect(element).toBeDefined();
    await act(async () => {
      element.dispatchEvent(
        new MouseEvent('mousedown', { bubbles: true, button: 0 }),
      );
      element.click();
    });
  }

  it('shows estimated categories and unknown usage independently of the saved request', async () => {
    vi.mocked(provider.getContextUsage).mockResolvedValue({
      ...diagnosticContext,
      stale: true,
      staleReasons: ['context_changed'],
    });
    await render();
    const panel = document.querySelector('[role="tabpanel"]')!;
    expect(panel.textContent).toContain('model-a');
    expect(panel.textContent).toContain('Input tokensUnknown');
    expect(panel.textContent).toContain('System prompt100');
    expect(panel.textContent).toContain('predates a context change');
    expect(panel.textContent).toContain('Categories are local estimates');
    expect(
      document
        .querySelector('[role="tab"][aria-selected="true"]')
        ?.getAttribute('aria-controls'),
    ).toBe(panel.id);
  });

  it('displays the Session-owned model totals and preserves partial coverage', async () => {
    vi.mocked(provider.getStatistics).mockResolvedValue({
      ...diagnosticStats,
      availability: 'partial',
      coverageReasons: ['legacy_history'],
    });
    await render();
    await selectTab('Statistics');
    expect(document.body.textContent).toContain(
      'Counts belong to this Session',
    );
    expect(document.body.textContent).toContain(
      'Some observations are unavailable',
    );
    expect(document.body.textContent).toContain('Input tokens100');
    expect(document.body.textContent).toContain('Backoff retry calls0');
    expect(document.body.textContent).not.toContain('Input tokensUnknown');
  });

  it('keeps manual Skills and historical MCP discovery visible without claiming live connectivity', async () => {
    await render('zh-CN');
    await selectTab('资源');
    expect(document.body.textContent).toContain('manual-skill');
    expect(document.body.textContent).toContain('模型可调用否');
    expect(document.body.textContent).toContain('用户可调用是');
    expect(document.body.textContent).toContain('历史发现结果');
    expect(document.body.textContent).toContain('不代表服务器当前在线');
    expect(provider.getResources).toHaveBeenCalledTimes(1);
  });

  it('labels token totals that cover only some model calls', async () => {
    const statistics = diagnosticStats.statistics!;
    vi.mocked(provider.getStatistics).mockResolvedValue({
      ...diagnosticStats,
      availability: 'partial',
      coverageReasons: ['missing_usage'],
      statistics: {
        ...statistics,
        totals: {
          ...statistics.totals,
          requests: { ...statistics.totals.requests, total: 2, error: 1 },
        },
      },
    });
    await render();
    await selectTab('Statistics');
    expect(document.body.textContent).toContain(
      'Input tokens100 (Recorded calls: 1/2)',
    );
    expect(document.body.textContent).toContain('Reasoning tokensUnknown');
    expect(document.body.textContent).toContain(
      'Some token usage fields were not reported.',
    );
  });

  it('offers a child link only for an authorized child identity', async () => {
    vi.mocked(provider.listAgentTrace).mockResolvedValue({
      ...diagnosticTrace,
      items: [
        ...diagnosticTrace.items,
        {
          ...diagnosticTrace.items[0],
          taskId: 'restricted',
          description: 'Restricted child',
          childSessionId: null,
        },
      ],
    });
    await render();
    await selectTab('Child agents');
    const links = [
      ...document.querySelectorAll<HTMLButtonElement>('button'),
    ].filter((button) => button.textContent === 'Open child Session');
    expect(links).toHaveLength(1);
    expect(document.body.textContent).toContain('Restricted child');
    await act(async () => links[0].click());
    expect(onOpenChild).toHaveBeenCalledWith('child-a');
  });

  it('explains resource truncation and individual partial discovery', async () => {
    const server = diagnosticResources.servers[0];
    vi.mocked(provider.getResources).mockResolvedValue({
      ...diagnosticResources,
      availability: 'partial',
      coverageReasons: ['extension_attribution_unavailable'],
      outputTruncated: true,
      servers: [
        { ...server, discovery: { ...server.discovery, tools: 'partial' } },
      ],
    });
    await render();
    await selectTab('Resources');
    expect(document.body.textContent).toContain(
      'Extension attribution is unavailable.',
    );
    expect(document.body.textContent).toContain(
      'Some resource entries were omitted',
    );
    expect(document.body.textContent).toContain('Tools · Partial');
  });

  it('shows an unknown observation time and the specific model coverage gap', async () => {
    vi.mocked(provider.getStatistics).mockResolvedValue({
      ...diagnosticStats,
      availability: 'partial',
      coverageReasons: ['unclosed_turn'],
      statistics: { ...diagnosticStats.statistics!, observedAt: 0 },
    });
    await render();
    await selectTab('Statistics');
    expect(document.body.textContent).toContain('ObservedUnknown');
    expect(document.body.textContent).toContain('A prior turn did not settle.');
    expect(document.body.textContent).not.toContain('1970');
  });

  it('keeps the previous-page control after a failed trace page without retaining old rows', async () => {
    vi.mocked(provider.listAgentTrace).mockImplementation(
      async (_session, request) => {
        if (request.cursor) throw new Error('Invalid or expired cursor');
        return { ...diagnosticTrace, nextCursor: 'older', hasMore: true };
      },
    );
    await render();
    await selectTab('Child agents');
    const button = (label: string) =>
      [...document.querySelectorAll<HTMLButtonElement>('button')].find(
        (entry) => entry.textContent === label,
      )!;
    await act(async () => button('Next page').click());
    expect(document.querySelector('[role="alert"]')?.textContent).toContain(
      'Could not read diagnostics',
    );
    expect(document.body.textContent).not.toContain(
      diagnosticTrace.items[0].description!,
    );
    expect(button('Previous page').disabled).toBe(false);
    await act(async () => button('Previous page').click());
    expect(document.querySelector('[role="alert"]')).toBeNull();
    expect(document.body.textContent).toContain(
      diagnosticTrace.items[0].description!,
    );
  });

  it('shows partial delivery independently of successful execution and its collection start', async () => {
    await render();
    await selectTab('Statistics');
    const tools = [
      ...document.querySelectorAll<HTMLButtonElement>('button'),
    ].find((button) => button.textContent === 'Tools')!;
    await act(async () => tools.click());
    expect(provider.listActivity).toHaveBeenCalledWith(
      's1',
      expect.objectContaining({ kind: 'tools', limit: 50 }),
    );
    expect(document.body.textContent).toContain('Observed since');
    expect(document.body.textContent).toContain('read_file');
    expect(document.body.textContent).toContain('ExecutionSuccess');
    expect(document.body.textContent).toContain('Delivery');
    expect(document.body.textContent).toContain('DeliveryPartial');
    expect(document.body.textContent).toContain(
      'Some observations are unavailable or incomplete.',
    );
    expect(
      [...document.querySelectorAll('button')].filter(
        (button) => button.textContent === 'Refresh',
      ),
    ).toHaveLength(1);
    expect(document.body.textContent).toContain('assistant-1');
  });

  it('shows measured zero, independent model/applied lines and a sample-based duration mean', async () => {
    const statistics = structuredClone(activityStatistics);
    statistics.statistics!.tools.requested = 4;
    statistics.statistics!.tools.measurements = {
      availability: 'partial',
      recorded: '2',
      unsupported: '0',
      partial: '0',
      executionDurationMs: '6',
      executionDurationSamples: '2',
      fileSamples: '2',
      modelDiffSamples: '1',
      appliedDiffSamples: '1',
      modelLinesAdded: '3',
      modelLinesRemoved: '1',
      appliedLinesAdded: '0',
      appliedLinesRemoved: '0',
    };
    statistics.statistics!.measurementStartSequence = '9';
    vi.mocked(provider.getActivityStatistics!).mockResolvedValue(statistics);
    const page = structuredClone(activityPage);
    page.items[0].delivery = 'unavailable';
    page.items[0].measurements = {
      availability: 'available',
      sourceSequence: '9',
      executionDurationMs: '0',
      file: {
        operation: 'edit',
        status: 'unchanged',
        modelLinesAdded: '3',
        modelLinesRemoved: '1',
        appliedLinesAdded: '0',
        appliedLinesRemoved: '0',
      },
    };
    vi.mocked(provider.listActivity!).mockResolvedValue(page);
    await render();
    await selectTab('Statistics');
    await act(async () =>
      [...document.querySelectorAll('button')]
        .find((button) => button.textContent === 'Tools')!
        .click(),
    );
    const text = document.body.textContent!;
    expect(text).toContain('3.0 ms');
    expect(text).not.toContain('1.5 ms');
    expect(text).toContain('0 ms');
    expect(text).toContain('+3 / −1');
    expect(text).toContain('+0 / −0');
    expect(text).toContain('Unchanged');
    expect(text).toContain('First measurement sequence');
    expect(text).toContain('DeliveryUnavailable');
  });

  it.each(['statistics-session', 'page-session', 'page-kind'])(
    'rejects mismatched activity identity: %s',
    async (mismatch) => {
      if (mismatch === 'statistics-session')
        vi.mocked(provider.getActivityStatistics!).mockResolvedValue({
          ...activityStatistics,
          sessionId: 'foreign',
        });
      else
        vi.mocked(provider.listActivity!).mockResolvedValue({
          ...activityPage,
          ...(mismatch === 'page-session'
            ? { sessionId: 'foreign' }
            : { kind: 'skills' as const }),
        });
      await render();
      await selectTab('Statistics');
      const tools = [...document.querySelectorAll('button')].find(
        (button) => button.textContent === 'Tools',
      )!;
      await act(async () => tools.click());
      expect(document.querySelector('[role="alert"]')?.textContent).toContain(
        'Could not read diagnostics',
      );
      expect(document.body.textContent).not.toContain('assistant-1');
      expect(document.body.textContent).not.toContain('read_file');
    },
  );

  it.each(['partial', 'unsupported'] as const)(
    'preserves %s availability beside a child Session own usage',
    async (availability) => {
      vi.mocked(provider.getStatistics).mockImplementation(
        async (sessionId) => ({
          ...diagnosticStats,
          sessionId,
          availability,
        }),
      );
      await render();
      await selectTab('Child agents');
      const own = [...document.querySelectorAll('button')].find(
        (button) => button.textContent === 'View own usage',
      )!;
      await act(async () => own.click());
      expect(document.body.textContent).toContain(
        availability === 'partial'
          ? 'Some observations are unavailable or incomplete.'
          : 'This Session has no supported diagnostic records.',
      );
      if (availability === 'partial')
        expect(document.body.textContent).toContain('Total tokens: 110');
    },
  );

  it('clears a stopped Session tree when the next visible permission check fails', async () => {
    vi.mocked(provider.listAgentTrace).mockResolvedValue({
      ...diagnosticTrace,
      items: [{ ...diagnosticTrace.items[0], state: 'completed' }],
    });
    await render();
    vi.useFakeTimers();
    await selectTab('Child agents');
    expect(document.querySelectorAll('[role="treeitem"]')).toHaveLength(1);
    vi.mocked(provider.listAgentTrace).mockRejectedValue(
      new Error('Access revoked'),
    );
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5000);
    });
    expect(document.querySelectorAll('[role="treeitem"]')).toHaveLength(0);
    expect(document.body.textContent).toContain('Could not read diagnostics');
  });

  it('refreshes active child usage after a transient failure while the parent is idle', async () => {
    let childReads = 0;
    vi.mocked(provider.listAgentTrace).mockResolvedValue({
      ...diagnosticTrace,
      items: [{ ...diagnosticTrace.items[0], state: 'running' }],
    });
    vi.mocked(provider.getStatistics).mockImplementation(async (sessionId) => {
      if (sessionId === 'child-a' && childReads++ === 0)
        throw new Error('Transient');
      return { ...diagnosticStats, sessionId };
    });
    await render();
    await selectTab('Child agents');
    vi.useFakeTimers();
    const own = [
      ...document.querySelectorAll<HTMLButtonElement>('button'),
    ].find((button) => button.textContent === 'View own usage')!;
    await act(async () => own.click());
    expect(document.body.textContent).toContain('Could not read diagnostics');
    await act(async () => {
      await vi.advanceTimersByTimeAsync(5000);
    });
    expect(childReads).toBe(2);
    expect(document.body.textContent).not.toContain(
      'Could not read diagnostics',
    );
  });

  it('expands verified child sessions lazily and checks ancestors before reading descendants', async () => {
    vi.mocked(provider.getStatistics).mockImplementation(async (sessionId) => ({
      ...diagnosticStats,
      sessionId,
    }));
    vi.mocked(provider.listAgentTrace).mockImplementation(async (sessionId) =>
      sessionId === 's1'
        ? diagnosticTrace
        : {
            ...diagnosticTrace,
            sessionId,
            items: [
              {
                ...diagnosticTrace.items[0],
                taskId: 'nested',
                childSessionId: 'child-b',
                description: 'Nested invocation',
              },
            ],
          },
    );
    await render();
    await selectTab('Child agents');
    expect(provider.listAgentTrace).not.toHaveBeenCalledWith(
      'child-a',
      expect.anything(),
    );
    const expand = [
      ...document.querySelectorAll<HTMLButtonElement>('button'),
    ].find((button) => button.textContent === 'Expand calls')!;
    await act(async () => expand.click());
    expect(provider.getStatistics).toHaveBeenCalledWith(
      's1',
      expect.anything(),
    );
    expect(provider.listAgentTrace).toHaveBeenCalledWith(
      'child-a',
      expect.objectContaining({ limit: 20 }),
    );
    expect(document.body.textContent).toContain('Nested invocation');
    expect(document.querySelectorAll('[role="treeitem"]')).toHaveLength(2);
  });
});
