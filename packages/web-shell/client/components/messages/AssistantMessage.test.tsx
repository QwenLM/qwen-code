// @vitest-environment jsdom
import { act, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { WebShellCustomizationProvider } from '../../customization';
import { I18nProvider } from '../../i18n';

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

vi.mock('../../App', async () => {
  const { createContext } = await import('react');
  return {
    CompactModeContext: createContext(false),
  };
});

const {
  AssistantMessage,
  ThinkingMessage,
  formatThinkingDuration,
  getThinkingSummaryKey,
} = await import('./AssistantMessage');

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

function renderCompletedThinking(
  durationMs: number,
  language: 'en' | 'zh-CN' = 'en',
): HTMLElement {
  vi.setSystemTime(0);
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  mounted.push({ root, container });
  const tree = (isStreaming: boolean) => (
    <I18nProvider language={language}>
      <ThinkingMessage
        messageId={`completed-${durationMs}-${language}`}
        content="private chain of thought"
        isStreaming={isStreaming}
        timestamp={0}
      />
    </I18nProvider>
  );
  act(() => root.render(tree(true)));
  vi.setSystemTime(durationMs);
  act(() => root.render(tree(false)));
  return container;
}

describe('AssistantMessage thinking logic', () => {
  it('uses the running summary while streaming before answer content', () => {
    expect(getThinkingSummaryKey({ isStreaming: true })).toBe(
      'thinking.running',
    );
  });

  it('uses the finished summary after streaming ends', () => {
    expect(getThinkingSummaryKey({ isStreaming: false })).toBe('thinking.done');
    expect(getThinkingSummaryKey({})).toBe('thinking.done');
    expect(getThinkingSummaryKey({ durationMs: 999 })).toBe(
      'thinking.doneBriefly',
    );
    expect(getThinkingSummaryKey({ durationMs: 1000 })).toBe('thinking.done');
  });

  it('formats thinking durations', () => {
    expect(formatThinkingDuration(-1000)).toBe('1s');
    expect(formatThinkingDuration(0)).toBe('1s');
    expect(formatThinkingDuration(1499)).toBe('1s');
    expect(formatThinkingDuration(59_400)).toBe('59s');
    expect(formatThinkingDuration(65_000)).toBe('1m 5s');
    expect(formatThinkingDuration(120_000)).toBe('2m');
  });

  it('keeps replayed completed thinking durationless', () => {
    const container = render(
      <ThinkingMessage
        messageId="replayed"
        content="private chain of thought"
        timestamp={0}
      />,
    );

    expect(container.textContent).toContain('Done thinking');
    expect(container.textContent).not.toContain('Thought for');
  });

  it.each([
    [999, 'Thought briefly'],
    [1000, 'Thought for 1s'],
  ] as const)(
    'shows the completed label for a %dms live thought',
    (durationMs, expectedLabel) => {
      const container = renderCompletedThinking(durationMs);

      expect(container.textContent).toContain(expectedLabel);
      const toggle = container.querySelector<HTMLButtonElement>('button');
      act(() => toggle?.click());
      expect(toggle?.getAttribute('aria-expanded')).toBe('true');
      expect(container.textContent).toContain(expectedLabel);
    },
  );

  it('localizes a brief completed thought in Simplified Chinese', () => {
    const container = renderCompletedThinking(999, 'zh-CN');

    expect(container.textContent).toContain('思考片刻');
  });

  it('keeps the duration while thinking is running', () => {
    vi.setSystemTime(2_000);

    const container = render(
      <ThinkingMessage
        messageId="running"
        content="private chain of thought"
        isStreaming
        timestamp={0}
      />,
    );

    expect(container.textContent).toContain('Thinking 2s');
    expect(container.textContent).not.toContain('private chain of thought');

    const toggle = container.querySelector<HTMLButtonElement>('button');
    act(() => toggle?.parentElement?.click());
    expect(toggle?.getAttribute('aria-expanded')).toBe('true');
    expect(container.textContent).toContain('private chain of thought');

    act(() => toggle?.parentElement?.click());
    expect(toggle?.getAttribute('aria-expanded')).toBe('false');
    expect(container.textContent).not.toContain('private chain of thought');
  });

  it('only translates completed thinking and reuses the in-memory result', async () => {
    const generateContent = vi.fn(async function* () {
      yield {
        v: 1 as const,
        type: 'started' as const,
        requestId: 'request-1',
        model: 'fast-model',
        modelSource: 'fast' as const,
      };
      yield {
        v: 1 as const,
        type: 'thinking' as const,
        requestId: 'request-1',
      };
      yield {
        v: 1 as const,
        type: 'delta' as const,
        requestId: 'request-1',
        seq: 0,
        text: '翻译结果',
      };
      yield {
        v: 1 as const,
        type: 'done' as const,
        requestId: 'request-1',
        model: 'fast-model',
        modelSource: 'fast' as const,
        inputTokens: 12,
        outputTokens: 4,
      };
    });
    const container = render(
      <ThinkingMessage
        messageId="translated-thinking"
        content="private chain of thought"
        generateContent={generateContent}
      />,
      'zh-CN',
    );
    const translateButton =
      container.querySelector<HTMLButtonElement>('button[title="翻译"]');
    expect(translateButton).not.toBeNull();
    expect(translateButton?.tagName).toBe('BUTTON');

    const thinkingToggle = container.querySelector<HTMLButtonElement>(
      'button[title="展开思考"]',
    );
    act(() => thinkingToggle?.click());

    await act(async () => translateButton?.click());
    expect(document.body.textContent).toContain('翻译结果');
    expect(document.body.textContent).toContain('发送 Token：12');
    expect(document.body.textContent).toContain('生成 Token：4');

    const closeButton = Array.from(
      document.body.querySelectorAll<HTMLButtonElement>('button'),
    ).find((button) => button.textContent === '关闭');
    expect(closeButton?.disabled).toBe(false);
    act(() => closeButton?.click());
    expect(document.body.textContent).not.toContain('思考翻译');

    await act(async () => translateButton?.click());
    expect(generateContent).toHaveBeenCalledTimes(1);

    const retranslateButton = Array.from(
      document.body.querySelectorAll<HTMLButtonElement>('button'),
    ).find((button) => button.textContent === '重新翻译');
    await act(async () => retranslateButton?.click());
    expect(generateContent).toHaveBeenCalledTimes(2);
  });

  it('only offers translation when the UI language is Chinese', () => {
    const container = render(
      <ThinkingMessage
        messageId="english-thinking"
        content="private chain of thought"
        generateContent={async function* () {}}
      />,
    );

    act(() =>
      container
        .querySelector<HTMLButtonElement>('button[title="Expand thinking"]')
        ?.click(),
    );
    expect(container.querySelector('button[title="Translate"]')).toBeNull();
  });

  it('shows a failure when generation completes without translated text', async () => {
    const generateContent = async function* () {
      yield {
        v: 1 as const,
        type: 'done' as const,
        requestId: 'empty-translation',
        model: 'fast-model',
        modelSource: 'fast' as const,
      };
    };
    const container = render(
      <ThinkingMessage
        messageId="empty-translation"
        content="private chain of thought"
        generateContent={generateContent}
      />,
      'zh-CN',
    );

    await act(async () => {
      container
        .querySelector<HTMLButtonElement>('button[title="翻译"]')
        ?.click();
    });

    expect(document.body.textContent).toContain('翻译失败');
    expect(document.body.textContent).not.toContain('正在翻译…');
  });

  it('cancels an in-flight translation from the popover footer', async () => {
    let requestSignal: AbortSignal | undefined;
    const generateContent = vi.fn(async function* (
      _prompt: string,
      opts?: { signal?: AbortSignal },
    ) {
      requestSignal = opts?.signal;
      yield {
        v: 1 as const,
        type: 'started' as const,
        requestId: 'cancel-translation',
        model: 'fast-model',
        modelSource: 'fast' as const,
      };
      await new Promise<void>((resolve) => {
        requestSignal?.addEventListener('abort', () => resolve(), {
          once: true,
        });
      });
    });
    const container = render(
      <ThinkingMessage
        messageId="cancel-translation"
        content="private chain of thought"
        generateContent={generateContent}
      />,
      'zh-CN',
    );

    await act(async () => {
      container
        .querySelector<HTMLButtonElement>('button[title="翻译"]')
        ?.click();
    });
    const cancelButton = Array.from(
      document.body.querySelectorAll<HTMLButtonElement>('button'),
    ).find((button) => button.textContent === '取消');
    expect(cancelButton?.disabled).toBe(false);
    await act(async () => cancelButton?.click());

    expect(requestSignal?.aborted).toBe(true);
    expect(document.body.textContent).not.toContain('思考翻译');
  });

  it('shows a thinking status when generation emits thinking', async () => {
    let continueGeneration: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      continueGeneration = resolve;
    });
    const generateContent = async function* () {
      yield {
        v: 1 as const,
        type: 'started' as const,
        requestId: 'request-thinking',
        model: 'fast-model',
        modelSource: 'fast' as const,
      };
      yield {
        v: 1 as const,
        type: 'thinking' as const,
        requestId: 'request-thinking',
      };
      await gate;
      yield {
        v: 1 as const,
        type: 'delta' as const,
        requestId: 'request-thinking',
        seq: 0,
        text: '翻译结果',
      };
      yield {
        v: 1 as const,
        type: 'done' as const,
        requestId: 'request-thinking',
        model: 'fast-model',
        modelSource: 'fast' as const,
      };
    };
    const container = render(
      <ThinkingMessage
        messageId="thinking-translation"
        content="private chain of thought"
        generateContent={generateContent}
      />,
      'zh-CN',
    );

    act(() =>
      container
        .querySelector<HTMLButtonElement>('button[title="展开思考"]')
        ?.click(),
    );
    await act(async () => {
      container
        .querySelector<HTMLButtonElement>('button[title="翻译"]')
        ?.click();
    });
    expect(document.body.textContent).toContain('思考中…');

    await act(async () => continueGeneration?.());
    expect(document.body.textContent).toContain('翻译结果');
  });

  it('does not offer translation while thinking is streaming', () => {
    const container = render(
      <ThinkingMessage
        messageId="still-running"
        content="private chain of thought"
        isStreaming
        generateContent={async function* () {}}
      />,
      'zh-CN',
    );

    expect(container.querySelector('button[title="翻译"]')).toBeNull();
  });
});

describe('AssistantMessage streaming markdown', () => {
  it('limits intermediate renders and flushes final content immediately', () => {
    vi.useFakeTimers();
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);
    mounted.push({ root, container });
    const tree = (content: string, isStreaming: boolean) => (
      <I18nProvider language="en">
        <AssistantMessage content={content} isStreaming={isStreaming} />
      </I18nProvider>
    );

    act(() => root.render(tree('first', true)));
    act(() => root.render(tree('first second', true)));
    expect(container.textContent).toContain('first');
    expect(container.textContent).not.toContain('second');

    act(() => vi.advanceTimersByTime(80));
    expect(container.textContent).toContain('first second');

    act(() => root.render(tree('first second final', false)));
    expect(container.textContent).toContain('first second final');
  });

  it('shows non-monotonic streaming content immediately', () => {
    vi.useFakeTimers();
    const container = document.createElement('div');
    document.body.appendChild(container);
    const root = createRoot(container);
    mounted.push({ root, container });
    const tree = (content: string, isStreaming: boolean) => (
      <I18nProvider language="en">
        <AssistantMessage content={content} isStreaming={isStreaming} />
      </I18nProvider>
    );

    act(() => root.render(tree('old response text', true)));
    expect(container.textContent).toContain('old response text');

    act(() => root.render(tree('new unrelated text', true)));
    expect(container.textContent).toContain('new unrelated text');
    expect(container.textContent).not.toContain('old response text');
  });
});

describe('AssistantMessage markdown tables', () => {
  const tableMarkdown = [
    '| Team | Score |',
    '| --- | ---: |',
    '| Alpha | 10 |',
  ].join('\n');

  it('uses advanced tables when configured', () => {
    const container = render(
      <WebShellCustomizationProvider value={{ markdownTableMode: 'advanced' }}>
        <AssistantMessage content={tableMarkdown} />
      </WebShellCustomizationProvider>,
    );

    expect(container.textContent).toContain('Quick copy');
    expect(container.textContent).toContain('Details');
    expect(container.querySelector('button[aria-label*="table"]')).toBeNull();
  });

  it('keeps streaming assistant tables plain', () => {
    const container = render(
      <AssistantMessage content={tableMarkdown} isStreaming />,
    );

    expect(container.querySelector('table')).not.toBeNull();
    expect(container.textContent).not.toContain('Quick copy');
  });
});
