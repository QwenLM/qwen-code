// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { I18nProvider } from '../../i18n';
import { ManagedDiagnosticsPanel } from './ManagedDiagnosticsPanel';
import type { ManagedDiagnosticsProvider } from './managed-agent-provider';
import {
  diagnosticResources,
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
});
