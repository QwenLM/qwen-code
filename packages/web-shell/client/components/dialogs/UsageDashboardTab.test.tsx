// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { I18nProvider } from '../../i18n';

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

interface HookState {
  dashboard: unknown;
  loading: boolean;
  error: Error | null;
  reload: () => Promise<void>;
}

const reload = vi.fn(async () => undefined);
let mockState: HookState = {
  dashboard: undefined,
  loading: false,
  error: null,
  reload,
};
// Captures the options the tab passes to the hook, so we can assert the
// selected range flows through (which is what drives the refetch).
let lastUsageOpts: { range?: string } | undefined;

vi.mock('@qwen-code/webui/daemon-react-sdk', () => ({
  useUsageDashboard: (opts: { range?: string } = {}) => {
    lastUsageOpts = opts;
    return mockState;
  },
}));

const { UsageDashboardTab } = await import('./UsageDashboardTab');

// Numbers mirror the design mockup so the test doubles as a visual spec.
function makeDashboard(overrides: Record<string, unknown> = {}) {
  return {
    generatedAt: '2026-07-06T00:00:00.000Z',
    range: 'today',
    summary: {
      totalTokens: 746_700_000,
      inputTokens: 742_100_000,
      outputTokens: 4_600_000,
      cachedTokens: 712_416_000,
      thoughtsTokens: 0,
      requests: 4682,
      sessions: 109,
      toolCalls: 6367,
      linesAdded: 900,
      linesRemoved: 23,
      cacheReadRate: 0.96,
    },
    models: [
      {
        model: 'gpt-5.5',
        totalTokens: 4_170_500_000,
        cacheReadRate: 0.92,
        share: 0.44,
      },
      {
        model: 'claude-opus-4-8',
        totalTokens: 3_310_000_000,
        cacheReadRate: 0.98,
        share: 0.35,
      },
    ],
    skills: [
      { name: 'qreview', count: 5733 },
      { name: 'simplify', count: 1 },
    ],
    daily: [
      { date: '2026-06-30', tokens: 1_700_000_000, sessions: 580 },
      { date: '2026-07-01', tokens: 1_500_000_000, sessions: 490 },
      { date: '2026-07-06', tokens: 800_000_000, sessions: 110 },
    ],
    heatmap: {
      '2026-07-06': { tokens: 746_700_000, cacheReadRate: 0.96 },
      '2026-05-01': { tokens: 120_000_000, cacheReadRate: 0.9 },
    },
    heatmapDays: 183,
    currentStreak: 5,
    longestStreak: 20,
    ...overrides,
  };
}

let container: HTMLDivElement | null = null;
let root: Root | null = null;

function renderTab(language: 'en' | 'zh-CN' = 'en') {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => {
    root!.render(
      <I18nProvider language={language}>
        <UsageDashboardTab />
      </I18nProvider>,
    );
  });
}

function segments(): HTMLButtonElement[] {
  return Array.from(
    container!.querySelectorAll<HTMLButtonElement>('[role="group"] button'),
  );
}

/** Strip grouping separators so digit assertions survive locale differences. */
function digits(): string {
  return (container!.textContent ?? '').replace(/[\s,]/g, '');
}

afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
  root = null;
  container = null;
  lastUsageOpts = undefined;
});

describe('UsageDashboardTab', () => {
  it('renders hero, stats, breakdown and heatmap from the dashboard', () => {
    mockState = {
      dashboard: makeDashboard(),
      loading: false,
      error: null,
      reload,
    };
    renderTab();
    const text = digits();
    // Hero + compact token breakdown.
    expect(text).toContain('746.7M');
    expect(text).toContain('742.1M');
    expect(text).toContain('4.6M');
    expect(text).toContain('96%');
    // Stat tiles.
    expect(text).toContain('109');
    expect(text).toContain('4682');
    expect(text).toContain('6367');
    expect(text).toContain('923'); // changes = linesAdded + linesRemoved

    // Heatmap grid rendered with a full trailing window of day cells.
    const grid = container!.querySelector('[aria-label="Token Heatmap"]');
    expect(grid).not.toBeNull();
    expect(grid!.querySelectorAll('div').length).toBeGreaterThan(150);
  });

  it('renders model share, skill table, and daily charts', () => {
    mockState = {
      dashboard: makeDashboard(),
      loading: false,
      error: null,
      reload,
    };
    renderTab();
    const text = digits();

    // Model-share rows: name, share %, and "tokens · cache %" meta.
    expect(text).toContain('gpt-5.5');
    expect(text).toContain('claude-opus-4-8');
    expect(text).toContain('44%');
    expect(text).toContain('4170.5M');
    expect(text).toContain('cache92%');

    // Skill-calls table.
    expect(text).toContain('qreview');
    expect(text).toContain('5733');

    // Daily tokens renders as an inline SvgLineChart (svg[role="img"]).
    expect(
      container!.querySelectorAll('svg[role="img"]').length,
    ).toBeGreaterThanOrEqual(1);
    // Daily sessions bar chart section renders (locale-independent sub-label).
    expect(text).toContain('activesessioncountsperday');
  });

  it('renders the Today/7D/30D toggle and passes the selected range to the hook', () => {
    mockState = {
      dashboard: makeDashboard(),
      loading: false,
      error: null,
      reload,
    };
    renderTab();
    const btns = segments();
    expect(btns.map((b) => b.textContent)).toEqual(['Today', '7D', '30D']);
    // Default is Today.
    expect(btns[0]!.getAttribute('aria-pressed')).toBe('true');
    expect(btns[1]!.getAttribute('aria-pressed')).toBe('false');
    expect(lastUsageOpts?.range).toBe('today');

    // Selecting 7D flips the pressed state and refetches with range=week.
    act(() => {
      btns[1]!.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });
    const after = segments();
    expect(after[1]!.getAttribute('aria-pressed')).toBe('true');
    expect(after[0]!.getAttribute('aria-pressed')).toBe('false');
    expect(lastUsageOpts?.range).toBe('week');
  });

  it('labels the hero with the range the server echoed', () => {
    mockState = {
      dashboard: makeDashboard({ range: 'month' }),
      loading: false,
      error: null,
      reload,
    };
    renderTab();
    // Hero label follows dashboard.range (server echo), not the pending click.
    expect(container!.textContent ?? '').toContain('Last 30 days');
  });

  it('shows the empty state and no heatmap when there is no usage', () => {
    mockState = {
      dashboard: makeDashboard({
        summary: {
          totalTokens: 0,
          inputTokens: 0,
          outputTokens: 0,
          cachedTokens: 0,
          thoughtsTokens: 0,
          requests: 0,
          sessions: 0,
          toolCalls: 0,
          linesAdded: 0,
          linesRemoved: 0,
          cacheReadRate: 0,
        },
        models: [],
        skills: [],
        daily: [],
        heatmap: {},
      }),
      loading: false,
      error: null,
      reload,
    };
    renderTab();
    expect(container!.textContent ?? '').toContain(
      'No token usage recorded yet.',
    );
    expect(container!.querySelector('[aria-label="Token Heatmap"]')).toBeNull();
  });

  it('shows a loading placeholder before data arrives (toggle still present)', () => {
    mockState = { dashboard: undefined, loading: true, error: null, reload };
    renderTab();
    expect(container!.textContent ?? '').toContain('Loading usage');
    // The period toggle renders even before the first payload lands.
    expect(segments()).toHaveLength(3);
  });

  it('surfaces an error when the load fails', () => {
    mockState = {
      dashboard: undefined,
      loading: false,
      error: new Error('daemon offline'),
      reload,
    };
    renderTab();
    const text = container!.textContent ?? '';
    expect(text).toContain('Failed to load usage');
    expect(text).toContain('daemon offline');
  });

  it('renders localized labels in zh-CN', () => {
    mockState = {
      dashboard: makeDashboard(),
      loading: false,
      error: null,
      reload,
    };
    renderTab('zh-CN');
    const text = container!.textContent ?? '';
    expect(text).toContain('今日');
    expect(text).toContain('Token 拆分');
    expect(text).toContain('Token 热力图');
  });
});
