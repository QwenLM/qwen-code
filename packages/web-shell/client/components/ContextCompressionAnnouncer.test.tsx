// @vitest-environment jsdom
import { act, StrictMode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ContextUsageControls } from '../hooks/useContextUsageControls';
import { I18nProvider } from '../i18n';
import { WebShellPortalRootContext } from '../portalRoot';
import {
  ContextCompressionAnnouncer,
  useContextCompressionAnnouncements,
  type CompressionAnnouncement,
} from './ContextCompressionAnnouncer';
import { ContextCompressionFeedback } from './ContextCompressionFeedback';

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });
let root: Root;
let container: HTMLDivElement;
let portal: HTMLDivElement;
beforeEach(() => {
  vi.useFakeTimers();
  container = document.createElement('div');
  portal = document.createElement('div');
  document.body.append(container, portal);
  root = createRoot(container);
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
  portal.remove();
  vi.useRealTimers();
});

function mount(shadow = false) {
  const target = shadow
    ? portal
        .attachShadow({ mode: 'open' })
        .appendChild(document.createElement('div'))
    : portal;
  const primary = {
    sessionId: 'a',
    workspaceCwd: '/one',
    compressing: false,
    canCompress: true,
    compress: vi.fn(),
    getContextUsage: vi.fn(),
    captureOwner: vi.fn(),
  } as ContextUsageControls;
  let owners = [primary];
  let surfaces = 2;
  let result: ContextUsageControls['result'];
  let announce!: (event: CompressionAnnouncement) => void;
  function Probe() {
    const state = useContextCompressionAnnouncements();
    announce = state.announce;
    return (
      <I18nProvider language="en">
        <WebShellPortalRootContext.Provider value={target}>
          <ContextCompressionAnnouncer
            owners={owners}
            announcements={state.announcements}
          />
          {Array.from({ length: surfaces }, (_, i) => (
            <ContextCompressionFeedback
              key={i}
              controls={{ compressing: !result, result }}
            />
          ))}
        </WebShellPortalRootContext.Provider>
      </I18nProvider>
    );
  }
  const render = () =>
    act(() =>
      root.render(
        <StrictMode>
          <Probe />
        </StrictMode>,
      ),
    );
  render();
  return {
    target,
    primary,
    send(event: CompressionAnnouncement) {
      act(() => announce(event));
    },
    flush() {
      act(() => vi.runOnlyPendingTimers());
    },
    owners(next: typeof owners) {
      owners = next;
      render();
    },
    surfaces(count: number, nextResult = result) {
      surfaces = count;
      result = nextResult;
      render();
    },
    messages() {
      return [...target.querySelectorAll('[aria-live]')]
        .map((node) => node.textContent)
        .filter(Boolean);
    },
  };
}

describe('ContextCompressionAnnouncer', () => {
  it.each([false, true])(
    'keeps one live message when feedback surfaces change (shadow=%s)',
    (shadow) => {
      const h = mount(shadow);
      expect(h.messages()).toEqual([]);
      const event = {
        operation: {},
        sessionId: 'a',
        workspaceCwd: '/one',
        phase: 'pending' as const,
      };
      h.send(event);
      expect(h.messages()).toEqual([]);
      h.flush();
      expect(h.messages()).toEqual(['Compressing…']);
      expect(
        container.querySelectorAll('[role="status"], [role="alert"]'),
      ).toHaveLength(0);
      const live = h.target.querySelector('[role="status"]');
      for (const count of [1, 0, 2]) {
        h.surfaces(count);
        h.flush();
        expect(h.target.querySelector('[role="status"]')).toBe(live);
        expect(h.messages()).toEqual(['Compressing…']);
      }
      h.send({ ...event, phase: 'failed' });
      h.surfaces(2, { kind: 'failed' });
      h.flush();
      expect(h.messages()).toEqual(['Compression failed. You can try again.']);
      expect(h.target.querySelector('[role="alert"]')?.textContent).toBe(
        h.messages()[0],
      );
      expect(container.querySelectorAll('[data-tone="error"]')).toHaveLength(2);
      expect(container.querySelectorAll('[role="alert"]')).toHaveLength(0);
    },
  );

  it('does not replay a result after an owner leaves and returns', () => {
    const h = mount();
    h.send({
      operation: {},
      sessionId: 'a',
      workspaceCwd: '/one',
      phase: 'failed',
    });
    h.flush();
    expect(h.messages()).toHaveLength(1);
    h.owners([]);
    h.owners([h.primary]);
    h.flush();
    expect(h.messages()).toEqual([]);
  });

  it('does not replay a pending message that lost its owner before delivery', () => {
    const h = mount();
    h.send({
      operation: {},
      sessionId: 'a',
      workspaceCwd: '/one',
      phase: 'pending',
    });
    h.owners([]);
    h.flush();
    h.owners([h.primary]);
    h.flush();
    expect(h.messages()).toEqual([]);
  });

  it('deduplicates the same phase but delivers identical messages from a retry', () => {
    const h = mount();
    const event = {
      operation: {},
      sessionId: 'a',
      workspaceCwd: '/one',
      phase: 'failed' as const,
    };
    h.send(event);
    h.flush();
    const message = h.messages()[0];
    h.send({ ...event });
    expect(h.messages()).toEqual([message]);
    h.send({ ...event, operation: {} });
    expect(h.messages()).toEqual([]);
    h.flush();
    expect(h.messages()).toEqual([message]);
  });

  it('keeps split sessions and workspaces independent', () => {
    const h = mount();
    h.owners([
      h.primary,
      { ...h.primary, sessionId: 'b' },
      { ...h.primary, workspaceCwd: '/two' },
    ]);
    for (const [sessionId, workspaceCwd] of [
      ['a', '/one'],
      ['b', '/one'],
      ['a', '/two'],
    ]) {
      h.send({ operation: {}, sessionId, workspaceCwd, phase: 'pending' });
    }
    h.flush();
    expect(h.messages()).toEqual([
      'Compressing…',
      'Compressing…',
      'Compressing…',
    ]);
  });
});
