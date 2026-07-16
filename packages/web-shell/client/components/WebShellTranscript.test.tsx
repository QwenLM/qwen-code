// @vitest-environment jsdom
import { act, createContext, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { DaemonTranscriptBlock } from '@qwen-code/sdk/daemon';
import type { Message } from '../adapters/types';
import { getTranslator } from '../i18n';

interface Observation {
  props: Record<string, unknown> & { messages: Message[] };
  theme: string;
  language: string;
  renderMode: string;
  compactMode: boolean;
  customization: Record<string, unknown>;
}

const observed = vi.hoisted(() => ({
  values: [] as Observation[],
  shouldThrow: false,
}));

vi.mock('../App', () => ({
  CompactModeContext: createContext(false),
  TodoDetailContext: createContext(new Map()),
  TodoTimelineContext: createContext(new Map()),
}));

vi.mock('./MessageList', async () => {
  const React = await import('react');
  const { CompactModeContext } = await import('../App');
  const { useWebShellCustomization } = await import('../customization');
  const { useI18n } = await import('../i18n');
  const { useTheme } = await import('../themeContext');
  const { useTranscriptRenderMode } = await import('../transcriptRenderMode');
  return {
    MessageList: (props: Record<string, unknown> & { messages: Message[] }) => {
      if (observed.shouldThrow) throw new Error('message-list boom');
      const customization = useWebShellCustomization();
      observed.values.push({
        props,
        theme: useTheme(),
        language: useI18n().language,
        renderMode: useTranscriptRenderMode(),
        compactMode: React.useContext(CompactModeContext),
        customization: customization as Record<string, unknown>,
      });
      return React.createElement('div', { 'data-testid': 'message-list' });
    },
  };
});

const { WebShellTranscript } = await import('./WebShellTranscript');

const mounted: Array<{ root: Root; container: HTMLElement }> = [];

function block(
  value: Omit<
    DaemonTranscriptBlock,
    'clientReceivedAt' | 'createdAt' | 'updatedAt'
  >,
): DaemonTranscriptBlock {
  return {
    ...value,
    clientReceivedAt: 1,
    createdAt: 1,
    updatedAt: 1,
  } as DaemonTranscriptBlock;
}

function mount(node: ReactNode): {
  container: HTMLElement;
  root: Root;
  render: (next: ReactNode) => void;
} {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  act(() => root.render(node));
  mounted.push({ root, container });
  return {
    container,
    root,
    render(next) {
      act(() => root.render(next));
    },
  };
}

function latestObservation(): Observation {
  const value = observed.values.at(-1);
  if (!value) throw new Error('MessageList was not rendered');
  return value;
}

afterEach(() => {
  for (const { root, container } of mounted.splice(0)) {
    act(() => root.unmount());
    container.remove();
  }
  observed.values.length = 0;
  observed.shouldThrow = false;
  vi.restoreAllMocks();
});

describe('WebShellTranscript contract', () => {
  it('converts blocks and fixes MessageList at the readonly boundary', () => {
    const blocks = [
      block({ id: 'user', kind: 'user', text: 'hello' }),
      block({ id: 'cancelled', kind: 'prompt_cancelled' }),
    ];
    mount(
      <WebShellTranscript
        blocks={blocks}
        language="zh-CN"
        workspaceCwd="/workspace"
        virtualScrollThreshold={25}
      />,
    );

    const { props } = latestObservation();
    expect(props.messages).toMatchObject([
      { id: 'user', role: 'user', content: 'hello' },
      {
        id: 'cancelled',
        role: 'system',
        content: getTranslator('zh-CN')('request.cancelled'),
      },
    ]);
    expect(props).toMatchObject({
      pendingApproval: null,
      isResponding: false,
      workspaceCwd: '/workspace',
      virtualScrollThreshold: 25,
    });
    for (const callback of [
      'onShowContextDetail',
      'onRetryClick',
      'onBranchSession',
      'onReviewChanges',
      'onOpenArtifact',
      'onOpenScheduledTask',
      'onTurnOutputOpen',
    ]) {
      expect(props).not.toHaveProperty(callback);
    }
  });

  it('provides visual customization without enabling interactive mode', () => {
    const renderToolHeaderExtra = vi.fn();
    const renderAssistantTurnFooter = vi.fn();
    mount(
      <WebShellTranscript
        blocks={[]}
        theme="light"
        language="zh"
        chatMaxWidth={720}
        compactThinking
        collapseCompletedTurns={false}
        markdownTableMode="advanced"
        composerTagIcons={{ file: '/file.svg' }}
        renderToolHeaderExtra={renderToolHeaderExtra}
        renderAssistantTurnFooter={renderAssistantTurnFooter}
      />,
    );

    const observation = latestObservation();
    expect(observation).toMatchObject({
      theme: 'light',
      language: 'zh-CN',
      renderMode: 'readonly',
      compactMode: false,
    });
    expect(observation.customization).toMatchObject({
      compactThinking: true,
      collapseCompletedTurns: false,
      markdownTableMode: 'advanced',
      composerTagIcons: { file: '/file.svg' },
      renderToolHeaderExtra,
      renderAssistantTurnFooter,
    });
    const root = document.querySelector<HTMLElement>('[data-web-shell-root]');
    expect(root?.classList.contains('dark')).toBe(false);
    expect(root?.lang).toBe('zh-CN');
    expect(root?.style.getPropertyValue('--chat-content-width')).toBe('720px');
  });

  it('reconverts on language or block changes and supports an empty list', () => {
    const blocks = [block({ id: 'cancelled', kind: 'prompt_cancelled' })];
    const view = mount(<WebShellTranscript blocks={blocks} language="en" />);
    expect(latestObservation().props.messages[0]).toMatchObject({
      content: getTranslator('en')('request.cancelled'),
    });

    view.render(<WebShellTranscript blocks={blocks} language="zh-CN" />);
    expect(latestObservation().props.messages[0]).toMatchObject({
      content: getTranslator('zh-CN')('request.cancelled'),
    });

    view.render(<WebShellTranscript blocks={[]} language="zh-CN" />);
    expect(latestObservation().props.messages).toEqual([]);
  });

  it('contains failures from the message tree in the public root boundary', () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    observed.shouldThrow = true;
    const { container } = mount(
      <WebShellTranscript blocks={[]} language="zh-CN" />,
    );
    expect(container.querySelector('[role="alert"]')?.textContent).toContain(
      '出了点问题',
    );
  });
});
