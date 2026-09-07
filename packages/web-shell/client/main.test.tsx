// @vitest-environment jsdom

import { act, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DaemonProductSessionContext } from '@qwen-code/web-shell/daemon-react-sdk';
import type { WebShellProps } from './App';
import type { WebShellBrand } from './brandContext';

interface CapturedWorkspaceSessionProps {
  sessionId?: string;
  workspaceId?: string;
  sessionContext?: DaemonProductSessionContext;
  webShellProps: WebShellProps;
}

const testState = vi.hoisted(() => ({
  props: undefined as CapturedWorkspaceSessionProps | undefined,
}));

vi.mock('react-dom/client', async (importOriginal) => ({
  ...(await importOriginal<typeof import('react-dom/client')>()),
  default: { createRoot: () => ({ render: vi.fn() }) },
}));
vi.mock('@qwen-code/web-shell/daemon-react-sdk', () => ({
  DaemonWorkspaceProvider: ({ children }: { children: ReactNode }) => children,
}));
vi.mock('./components/WorkspaceSessionProvider', () => ({
  WorkspaceSessionProvider: (props: CapturedWorkspaceSessionProps) => {
    testState.props = props;
    return null;
  },
}));
vi.mock('./config/daemon', () => ({
  getDaemonBaseUrl: () => '',
  getDaemonToken: () => 'token',
  removeDaemonTokenFromUrl: vi.fn(),
  waitForDaemonTokenMessage: vi.fn(),
}));

import { StandaloneApp } from './main';

describe('StandaloneApp', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    testState.props = undefined;
    window.history.replaceState(null, '', '/');
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
  });

  it('keeps the controlled session target in sync with URL changes', () => {
    act(() => root.render(<StandaloneApp daemonToken="token" />));

    act(() => {
      testState.props?.webShellProps.onSessionIdChange?.(
        'session-created',
        'workspace-1',
      );
    });

    expect(testState.props).toMatchObject({
      sessionId: 'session-created',
      workspaceId: 'workspace-1',
    });
    expect(window.location.pathname).toBe('/session/session-created');
    expect(new URLSearchParams(window.location.search).get('workspace')).toBe(
      'workspace-1',
    );
    expect(
      testState.props?.webShellProps.composerToolbarAdditionalActions,
    ).toEqual(['addMenu']);
    expect(testState.props?.webShellProps.environmentPanel?.items).toContain(
      'artifacts',
    );
    expect(testState.props?.webShellProps.environmentPanel?.items).toContain(
      'attachments',
    );
  });

  it('round-trips standalone context without a workspace selector', () => {
    window.history.replaceState(
      null,
      '',
      '/session/standalone-a?context=standalone',
    );
    act(() => root.render(<StandaloneApp daemonToken="token" />));

    expect(testState.props).toMatchObject({
      sessionId: 'standalone-a',
      sessionContext: { kind: 'standalone' },
    });
    expect(testState.props?.workspaceId).toBeUndefined();

    act(() => {
      testState.props?.webShellProps.onSessionIdChange?.(
        'standalone-b',
        undefined,
        undefined,
        { kind: 'standalone' },
      );
    });

    expect(window.location.pathname).toBe('/session/standalone-b');
    expect(new URLSearchParams(window.location.search).get('context')).toBe(
      'standalone',
    );
    expect(new URLSearchParams(window.location.search).has('workspace')).toBe(
      false,
    );
  });

  it('keeps standalone context in the URL for an unallocated draft', () => {
    act(() => root.render(<StandaloneApp daemonToken="token" />));

    act(() => {
      testState.props?.webShellProps.onSessionIdChange?.(
        undefined,
        undefined,
        undefined,
        { kind: 'standalone' },
      );
    });

    expect(testState.props).toMatchObject({
      sessionId: undefined,
      workspaceId: undefined,
      sessionContext: { kind: 'standalone' },
    });
    expect(window.location.pathname).toBe('/');
    expect(new URLSearchParams(window.location.search).get('context')).toBe(
      'standalone',
    );
  });

  it('round-trips Live context without exposing its internal workspace', () => {
    window.history.replaceState(null, '', '/session/live-a?context=live');
    act(() => root.render(<StandaloneApp daemonToken="token" />));

    expect(testState.props).toMatchObject({
      sessionId: 'live-a',
      sessionContext: { kind: 'live' },
    });
    expect(testState.props?.workspaceId).toBeUndefined();

    act(() => {
      testState.props?.webShellProps.onSessionIdChange?.(
        'live-b',
        undefined,
        undefined,
        { kind: 'live' },
      );
    });

    expect(window.location.pathname).toBe('/session/live-b');
    expect(new URLSearchParams(window.location.search).get('context')).toBe(
      'live',
    );
    expect(new URLSearchParams(window.location.search).has('workspace')).toBe(
      false,
    );
  });
});

describe('StandaloneApp brand', () => {
  const BRAND_STORAGE_KEY = 'qwen-code-web-shell-brand';
  let container: HTMLDivElement;
  let root: Root;
  let icon: HTMLLinkElement;

  beforeEach(() => {
    testState.props = undefined;
    window.history.replaceState(null, '', '/');
    window.localStorage.clear();
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
    icon = document.createElement('link');
    icon.rel = 'icon';
    icon.setAttribute('href', 'data:image/svg+xml,BUILT-IN');
    document.head.appendChild(icon);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    icon.remove();
    window.localStorage.clear();
  });

  function resolveBrand(brand: WebShellBrand): void {
    act(() => root.render(<StandaloneApp daemonToken="token" />));
    act(() => {
      testState.props?.webShellProps.onBrandResolved?.(brand);
    });
  }

  function readCachedBrand(): unknown {
    const raw = window.localStorage.getItem(BRAND_STORAGE_KEY);
    return raw === null ? null : JSON.parse(raw);
  }

  it('applies the brand name to the document title and caches it', () => {
    resolveBrand({ name: 'QiuQiu Code' });

    expect(document.title).toBe('QiuQiu Code Web chat');
    expect(readCachedBrand()).toEqual({ title: 'QiuQiu Code Web chat' });
  });

  it('applies the logo to the favicon and caches both', () => {
    resolveBrand({
      name: 'QiuQiu Code',
      logoDataUri: 'data:image/svg+xml,LOGO',
    });

    expect(icon.getAttribute('href')).toBe('data:image/svg+xml,LOGO');
    expect(readCachedBrand()).toEqual({
      title: 'QiuQiu Code Web chat',
      logo: 'data:image/svg+xml,LOGO',
    });
  });

  it('restores the built-in title and clears the cache when no brand is configured', () => {
    window.localStorage.setItem(
      BRAND_STORAGE_KEY,
      JSON.stringify({
        title: 'QiuQiu Code Web chat',
        logo: 'data:image/svg+xml,LOGO',
      }),
    );

    resolveBrand({});

    expect(document.title).toBe('Qwen Code Web chat');
    expect(readCachedBrand()).toBeNull();
  });

  it('does not write a cache entry for the built-in brand', () => {
    resolveBrand({});

    expect(readCachedBrand()).toBeNull();
  });
});
