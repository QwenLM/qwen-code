// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { I18nProvider } from '../../i18n';
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
  vi.useRealTimers();
  vi.restoreAllMocks();
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

describe('SystemMessage — goal status', () => {
  it.each([
    ['en', 'Goal usage limited', 'Last check: token budget reached'],
    ['zh-CN', '目标用量受限', '上次检查: token budget reached'],
  ] as const)(
    'renders a usage-limited goal distinctly in %s',
    (language, title, reason) => {
      const container = render(
        <SystemMessage
          content=""
          variant="info"
          source="goal"
          data={{
            kind: 'usage_limited',
            condition: 'finish the evaluation',
            lastReason: 'token budget reached',
          }}
        />,
        language,
      );

      expect(container.textContent).toContain(title);
      expect(container.textContent).toContain(reason);
      expect(container.textContent).not.toContain('Goal aborted');
      expect(container.textContent).not.toContain('目标已中止');
    },
  );
});

describe('SystemMessage — terminal turn error copy', () => {
  it('copies the displayed error without triggering retry', async () => {
    vi.useFakeTimers();
    const clipboardDescriptor = Object.getOwnPropertyDescriptor(
      navigator,
      'clipboard',
    );
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText },
    });
    const onRetryClick = vi.fn();

    try {
      const container = render(
        <SystemMessage
          content="The model stream was interrupted."
          variant="error"
          source="turn_error"
          showRetryHint
          onRetryClick={onRetryClick}
        />,
      );
      const copyButton = container.querySelector<HTMLButtonElement>(
        'button[aria-label="Copy"]',
      );
      expect(copyButton).not.toBeNull();
      expect(container.textContent).toContain('Press Ctrl+Y to retry');

      await act(async () => {
        copyButton?.click();
      });

      expect(writeText).toHaveBeenCalledOnce();
      expect(writeText).toHaveBeenCalledWith(
        'The model stream was interrupted.',
      );
      expect(onRetryClick).not.toHaveBeenCalled();
      expect(copyButton?.querySelector('.lucide-check')).not.toBeNull();

      act(() => vi.advanceTimersByTime(1999));
      expect(copyButton?.querySelector('.lucide-check')).not.toBeNull();
      act(() => vi.advanceTimersByTime(1));
      expect(copyButton?.querySelector('.lucide-copy')).not.toBeNull();
    } finally {
      if (clipboardDescriptor) {
        Object.defineProperty(navigator, 'clipboard', clipboardDescriptor);
      } else {
        Reflect.deleteProperty(navigator, 'clipboard');
      }
    }
  });

  it('keeps the copy icon when writing to the clipboard fails', async () => {
    const clipboardDescriptor = Object.getOwnPropertyDescriptor(
      navigator,
      'clipboard',
    );
    const execCommandDescriptor = Object.getOwnPropertyDescriptor(
      document,
      'execCommand',
    );
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText: vi.fn().mockRejectedValue(new Error('denied')) },
    });
    Object.defineProperty(document, 'execCommand', {
      configurable: true,
      value: vi.fn().mockReturnValue(false),
    });
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

    try {
      const container = render(
        <SystemMessage
          content="The model stream was interrupted."
          variant="error"
          source="turn_error"
        />,
      );
      const copyButton = container.querySelector<HTMLButtonElement>(
        'button[aria-label="Copy"]',
      );

      await act(async () => {
        copyButton?.click();
        await Promise.resolve();
      });

      expect(copyButton?.querySelector('.lucide-copy')).not.toBeNull();
      expect(copyButton?.querySelector('.lucide-check')).toBeNull();
      expect(warn).toHaveBeenCalledOnce();
    } finally {
      if (clipboardDescriptor) {
        Object.defineProperty(navigator, 'clipboard', clipboardDescriptor);
      } else {
        Reflect.deleteProperty(navigator, 'clipboard');
      }
      if (execCommandDescriptor) {
        Object.defineProperty(document, 'execCommand', execCommandDescriptor);
      } else {
        Reflect.deleteProperty(document, 'execCommand');
      }
    }
  });

  it('shows Copy for non-retryable terminal turn errors', () => {
    const container = render(
      <SystemMessage
        content="The model stopped because it was repeating itself."
        variant="error"
        source="turn_error"
      />,
    );

    expect(container.querySelector('button[aria-label="Copy"]')).not.toBeNull();
    expect(container.textContent).not.toContain('retry');
  });

  it('does not add Copy to ordinary system errors', () => {
    const container = render(
      <SystemMessage content="A system error occurred." variant="error" />,
    );

    expect(container.querySelector('button[aria-label="Copy"]')).toBeNull();
  });
});

describe('SystemMessage — vision bridge notice', () => {
  it('localizes a cancelled notice with egress details', () => {
    const container = render(
      <SystemMessage
        content="English fallback"
        variant="info"
        source="vision_bridge_notice"
        data={{
          status: 'skipped',
          convertedCount: 0,
          omittedCount: 0,
          modelName: 'qwen3.6-plus',
          modelEndpoint: 'idealab.alibaba-inc.com',
          egressOccurred: true,
        }}
      />,
      'zh-CN',
    );

    expect(container.textContent).toContain(
      '视觉桥接已取消。你的图片及提示词/上下文已发送至 qwen3.6-plus (idealab.alibaba-inc.com)。',
    );
    expect(container.textContent).not.toContain('English fallback');
  });

  it('falls back to daemon text for malformed metadata', () => {
    const container = render(
      <SystemMessage
        content="Vision bridge fallback"
        variant="info"
        source="vision_bridge_notice"
        data={{ status: 'unknown' }}
      />,
      'zh-CN',
    );

    expect(container.textContent).toContain('Vision bridge fallback');
  });

  it('falls back to daemon text for malformed egress metadata', () => {
    const container = render(
      <SystemMessage
        content="Vision bridge fallback"
        variant="info"
        source="vision_bridge_notice"
        data={{
          status: 'skipped',
          convertedCount: 0,
          omittedCount: 0,
          egressOccurred: 'true',
        }}
      />,
      'zh-CN',
    );

    expect(container.textContent).toContain('Vision bridge fallback');
  });

  it('falls back to daemon text for malformed image counts', () => {
    const container = render(
      <SystemMessage
        content="Vision bridge fallback"
        variant="info"
        source="vision_bridge_notice"
        data={{
          status: 'ok',
          convertedCount: Number.NaN,
          omittedCount: 0,
          egressOccurred: true,
        }}
      />,
      'zh-CN',
    );

    expect(container.textContent).toContain('Vision bridge fallback');
    expect(container.textContent).not.toContain('NaN 张图片');
  });

  it.each([
    [
      {
        status: 'failed',
        convertedCount: 0,
        omittedCount: 0,
        egressOccurred: false,
      },
      '视觉桥接（视觉模型）失败：视觉桥接无法运行。图片未被解析。',
    ],
    [
      {
        status: 'ok',
        convertedCount: 2,
        omittedCount: 1,
        modelName: 'qwen-vl',
        egressOccurred: true,
      },
      '已通过 qwen-vl 将 2 张图片转换为文本（已忽略 1 张图片）。你的图片及提示词/上下文已发送至该模型。',
    ],
  ])('localizes %s notices', (data, expected) => {
    const container = render(
      <SystemMessage
        content="English fallback"
        variant="info"
        source="vision_bridge_notice"
        data={data}
      />,
      'zh-CN',
    );

    expect(container.textContent).toContain(expected);
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

describe('SystemMessage — inline images', () => {
  it('renders image thumbnails when images prop is provided', () => {
    const container = render(
      <SystemMessage
        content="look at this"
        variant="info"
        source="mid_turn_message_injected"
        images={[{ data: 'base64data', mimeType: 'image/png' }]}
      />,
    );

    const img = container.querySelector('img');
    expect(img).not.toBeNull();
    expect(img?.getAttribute('src')).toBe('data:image/png;base64,base64data');
    expect(img?.className).toContain('chatImageThumb');
  });

  it('makes images clickable when onImagePreview is provided', () => {
    const onImagePreview = vi.fn();
    const container = render(
      <SystemMessage
        content="look at this"
        variant="info"
        source="mid_turn_message_injected"
        images={[{ data: 'base64data', mimeType: 'image/png' }]}
        onImagePreview={onImagePreview}
      />,
    );

    const img = container.querySelector('img');
    expect(img?.className).toContain('chatImageThumbInteractive');

    act(() => {
      img?.click();
    });

    expect(onImagePreview).toHaveBeenCalledWith(
      'data:image/png;base64,base64data',
      'User uploaded image 1',
      undefined,
    );
  });

  it('renders multiple images in a row', () => {
    const container = render(
      <SystemMessage
        content="look at these"
        variant="info"
        source="mid_turn_message_injected"
        images={[
          { data: 'img1', mimeType: 'image/png' },
          { data: 'img2', mimeType: 'image/jpeg' },
        ]}
      />,
    );

    const imgs = container.querySelectorAll('img');
    expect(imgs).toHaveLength(2);
    expect(imgs[0]?.getAttribute('src')).toBe('data:image/png;base64,img1');
    expect(imgs[1]?.getAttribute('src')).toBe('data:image/jpeg;base64,img2');
  });

  it('renders injected files with the ordinary user attachment row', () => {
    const onAttachmentPreview = vi.fn();
    const container = render(
      <SystemMessage
        content="explain this"
        variant="info"
        source="mid_turn_message_injected"
        files={[
          {
            name: 'notes.txt',
            mimeType: 'text/plain',
            attachmentId: 'notes.txt',
          },
        ]}
        onAttachmentPreview={onAttachmentPreview}
      />,
    );

    const file = container.querySelector('[role="button"]') as HTMLElement;
    expect(file.textContent).toContain('notes.txt');
    act(() => file.click());
    expect(onAttachmentPreview).toHaveBeenCalledWith({
      name: 'notes.txt',
      mimeType: 'text/plain',
      attachmentId: 'notes.txt',
    });
  });
});
