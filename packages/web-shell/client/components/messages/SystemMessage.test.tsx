// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { I18nProvider } from '../../i18n';
import { TranscriptRenderModeProvider } from '../../transcriptRenderMode';
import { serializeGoalStatusMessage } from './GoalStatusMessage';
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

function render(node: ReactNode, language: 'en' | 'zh-CN' = 'en'): HTMLElement {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  act(() => {
    root.render(<I18nProvider language={language}>{node}</I18nProvider>);
  });
  mounted.push({ root, container });
  return container;
}

describe('SystemMessage — prompt_cancelled marker', () => {
  it('renders the user-cancelled marker as a status region', () => {
    const container = render(
      <SystemMessage content="" variant="info" source="prompt_cancelled" />,
    );
    const status = container.querySelector('[role="status"]');
    expect(status).not.toBeNull();
    expect(status?.textContent).toBe('You cancelled this request');
  });

  it('ignores message content when rendering the cancelled marker', () => {
    const container = render(
      <SystemMessage
        content="raw daemon text that must not leak"
        variant="info"
        source="prompt_cancelled"
      />,
    );
    expect(container.textContent).toBe('You cancelled this request');
    expect(container.textContent).not.toContain('raw daemon text');
  });

  it('renders a normal message without the status marker for other sources', () => {
    const container = render(
      <SystemMessage content="a plain note" variant="error" />,
    );
    expect(container.querySelector('[role="status"]')).toBeNull();
    expect(container.textContent).toContain('a plain note');
  });
});

describe('SystemMessage — background notification label', () => {
  it('labels background task notifications and preserves display text', () => {
    const container = render(
      <SystemMessage
        content='Background agent "worker" completed.'
        variant="info"
        source="background_notification"
        data={{ status: 'completed' }}
      />,
    );

    expect(container.textContent).toContain(
      'Background agent "worker" completed.',
    );
    const icon = container.querySelector('[role="img"][data-tone="success"]');
    expect(icon?.getAttribute('aria-label')).toBe('Background task completed');
    expect(icon?.nextElementSibling?.textContent).toContain(
      'Background agent "worker" completed.',
    );
    expect(icon?.querySelector('svg')).not.toBeNull();
  });

  it('localizes the label', () => {
    const container = render(
      <SystemMessage
        content="后台代理已完成。"
        variant="info"
        source="background_notification"
        data={{ status: 'completed' }}
      />,
      'zh-CN',
    );

    expect(
      container
        .querySelector('[role="img"][data-tone="success"]')
        ?.getAttribute('aria-label'),
    ).toBe('后台任务执行完成');
  });

  it.each([
    ['failed', '后台任务执行失败', 'error'],
    ['cancelled', '后台任务已取消', 'neutral'],
    ['unknown', '后台任务通知', 'neutral'],
  ])(
    'uses the matching label and tone for %s status',
    (status, label, tone) => {
      const container = render(
        <SystemMessage
          content="任务结果"
          variant="info"
          source="background_notification"
          data={{ status }}
        />,
        'zh-CN',
      );

      const icon = container.querySelector(`[role="img"][data-tone="${tone}"]`);
      expect(icon?.getAttribute('aria-label')).toBe(label);
      expect(icon?.querySelector('svg')).not.toBeNull();
    },
  );

  it('does not label generic system information', () => {
    const container = render(
      <SystemMessage content="Connected." variant="info" />,
    );

    expect(container.textContent).toBe('Connected.');
  });
});

describe('SystemMessage — background notification i18n body', () => {
  it('renders shell notifications with structured command via i18n', () => {
    const container = render(
      <SystemMessage
        content='Background shell "npm test" completed.'
        variant="info"
        source="background_notification"
        data={{
          status: 'completed',
          kind: 'shell',
          commandLabel: 'npm test',
        }}
      />,
      'zh-CN',
    );

    expect(container.textContent).toContain('后台 Shell 已完成：npm test');
    expect(container.textContent).not.toContain(
      'Background shell "npm test" completed.',
    );
  });

  it('renders agent notifications with structured description via i18n', () => {
    const container = render(
      <SystemMessage
        content='Background agent "worker" completed.'
        variant="info"
        source="background_notification"
        data={{
          status: 'completed',
          kind: 'agent',
          description: 'worker',
        }}
      />,
      'zh-CN',
    );

    expect(container.textContent).toContain('后台智能体已完成：worker');
  });

  it('renders monitor notifications with the event count in English', () => {
    const container = render(
      <SystemMessage
        content="raw daemon text"
        variant="info"
        source="background_notification"
        data={{
          status: 'completed',
          kind: 'monitor',
          description: 'logs',
          eventCount: 5,
        }}
      />,
    );

    expect(container.textContent).toContain(
      'Monitor "logs" completed. (5 events)',
    );
    expect(container.textContent).not.toContain('raw daemon text');
  });

  it('renders the dropped-lines clause when throttling dropped output', () => {
    const container = render(
      <SystemMessage
        content="raw daemon text"
        variant="info"
        source="background_notification"
        data={{
          status: 'completed',
          kind: 'monitor',
          description: 'logs',
          eventCount: 5,
          droppedLines: 2,
        }}
      />,
    );

    expect(container.textContent).toContain(
      'Monitor "logs" completed. (5 events, 2 lines dropped due to throttling)',
    );
  });

  it('renders the dropped-lines clause in zh-CN when throttling dropped output', () => {
    const container = render(
      <SystemMessage
        content="raw daemon text"
        variant="info"
        source="background_notification"
        data={{
          status: 'completed',
          kind: 'monitor',
          description: 'logs',
          eventCount: 5,
          droppedLines: 2,
        }}
      />,
      'zh-CN',
    );

    expect(container.textContent).toContain(
      '监控器已完成（5 个事件，因限流丢弃 2 行）：logs',
    );
  });

  it('renders failed monitor notifications with the event count in zh-CN', () => {
    const container = render(
      <SystemMessage
        content="raw daemon text"
        variant="info"
        source="background_notification"
        data={{
          status: 'failed',
          kind: 'monitor',
          description: 'logs',
          eventCount: 42,
        }}
      />,
      'zh-CN',
    );

    expect(container.textContent).toContain(
      '监控器执行失败（42 个事件）：logs',
    );
  });

  it('renders cancelled shell notifications via i18n', () => {
    const container = render(
      <SystemMessage
        content="raw daemon text"
        variant="info"
        source="background_notification"
        data={{
          status: 'cancelled',
          kind: 'shell',
          commandLabel: 'npm test',
        }}
      />,
      'zh-CN',
    );

    expect(container.textContent).toContain('后台 Shell 已取消：npm test');
  });

  it('renders failed agent notifications via i18n in English', () => {
    const container = render(
      <SystemMessage
        content="raw daemon text"
        variant="info"
        source="background_notification"
        data={{ status: 'failed', kind: 'agent', description: 'worker' }}
      />,
    );

    expect(container.textContent).toContain(
      'Background agent "worker" failed.',
    );
  });

  it('falls back to raw content for unknown terminal statuses', () => {
    const container = render(
      <SystemMessage
        content='Monitor "logs" timed out.'
        variant="info"
        source="background_notification"
        data={{ status: 'timeout', kind: 'monitor', description: 'logs' }}
      />,
    );

    expect(container.textContent).toContain('Monitor "logs" timed out.');
    expect(container.textContent).not.toContain('notification.monitor.timeout');
  });

  it('falls back to raw content when structured fields are absent', () => {
    const container = render(
      <SystemMessage
        content='Background shell "npm test" completed.'
        variant="info"
        source="background_notification"
        data={{ status: 'completed', kind: 'shell' }}
      />,
    );

    expect(container.textContent).toContain(
      'Background shell "npm test" completed.',
    );
  });

  it('renders the fallback through Markdown so session links stay clickable', () => {
    const seen: unknown[] = [];
    const handler = (e: Event) => seen.push((e as CustomEvent).detail);
    window.addEventListener('qwen:open-session', handler);
    const container = render(
      <SystemMessage
        content="Sub-session [🧵 abc12345](qwen-session://abc12345-full) completed."
        variant="info"
        source="background_notification"
        data={{ status: 'completed', kind: 'agent' }}
      />,
    );

    const link = container.querySelector('a[role="button"]');
    expect(link).not.toBeNull();
    expect(link?.textContent).toBe('🧵 abc12345');
    expect(container.textContent).not.toContain('](');
    act(() => {
      link?.dispatchEvent(
        new MouseEvent('click', { bubbles: true, cancelable: true }),
      );
    });
    expect(seen).toEqual(['abc12345-full']);
    window.removeEventListener('qwen:open-session', handler);
  });
});

describe('SystemMessage — goal status activation', () => {
  const content = serializeGoalStatusMessage({
    kind: 'set',
    condition: 'Ship safely',
    setAt: 1,
  });

  it('keeps the existing interactive event behavior by default', () => {
    const handler = vi.fn();
    window.addEventListener('web-shell-goal-status-active', handler);
    const container = render(
      <SystemMessage content={content} variant="info" isLatest />,
    );
    expect(container.textContent).toContain('Ship safely');
    expect(handler).toHaveBeenCalledOnce();
    window.removeEventListener('web-shell-goal-status-active', handler);
  });

  it('does not dispatch the goal event in readonly mode', () => {
    const handler = vi.fn();
    window.addEventListener('web-shell-goal-status-active', handler);
    const container = render(
      <TranscriptRenderModeProvider value="readonly">
        <SystemMessage content={content} variant="info" isLatest />
      </TranscriptRenderModeProvider>,
    );
    expect(container.textContent).toContain('Ship safely');
    expect(handler).not.toHaveBeenCalled();
    window.removeEventListener('web-shell-goal-status-active', handler);
  });
});
