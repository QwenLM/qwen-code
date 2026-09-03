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
import { LocalFilesPanel } from './LocalFilesControl';

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

  // A missing zh key degrades silently to the raw key, and nothing in the type
  // system enforces that EN and ZH stay in sync — so every state this panel can
  // render is checked in Chinese.
  it.each<[string, LocalFilesStatus]>([
    ['idle', { phase: 'idle', blocker: null }],
    ['needs-gesture', { phase: 'needs-gesture', blocker: null, rootName: 'd' }],
    ['needs-session', { phase: 'needs-session', blocker: null, rootName: 'd' }],
    ['held-elsewhere', { phase: 'held-elsewhere', blocker: null }],
    ['connecting', { phase: 'connecting', blocker: null }],
    ['registering', { phase: 'registering', blocker: null }],
    ['reconnecting', { phase: 'reconnecting', blocker: null, message: 'x' }],
    [
      'connected',
      { phase: 'connected', blocker: null, rootName: 'd', toolCount: 4 },
    ],
    ['failed', { phase: 'failed', blocker: null, message: 'boom' }],
    [
      'unavailable/insecure',
      { phase: 'unavailable', blocker: 'insecure-context' },
    ],
    [
      'unavailable/cross-origin',
      { phase: 'unavailable', blocker: 'cross-origin-frame' },
    ],
    [
      'unavailable/unsupported',
      { phase: 'unavailable', blocker: 'unsupported-browser' },
    ],
  ])('renders %s fully translated', (_label, status) => {
    mount(status, 'zh-CN');
    expect(text()).not.toContain('localFiles.');
    expect(text().length).toBeGreaterThan(0);
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
