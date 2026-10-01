// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest';
import { act, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import {
  createDaemonTranscriptState,
  reduceDaemonTranscriptEvents,
  type DaemonSessionStatsStatus,
} from '@qwen-code/sdk/daemon';
import { I18nProvider } from '../../i18n';
import { transcriptBlocksToDaemonMessages } from '../../adapters/transcriptToMessages';
import {
  createStatsMessageData,
  parseStatsMessage,
  serializeStatsMessage,
  StatsMessage,
  type StatsView,
} from './StatsMessage';
import { SystemMessage } from './SystemMessage';

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;
const mounted: Array<{ root: Root; container: HTMLElement }> = [];
afterEach(() => {
  for (const { root, container } of mounted.splice(0)) {
    act(() => root.unmount());
    container.remove();
  }
});

const metrics = {
  api: { totalRequests: 2, totalErrors: 0, totalLatencyMs: 2345 },
  tokens: {
    prompt: 1234567,
    candidates: 12345,
    total: 1246912,
    cached: 10000,
    thoughts: 12,
  },
};
const status: DaemonSessionStatsStatus = {
  v: 1,
  sessionId: 'stats-test',
  workspaceCwd: '/tmp/stats-test',
  sessionStartTimeMs: 1000,
  durationMs: 42000,
  promptCount: 2,
  models: {
    '通义千问-qwen3-coder-plus-2025-09-23': metrics,
    'claude-sonnet-4-20250514::研究员': metrics,
  },
  tools: {
    totalCalls: 0,
    totalSuccess: 0,
    totalFail: 0,
    totalDurationMs: 0,
    byName: {},
  },
  files: { totalLinesAdded: 0, totalLinesRemoved: 0 },
  sources: Array.from({ length: 800 }, (_, i) => ({
    id: `agent-${i}`,
    type: 'researcher',
    name: `研究员-${i}`,
    tokens: metrics.tokens,
  })),
};

function render(node: ReactNode, language: 'en' | 'zh-CN' = 'en') {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  act(() =>
    root.render(<I18nProvider language={language}>{node}</I18nProvider>),
  );
  mounted.push({ root, container });
  return container;
}

describe('StatsMessage', () => {
  it.each(['overview', 'model', 'tools'] as const)(
    'renders large %s statistics through the real transcript pipeline',
    (view) => {
      expect(serializeStatsMessage(status, view).length).toBeGreaterThan(
        100000,
      );
      const data = createStatsMessageData(status, view);
      const state = reduceDaemonTranscriptEvents(
        createDaemonTranscriptState(),
        [
          {
            type: 'status',
            text: 'Session Stats',
            data,
            clearActiveText: false,
          },
        ],
      );
      const message = transcriptBlocksToDaemonMessages(state.blocks)[0];
      expect(message.role).toBe('system');
      if (message.role !== 'system')
        throw new Error('Expected a system message');
      expect(parseStatsMessage(message.content, message.data)).toEqual({
        view,
        status,
      });
      expect(
        parseStatsMessage(message.content, message.data)?.status.sources,
      ).toHaveLength(800);
      const container = render(
        <SystemMessage
          content={message.content}
          data={message.data}
          variant={message.variant}
        />,
      );
      const titles = {
        overview: 'Session Overview',
        model: 'Model Stats',
        tools: 'Tool Stats',
      };
      expect(container.textContent).toContain(titles[view]);
      expect(container.textContent).not.toContain('web-shell:session-stats');
      expect(container.textContent).not.toContain('[truncated]');
      if (view === 'model')
        expect(container.textContent).toContain('1,246,912');
    },
  );

  it.each(['overview', 'model', 'tools'] as const)(
    'still parses legacy %s messages',
    (view: StatsView) => {
      const legacyStatus = { ...status, sources: [] };
      expect(
        parseStatsMessage(serializeStatsMessage(legacyStatus, view)),
      ).toEqual({ view, status: legacyStatus });
    },
  );

  it('does not interpret unrelated status data as statistics', () => {
    expect(
      parseStatsMessage('plain note', { type: 'other', status }),
    ).toBeNull();
    expect(
      parseStatsMessage('plain note', { type: 'web-shell:session-stats:v1:' }),
    ).toBeNull();
  });

  it('renders Unicode model headers and numeric rows in the same table', () => {
    const container = render(
      <StatsMessage view="model" status={status} />,
      'zh-CN',
    );
    const headers = Array.from(
      container.querySelectorAll('thead th'),
      (cell) => cell.textContent,
    );
    expect(headers).toEqual([
      '指标',
      '通义千问-qwen3-coder-plus-2025-09-23',
      'claude-sonnet-4-20250514 (研究员)',
    ]);
    const rows = Array.from(container.querySelectorAll('tbody tr'));
    const requests = rows.find(
      (row) => row.firstElementChild?.textContent === '请求数',
    );
    expect(
      Array.from(
        requests?.querySelectorAll('td') ?? [],
        (cell) => cell.textContent,
      ),
    ).toEqual(['请求数', '2', '2']);
    expect(container.textContent).not.toContain('�');
  });

  it('renders the no-calls state', () => {
    const container = render(
      <StatsMessage view="model" status={{ ...status, models: {} }} />,
      'zh-CN',
    );
    expect(container.textContent).toContain('本次会话暂无 API 调用。');
    expect(container.querySelector('table')).toBeNull();
  });
});
