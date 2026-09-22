// @vitest-environment jsdom
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  WebShellNavigationBoundary,
  useWebShellNavigation,
  type NavigationSessionProps,
} from './navigation';
import type { WebShellProps } from './App';
import {
  buildNavigationUrl,
  readNavigationUrl,
  WEB_SHELL_PAGES,
} from './utils/navigationUrl';

let controller: ReturnType<typeof useWebShellNavigation>;
let target: NavigationSessionProps;
let notify: NonNullable<WebShellProps['onSessionIdChange']>;
function Capture() {
  controller = useWebShellNavigation();
  return null;
}
let root: Root;
let container: HTMLDivElement;
function render(externalTarget: NavigationSessionProps = {}, enabled = true) {
  act(() =>
    root.render(
      <WebShellNavigationBoundary
        options={enabled ? { basePath: '/agentic-code' } : undefined}
        externalTarget={externalTarget}
      >
        {(nextTarget, onChange) => {
          target = nextTarget;
          notify = onChange;
          return <Capture />;
        }}
      </WebShellNavigationBoundary>,
    ),
  );
}
beforeEach(() => {
  Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
  window.history.replaceState({ host: 'kept' }, '', '/agentic-code');
  container = document.createElement('div');
  document.body.append(container);
  root = createRoot(container);
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
  vi.restoreAllMocks();
});

describe('navigation protocol', () => {
  it.each(WEB_SHELL_PAGES)(
    'round trips %s without session scope and preserves host query/hash',
    (page) => {
      const url = buildNavigationUrl(
        new URL(
          'https://host/agentic-code/session/a?workspace=w&context=live&instanceId=i&instanceType=dsw#host',
        ),
        { page },
        '/agentic-code/',
      );
      expect(url.pathname).toBe(`/agentic-code/${page}`);
      expect(url.search).toBe('?instanceId=i&instanceType=dsw');
      expect(url.hash).toBe('#host');
      expect(readNavigationUrl(url, '/agentic-code')).toEqual({ page });
    },
  );
  it('encodes session and workspace, prioritizes context and enforces the base boundary', () => {
    const route = {
      page: 'chat' as const,
      sessionId: 'a/b 中文',
      workspaceId: 'w & x',
    };
    const url = buildNavigationUrl(new URL('https://host/'), route);
    expect(readNavigationUrl(url)).toEqual(route);
    url.searchParams.set('context', 'standalone');
    expect(readNavigationUrl(url)).toEqual({
      page: 'chat',
      sessionId: route.sessionId,
      context: 'standalone',
    });
    expect(
      readNavigationUrl(
        new URL('https://host/agentic-code-other/plugins'),
        '/agentic-code',
      ),
    ).toBeUndefined();
    expect(
      readNavigationUrl(
        new URL('https://host/agentic-code/session/%E0'),
        '/agentic-code',
      ),
    ).toBeUndefined();
  });
});

describe('navigation ownership', () => {
  it('retains the background session, remembers return context, and avoids duplicate page history', () => {
    window.history.replaceState(
      { host: 'kept' },
      '',
      '/agentic-code/session/a?workspace=w&instanceId=i',
    );
    render();
    const push = vi.spyOn(window.history, 'pushState');
    act(() => controller!.openPage('plugins'));
    expect(target).toMatchObject({ sessionId: 'a', workspaceId: 'w' });
    expect(window.location.pathname).toBe('/agentic-code/plugins');
    expect(window.history.state.host).toBe('kept');
    act(() => controller!.openPage('plugins'));
    expect(push).toHaveBeenCalledTimes(1);
    act(() => controller!.openPage('settings'));
    act(() => controller!.returnToChat());
    expect(window.location.pathname).toBe('/agentic-code/session/a');
    expect(window.location.search).toBe('?instanceId=i&workspace=w');
  });
  it('keeps the requested origin while session loading is pending', () => {
    window.history.replaceState(null, '', '/agentic-code/session/a');
    render();
    act(() => notify('a'));
    act(() => controller!.beginSessionNavigation('missing', 'unavailable'));
    act(() => controller!.openPage('plugins'));
    act(() => controller!.openPage('settings'));
    act(() => controller!.returnToChat());
    expect(location.pathname).toBe('/agentic-code/session/missing');
    expect(location.search).toBe('?workspace=unavailable');
  });
  it('protects initial session loading from empty callbacks and replaces canonical metadata', () => {
    window.history.replaceState(
      null,
      '',
      '/agentic-code/session/a?workspace=w',
    );
    render();
    const push = vi.spyOn(window.history, 'pushState');
    act(() => notify(undefined));
    expect(window.location.pathname).toBe('/agentic-code/session/a');
    act(() => notify('a', 'w', '/work'));
    expect(push).not.toHaveBeenCalled();
    expect(target.sessionId).toBe('a');
  });
  it('direct page return is an empty target and popstate does not write history', () => {
    window.history.replaceState(null, '', '/agentic-code/goals');
    render();
    act(() => controller!.returnToChat());
    expect(target.sessionId).toBeUndefined();
    window.history.replaceState(
      null,
      '',
      '/agentic-code/session/b?context=live',
    );
    const push = vi.spyOn(window.history, 'pushState');
    const replace = vi.spyOn(window.history, 'replaceState');
    act(() => window.dispatchEvent(new PopStateEvent('popstate')));
    expect(target).toMatchObject({
      sessionId: 'b',
      sessionContext: { kind: 'live' },
    });
    act(() => notify(undefined));
    expect(push).not.toHaveBeenCalled();
    expect(replace).not.toHaveBeenCalled();
  });
  it.each(['standalone', 'live'] as const)(
    'retains %s context across a page and return',
    (kind) => {
      window.history.replaceState(
        null,
        '',
        `/agentic-code/session/a?context=${kind}&workspace=ignored`,
      );
      render();
      expect(target.sessionContext).toEqual({ kind });
      expect(target.workspaceId).toBeUndefined();
      act(() => notify('a', undefined, undefined, { kind }));
      act(() => controller!.openPage('settings'));
      act(() => controller!.returnToChat());
      expect(new URLSearchParams(location.search).get('context')).toBe(kind);
      expect(new URLSearchParams(location.search).has('workspace')).toBe(false);
    },
  );
  it('allows the first allocation after returning from a directly opened page', () => {
    window.history.replaceState(null, '', '/agentic-code/plugins');
    render();
    act(() => controller!.returnToChat());
    act(() => notify('new-session'));
    expect(location.pathname).toBe('/agentic-code/session/new-session');
  });

  it('rejects a stale session callback while replay clears the session', () => {
    window.history.replaceState(null, '', '/agentic-code/session/a');
    render();
    act(() => notify('a'));
    window.history.replaceState(null, '', '/agentic-code');
    act(() => window.dispatchEvent(new PopStateEvent('popstate')));
    act(() => notify('a'));
    expect(location.pathname).toBe('/agentic-code');
    expect(target.sessionId).toBeUndefined();
  });
  it('pushes an explicit session selection once and ignores stale callbacks', () => {
    window.history.replaceState(null, '', '/agentic-code/session/a');
    render();
    act(() => notify('a'));
    act(() => controller!.openPage('plugins'));
    const push = vi.spyOn(history, 'pushState');
    act(() => controller!.beginSessionNavigation('b'));
    act(() => controller!.reconcilePage(undefined));
    act(() => notify('a'));
    expect(location.pathname).toBe('/agentic-code/session/b');
    act(() => notify('b'));
    expect(location.pathname).toBe('/agentic-code/session/b');
    expect(push).toHaveBeenCalledOnce();
  });

  it('does not let a host echo of the reported session replace an open page', () => {
    window.history.replaceState(
      null,
      '',
      '/agentic-code/session/a?workspace=w',
    );
    render();
    act(() => notify('a', 'w', '/work'));
    act(() => controller!.openPage('settings'));
    render({ sessionId: 'a', workspaceId: 'w' });
    expect(location.pathname).toBe('/agentic-code/settings');
    expect(controller!.route.page).toBe('settings');
  });

  it('external target changes take precedence, while disabled mode leaves URLs alone', () => {
    window.history.replaceState(null, '', '/agentic-code/session/a');
    render({ sessionId: 'external' });
    expect(target.sessionId).toBe('external');
    render({ sessionId: 'next', workspaceId: 'w' });
    expect(window.location.pathname).toBe('/agentic-code/session/next');
    render({ sessionId: 'host' }, false);
    act(() => notify('other'));
    expect(controller).toBeUndefined();
    expect(target.sessionId).toBe('host');
    expect(window.location.pathname).toBe('/agentic-code/session/next');
  });
});
