// @vitest-environment jsdom
import { act } from 'react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { cleanupReact, mountReact } from '../test/reactHarness';
import {
  DaemonTargetProvider,
  useDaemonTarget,
  useInterceptHostLinks,
  type DaemonTargetController,
} from './daemon-target';

const ORIGINAL_HREF = window.location.href;
const BOOT_URL =
  '/?daemon=https%3A%2F%2Ffocus.example' +
  '&fanout=https%3A%2F%2Falpha.example' +
  '&fanout=http%3A%2F%2F10.0.0.2%3A4170' +
  '&context=standalone';

function mountController(): { current: DaemonTargetController | undefined } {
  const ref: { current: DaemonTargetController | undefined } = {
    current: undefined,
  };
  function Probe() {
    ref.current = useDaemonTarget();
    useInterceptHostLinks();
    return null;
  }
  mountReact(
    <DaemonTargetProvider>
      <Probe />
    </DaemonTargetProvider>,
  );
  return ref;
}

describe('DaemonTargetProvider (#13727)', () => {
  beforeEach(() => {
    window.localStorage.clear();
    window.sessionStorage.clear();
    window.history.replaceState(null, '', BOOT_URL);
  });

  afterEach(() => {
    cleanupReact();
    window.history.replaceState(null, '', ORIGINAL_HREF);
  });

  it('focuses the boot daemon and covers page + daemon + fanout origins', () => {
    const ref = mountController();
    expect(ref.current?.activeOrigin).toBe('https://focus.example');
    expect(ref.current?.coversOrigin(window.location.origin)).toBe(true);
    expect(ref.current?.coversOrigin('https://alpha.example')).toBe(true);
    expect(ref.current?.coversOrigin('http://10.0.0.2:4170')).toBe(true);
    expect(ref.current?.coversOrigin('https://stranger.example')).toBe(false);
  });

  it('rewrites the URL in place on a covered focus switch, without a navigation', () => {
    const ref = mountController();
    act(() => {
      ref.current?.focusHost({
        origin: 'https://alpha.example',
        workspaceId: 'ws-9',
      });
    });
    expect(ref.current?.activeOrigin).toBe('https://alpha.example');
    const url = new URL(window.location.href);
    expect(url.searchParams.get('daemon')).toBe('https://alpha.example');
    expect(url.searchParams.get('workspace')).toBe('ws-9');
    // A switch always drops the previous host's session surface…
    expect(url.searchParams.get('context')).toBeNull();
    // …but keeps every other fanout host covered for the next switch.
    expect(url.searchParams.getAll('fanout')).toEqual([
      'https://alpha.example',
      'http://10.0.0.2:4170',
    ]);
  });

  it('clears the session route when a focused switch has no session of its own', () => {
    const ref = mountController();
    window.history.replaceState(
      null,
      '',
      '/session/local-s?daemon=' +
        encodeURIComponent('https://focus.example') +
        '&fanout=https%3A%2F%2Falpha.example',
    );
    act(() => {
      ref.current?.focusHost({ origin: 'https://alpha.example' });
    });
    const url = new URL(window.location.href);
    // A stale session from the old host must not be loaded on the new one.
    expect(url.pathname).toBe('/');
    expect(url.searchParams.get('daemon')).toBe('https://alpha.example');
    expect(url.searchParams.get('workspace')).toBeNull();
    expect(url.searchParams.get('context')).toBeNull();
  });

  it('is a no-op when clicking the already-focused host', () => {
    const ref = mountController();
    window.history.replaceState(
      null,
      '',
      '/session/s-7?daemon=' +
        encodeURIComponent('https://focus.example') +
        '&workspace=ws-7&fanout=https%3A%2F%2Falpha.example',
    );
    const before = window.location.href;
    act(() => {
      ref.current?.focusHost({ origin: 'https://focus.example' });
    });
    expect(window.location.href).toBe(before);
    expect(ref.current?.activeOrigin).toBe('https://focus.example');
  });

  it('drops the daemon param when focusing the page origin', () => {
    const ref = mountController();
    act(() => {
      ref.current?.focusHost({ origin: window.location.origin });
    });
    expect(ref.current?.activeOrigin).toBe(window.location.origin);
    expect(new URL(window.location.href).searchParams.get('daemon')).toBeNull();
  });

  it('refuses to focus an origin the document cannot reach', () => {
    const ref = mountController();
    expect(() =>
      act(() => {
        ref.current?.focusHost({ origin: 'https://stranger.example' });
      }),
    ).toThrow(/cannot reach/);
    expect(ref.current?.activeOrigin).toBe('https://focus.example');
    expect(new URL(window.location.href).searchParams.get('daemon')).toBe(
      'https://focus.example',
    );
  });

  it('turns a covered-host anchor click into an in-app focus of that session', () => {
    const ref = mountController();
    const anchor = document.createElement('a');
    anchor.href =
      '/session/s-123?daemon=' + encodeURIComponent('https://alpha.example');
    const click = new MouseEvent('click', { bubbles: true, cancelable: true });
    act(() => {
      document.body.appendChild(anchor);
      anchor.dispatchEvent(click);
    });
    expect(click.defaultPrevented).toBe(true);
    expect(ref.current?.activeOrigin).toBe('https://alpha.example');
    expect(ref.current?.pendingHandoff).toEqual({
      kind: 'open',
      origin: 'https://alpha.example',
      sessionId: 's-123',
    });
    anchor.remove();
  });

  it('leaves uncovered, off-origin, and same-daemon links alone', () => {
    mountController();
    for (const href of [
      'https://other.example/session/s-1?daemon=https%3A%2F%2Falpha.example',
      '/session/s-2?daemon=https%3A%2F%2Fstranger.example',
      '/session/s-3?daemon=https%3A%2F%2Ffocus.example',
      '/session/s-4',
    ]) {
      const anchor = document.createElement('a');
      anchor.href = href;
      const click = new MouseEvent('click', {
        bubbles: true,
        cancelable: true,
      });
      act(() => {
        document.body.appendChild(anchor);
        anchor.dispatchEvent(click);
      });
      expect(click.defaultPrevented).toBe(false);
      anchor.remove();
    }
  });

  it('hands an intent across a focus switch exactly once', () => {
    const ref = mountController();
    act(() => {
      ref.current?.focusHostWithHandoff(
        { origin: 'https://alpha.example' },
        {
          kind: 'open',
          origin: 'https://alpha.example',
          sessionId: 'session-7',
        },
      );
    });
    expect(ref.current?.pendingHandoff).toEqual({
      kind: 'open',
      origin: 'https://alpha.example',
      sessionId: 'session-7',
    });
    let taken: unknown;
    act(() => {
      taken = ref.current?.takePendingHandoff();
    });
    expect(taken).toEqual({
      kind: 'open',
      origin: 'https://alpha.example',
      sessionId: 'session-7',
    });
    expect(ref.current?.pendingHandoff).toBeUndefined();
  });
});
