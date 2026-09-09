// @vitest-environment jsdom

import { act, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DaemonProductSessionContext } from '@qwen-code/web-shell/daemon-react-sdk';
import type { WebShellProps } from './App';

interface CapturedWorkspaceSessionProps {
  sessionId?: string;
  workspaceId?: string;
  sessionContext?: DaemonProductSessionContext;
  webShellProps: WebShellProps;
}

const testState = vi.hoisted(() => ({
  props: undefined as CapturedWorkspaceSessionProps | undefined,
  throwOnRender: false,
  tokenSurvivesReload: true,
  renderCount: 0,
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
    testState.renderCount += 1;
    if (testState.throwOnRender) {
      throw new Error('render boom');
    }
    testState.props = props;
    return null;
  },
}));
vi.mock('./config/daemon', () => ({
  getDaemonBaseUrl: () => '',
  getDaemonToken: () => 'token',
  hasReloadSurvivableDaemonToken: () => testState.tokenSurvivesReload,
  removeDaemonTokenFromUrl: vi.fn(),
  waitForDaemonTokenMessage: vi.fn(),
}));

import { StandaloneApp } from './main';

describe('StandaloneApp', () => {
  let container: HTMLDivElement;
  let root: Root;

  beforeEach(() => {
    testState.props = undefined;
    testState.throwOnRender = false;
    testState.tokenSurvivesReload = true;
    testState.renderCount = 0;
    window.history.replaceState(null, '', '/');
    container = document.createElement('div');
    document.body.appendChild(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.unstubAllGlobals();
    // A failing assertion mid-test must not leak the console.error spy into
    // later tests in this file.
    vi.restoreAllMocks();
  });

  it('reloads the page when the root error fallback retry is clicked', () => {
    testState.throwOnRender = true;
    const reload = vi.fn();
    vi.stubGlobal('location', { ...window.location, reload });
    // The boundary logs the caught error; keep the test output clean.
    vi.spyOn(console, 'error').mockImplementation(() => {});

    act(() => root.render(<StandaloneApp daemonToken="token" />));

    const retry = container.querySelector('button');
    expect(retry?.textContent).toBe('Reload page');
    expect(reload).not.toHaveBeenCalled();

    act(() => {
      retry?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });

    expect(reload).toHaveBeenCalledTimes(1);
  });

  it('falls back to an in-place reset when the token cannot survive a reload', () => {
    testState.throwOnRender = true;
    testState.tokenSurvivesReload = false;
    const reload = vi.fn();
    vi.stubGlobal('location', { ...window.location, reload });
    vi.spyOn(console, 'error').mockImplementation(() => {});

    act(() => root.render(<StandaloneApp daemonToken="token" />));

    const retry = container.querySelector('button');
    expect(retry?.textContent).toBe('Try again');
    // React replays a throwing render before the boundary catches it, so pin
    // the delta across the retry, not an absolute render count.
    const rendersBeforeRetry = testState.renderCount;

    // The transient cause is gone by the time the user retries.
    testState.throwOnRender = false;
    act(() => {
      retry?.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    });

    expect(reload).not.toHaveBeenCalled();
    expect(testState.renderCount).toBeGreaterThan(rendersBeforeRetry);
    expect(container.querySelector('button')).toBeNull();
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
    expect(testState.props?.webShellProps.header?.items).toContain(
      'contextUsage',
    );
    expect(testState.props?.webShellProps.sidebar).toMatchObject({
      enabled: true,
      showLive: true,
    });
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

  it('keeps standalone context out of the URL for an unallocated draft', () => {
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
    expect(new URLSearchParams(window.location.search).has('context')).toBe(
      false,
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
