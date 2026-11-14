/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

// @vitest-environment jsdom

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { I18nProvider } from '../i18n';
import type { LocalFilesStatus } from '../local-files/useLocalFilesBridge';
import {
  LocalFilesPanel,
  type LocalFilesPanelProps,
} from './LocalFilesControl';

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

let container: HTMLDivElement | null = null;
let root: Root | null = null;

interface Handlers {
  onConnect: () => void;
  onDisconnect: () => void;
  onOpenInNewTab: () => void;
}

function mount(
  status: LocalFilesStatus,
  language: 'en' | 'zh-CN' = 'en',
): Handlers {
  const handlers: Handlers = {
    onConnect: vi.fn(),
    onDisconnect: vi.fn(),
    onOpenInNewTab: vi.fn(),
  };
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => {
    root!.render(
      <I18nProvider language={language}>
        <LocalFilesPanel status={status} {...handlers} />
      </I18nProvider>,
    );
  });
  return handlers;
}

afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
  root = null;
  container = null;
});

function text(): string {
  return container?.textContent ?? '';
}

function buttons(): HTMLButtonElement[] {
  return Array.from(container?.querySelectorAll('button') ?? []);
}

function buttonByLabel(label: string): HTMLButtonElement | undefined {
  return buttons().find((button) => button.textContent?.trim() === label);
}

describe('LocalFilesPanel degradation matrix', () => {
  it('explains an insecure origin and offers no connect path', () => {
    mount({ phase: 'unavailable', blocker: 'insecure-context' });
    expect(text()).toContain('not a secure context');
    expect(text()).toContain('SSH');
    expect(buttonByLabel('Connect a directory…')).toBeUndefined();
    expect(buttons()).toHaveLength(0);
  });

  it('offers to open a top-level tab when framed cross-origin', () => {
    const handlers = mount({
      phase: 'unavailable',
      blocker: 'cross-origin-frame',
    });
    expect(text()).toContain('cross-origin frame');
    const open = buttonByLabel('Open in a new tab');
    expect(open).toBeDefined();
    act(() => {
      open!.click();
    });
    expect(handlers.onOpenInNewTab).toHaveBeenCalledOnce();
  });

  it('names the browser requirement when the picker is missing', () => {
    mount({ phase: 'unavailable', blocker: 'unsupported-browser' });
    expect(text()).toContain('File System Access API');
    expect(text()).toContain('Chrome or Edge');
  });

  it('never renders a raw i18n key in Chinese', () => {
    mount({ phase: 'unavailable', blocker: 'insecure-context' }, 'zh-CN');
    // Messages is Record<string, MessageValue>, so a missing zh key falls back
    // to the raw key rather than failing — only rendering catches it.
    expect(text()).not.toContain('localFiles.');
    expect(text()).toContain('安全上下文');
    expect(text()).toContain('当前环境不可用');
  });

  // A missing zh key degrades silently to the EN string (messages[key] ??
  // EN[key] ?? key), and nothing in the type system enforces that EN and ZH
  // stay in sync — so every state this panel can render is checked in
  // Chinese against its actual zh string.
  it.each<[string, LocalFilesStatus, string[]]>([
    ['idle', { phase: 'idle', blocker: null }, ['未连接']],
    [
      'needs-gesture',
      { phase: 'needs-gesture', blocker: null, rootName: 'd' },
      ['需要重新连接'],
    ],
    [
      'needs-session',
      { phase: 'needs-session', blocker: null, rootName: 'd' },
      ['等待会话'],
    ],
    [
      'held-elsewhere',
      { phase: 'held-elsewhere', blocker: null },
      ['已在其他标签页连接'],
    ],
    ['connecting', { phase: 'connecting', blocker: null }, ['连接中']],
    ['registering', { phase: 'registering', blocker: null }, ['注册中']],
    [
      'reconnecting',
      { phase: 'reconnecting', blocker: null, message: 'x' },
      ['重连中'],
    ],
    [
      'connected',
      { phase: 'connected', blocker: null, rootName: 'd', toolCount: 4 },
      ['已连接'],
    ],
    [
      'failed',
      { phase: 'failed', blocker: null, message: 'boom' },
      ['连接失败'],
    ],
    [
      'unavailable/insecure',
      { phase: 'unavailable', blocker: 'insecure-context' },
      ['安全上下文'],
    ],
    [
      'unavailable/cross-origin',
      { phase: 'unavailable', blocker: 'cross-origin-frame' },
      ['跨源 iframe'],
    ],
    [
      'unavailable/unsupported',
      { phase: 'unavailable', blocker: 'unsupported-browser' },
      ['当前浏览器没有'],
    ],
    [
      'unavailable/workspace-ineligible',
      { phase: 'unavailable', blocker: 'workspace-ineligible' },
      ['该会话的工作区不能托管本地目录'],
    ],
    [
      'unavailable/workspace-resolving',
      { phase: 'unavailable', blocker: 'workspace-resolving' },
      // Every string this render emits, including the transient status
      // line: t() falls back to English silently, so the blocker sentence
      // alone would pass with a half-English panel.
      ['尚不能确定该会话所属的工作区', '解析中…'],
    ],
    [
      'unavailable/unsupported-daemon',
      { phase: 'unavailable', blocker: 'unsupported-daemon' },
      ['该 daemon 未启用客户端文件桥'],
    ],
  ])('renders %s fully translated', (_label, status, zh) => {
    mount(status, 'zh-CN');
    expect(text()).not.toContain('localFiles.');
    for (const line of zh) {
      expect(text()).toContain(line);
    }
  });

  it.each([
    ['workspace-resolving'],
    ['workspace-ineligible'],
    ['unsupported-daemon'],
  ])('keeps revoke reachable for %s with a stored grant', (blocker) => {
    // Disconnect is the only store.clear() caller: a withheld entry that
    // names its stored grant must keep the affordance, not just the copy.
    mount({
      phase: 'unavailable',
      blocker: blocker as LocalFilesStatus['blocker'],
      rootName: 'ai_coding',
    });
    expect(buttonByLabel('Disconnect')).toBeDefined();
    expect(buttonByLabel('Connect a directory…')).toBeUndefined();
    expect(text()).toContain('ai_coding');
  });

  it('presents the resolving blocker as transient, not permanent', () => {
    mount({ phase: 'unavailable', blocker: 'workspace-resolving' });
    // The one transient blocker must not pair its copy with the permanent
    // "Unavailable here" header, and must show progress instead.
    expect(container?.querySelector('[data-slot="spinner"]')).not.toBeNull();
    expect(text()).toContain('Resolving…');
    expect(text()).not.toContain('Unavailable here');
    expect(buttons()).toHaveLength(0);
  });
});

describe('LocalFilesPanel affordances', () => {
  it('offers to connect when idle', () => {
    const handlers = mount({ phase: 'idle', blocker: null });
    const connect = buttonByLabel('Connect a directory…');
    expect(connect).toBeDefined();
    expect(buttonByLabel('Disconnect')).toBeUndefined();
    act(() => {
      connect!.click();
    });
    expect(handlers.onConnect).toHaveBeenCalledOnce();
  });

  it('labels the click as a reconnect when a stored grant needs a gesture', () => {
    mount({ phase: 'needs-gesture', blocker: null, rootName: 'ai_coding' });
    expect(buttonByLabel('Reconnect')).toBeDefined();
    expect(buttonByLabel('Connect a directory…')).toBeUndefined();
    expect(text()).toContain('ai_coding');
  });

  it('explains that a session is required, and still lets the grant be made', () => {
    mount({ phase: 'needs-session', blocker: null, rootName: 'ai_coding' });
    expect(text()).toContain('Start a session first');
    expect(buttonByLabel('Connect a directory…')).toBeDefined();
    // The grant exists, so it must be releasable.
    expect(buttonByLabel('Disconnect')).toBeDefined();
  });

  it('shows the bound directory and tool count when connected, with no connect button', () => {
    mount({
      phase: 'connected',
      blocker: null,
      rootName: 'ai_coding',
      toolCount: 4,
    });
    expect(text()).toContain('Connected');
    expect(text()).toContain('ai_coding');
    expect(text()).toContain('4 tools');
    expect(buttonByLabel('Connect a directory…')).toBeUndefined();
    expect(buttonByLabel('Disconnect')).toBeDefined();
  });

  it('reports another tab owning the bridge without offering to steal it', () => {
    mount({ phase: 'held-elsewhere', blocker: null });
    expect(text()).toContain('Connected in another tab');
    expect(buttonByLabel('Connect a directory…')).toBeUndefined();
  });

  it('lets the user cancel an in-flight connection', () => {
    mount({ phase: 'registering', blocker: null });
    expect(text()).toContain('Registering…');
    expect(buttonByLabel('Connect a directory…')).toBeUndefined();
    expect(buttonByLabel('Disconnect')).toBeDefined();
  });

  it('surfaces the failure reason and offers to try again', () => {
    mount({
      phase: 'failed',
      blocker: null,
      message: 'No live ACP channel after 6 attempt(s)',
    });
    const alert = container?.querySelector('[role="alert"]');
    expect(alert?.textContent).toContain('No live ACP channel');
    expect(buttonByLabel('Connect a directory…')).toBeDefined();
  });

  it('disconnects and reports the click', () => {
    const handlers = mount({
      phase: 'connected',
      blocker: null,
      rootName: 'ai_coding',
      toolCount: 4,
    });
    act(() => {
      buttonByLabel('Disconnect')!.click();
    });
    expect(handlers.onDisconnect).toHaveBeenCalledOnce();
    expect(handlers.onConnect).not.toHaveBeenCalled();
  });
});

describe('LocalFilesPanel usability affordances', () => {
  function mountExtra(
    status: LocalFilesStatus,
    extra: Partial<LocalFilesPanelProps> = {},
    language: 'en' | 'zh-CN' = 'en',
  ): void {
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    const handlers = {
      onConnect: vi.fn(),
      onDisconnect: vi.fn(),
      onOpenInNewTab: vi.fn(),
    };
    act(() => {
      root!.render(
        <I18nProvider language={language}>
          <LocalFilesPanel status={status} {...handlers} {...extra} />
        </I18nProvider>,
      );
    });
  }

  const connected: LocalFilesStatus = {
    phase: 'connected',
    blocker: null,
    rootName: 'ai_coding',
    toolCount: 4,
  };

  it('offers change directory only while connected and fires the prop', () => {
    const onChangeDirectory = vi.fn();
    mountExtra(connected, { onChangeDirectory });
    const button = buttonByLabel('Change directory…');
    expect(button).toBeDefined();
    act(() => {
      button!.click();
    });
    expect(onChangeDirectory).toHaveBeenCalledOnce();
  });

  it('does not offer change directory when another tab owns the bridge', () => {
    mountExtra(
      { phase: 'held-elsewhere', blocker: null, rootName: 'ai_coding' },
      { onChangeDirectory: vi.fn() },
    );
    expect(buttonByLabel('Change directory…')).toBeUndefined();
  });

  it('omits change directory when the host does not provide it', () => {
    mountExtra(connected);
    expect(buttonByLabel('Change directory…')).toBeUndefined();
  });

  it('names the bound session when connected', () => {
    mountExtra(connected, { sessionName: 'My task' });
    expect(text()).toContain('Session');
    expect(text()).toContain('My task');
  });

  it('omits the session row when no name is known', () => {
    mountExtra(connected);
    expect(text()).not.toContain('Session');
  });

  it('offers new session in needs-session and fires the prop', () => {
    const onNewSession = vi.fn();
    mountExtra({ phase: 'needs-session', blocker: null }, { onNewSession });
    const button = buttonByLabel('New session');
    expect(button).toBeDefined();
    act(() => {
      button!.click();
    });
    expect(onNewSession).toHaveBeenCalledOnce();
  });

  it('omits new session when the host does not provide it', () => {
    mountExtra({ phase: 'needs-session', blocker: null });
    expect(buttonByLabel('New session')).toBeUndefined();
  });

  it('labels a failed bridge with a stored grant as Retry', () => {
    mountExtra({
      phase: 'failed',
      blocker: null,
      rootName: 'ai_coding',
      message: 'boom',
    });
    expect(buttonByLabel('Retry')).toBeDefined();
    expect(buttonByLabel('Connect a directory…')).toBeUndefined();
  });

  it('keeps Connect a directory for a failed bridge without a grant', () => {
    mountExtra({ phase: 'failed', blocker: null, message: 'boom' });
    expect(buttonByLabel('Connect a directory…')).toBeDefined();
    expect(buttonByLabel('Retry')).toBeUndefined();
  });

  it('copies the daemon startup command for unsupported-daemon', () => {
    const onCopyCommand = vi.fn();
    mountExtra(
      { phase: 'unavailable', blocker: 'unsupported-daemon' },
      { onCopyCommand },
    );
    const button = buttonByLabel('Copy startup command');
    expect(button).toBeDefined();
    act(() => {
      button!.click();
    });
    // Pin the literal, not the exported constant (R1-12): a command that does
    // not enable the reverse channel must make this go red.
    expect(onCopyCommand).toHaveBeenCalledWith(
      'QWEN_SERVE_CLIENT_MCP_OVER_WS=1 qwen serve',
    );
  });

  it('copies the tunnel command for insecure-context when provided', () => {
    const onCopyCommand = vi.fn();
    const tunnelCommand = 'ssh -L 4170:localhost:4170 daemon.example';
    mountExtra(
      { phase: 'unavailable', blocker: 'insecure-context' },
      { onCopyCommand, tunnelCommand },
    );
    const button = buttonByLabel('Copy SSH tunnel command');
    expect(button).toBeDefined();
    act(() => {
      button!.click();
    });
    expect(onCopyCommand).toHaveBeenCalledWith(tunnelCommand);
  });

  it('renders no tunnel copy button without a command', () => {
    mountExtra(
      { phase: 'unavailable', blocker: 'insecure-context' },
      { onCopyCommand: vi.fn() },
    );
    expect(buttonByLabel('Copy SSH tunnel command')).toBeUndefined();
  });

  it('renders no copy buttons when the host provides no copy handler', () => {
    mountExtra({ phase: 'unavailable', blocker: 'unsupported-daemon' });
    expect(buttonByLabel('Copy startup command')).toBeUndefined();
  });

  it('states the next step for an ineligible workspace', () => {
    mountExtra({ phase: 'unavailable', blocker: 'workspace-ineligible' });
    expect(text()).toContain('trusted, regular workspace');
  });

  it('renders the new affordances fully translated in Chinese', () => {
    const onCopyCommand = vi.fn();
    mountExtra(
      connected,
      {
        onChangeDirectory: vi.fn(),
        sessionName: '我的任务',
        onCopyCommand,
      },
      'zh-CN',
    );
    expect(text()).not.toContain('localFiles.');
    expect(text()).toContain('更换目录…');
    expect(text()).toContain('会话');
    expect(text()).toContain('我的任务');
  });

  it('renders the new-session and retry affordances in Chinese', () => {
    mountExtra(
      { phase: 'needs-session', blocker: null },
      { onNewSession: vi.fn() },
      'zh-CN',
    );
    expect(text()).not.toContain('localFiles.');
    expect(text()).toContain('新建会话');
  });

  it('renders the copy buttons in Chinese', () => {
    mountExtra(
      { phase: 'unavailable', blocker: 'unsupported-daemon' },
      { onCopyCommand: vi.fn() },
      'zh-CN',
    );
    expect(text()).not.toContain('localFiles.');
    expect(text()).toContain('复制启动命令');
  });
});
