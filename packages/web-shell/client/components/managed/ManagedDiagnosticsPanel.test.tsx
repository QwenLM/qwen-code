// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { I18nProvider } from '../../i18n';
import { ManagedDiagnosticsPanel } from './ManagedDiagnosticsPanel';
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
    };
  });
  afterEach(async () => {
    await act(async () => root.unmount());
    container.remove();
    vi.restoreAllMocks();
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
    await selectTab('Model statistics');
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
    await selectTab('Model statistics');
    expect(document.body.textContent).toContain(
      'Input tokens100 (Recorded calls: 1/2)',
    );
    expect(document.body.textContent).toContain('Reasoning tokensUnknown');
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
});
