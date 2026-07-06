// @vitest-environment jsdom
/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { I18nProvider } from '../i18n';

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

/* eslint-disable @typescript-eslint/no-explicit-any */
let connectionState: any;
let sessionsState: any[];

vi.mock('@qwen-code/webui/daemon-react-sdk', () => ({
  DaemonSessionProvider: (props: any) => (
    <div data-session={props.sessionId} data-clientid={props.clientId}>
      {props.children}
    </div>
  ),
  useConnection: () => connectionState,
  useSessions: () => ({ sessions: sessionsState }),
}));

vi.mock('./ChatPane', () => ({
  ChatPane: (props: any) => (
    <div data-testid="chat-pane" data-current={props.isCurrent ? 'yes' : 'no'}>
      <span data-testid="pane-title">{props.title}</span>
      {props.onClose && (
        <button data-testid="pane-close" onClick={props.onClose}>
          x
        </button>
      )}
    </div>
  ),
}));

const { SplitView } = await import('./SplitView');

let root: Root | null = null;
let container: HTMLDivElement | null = null;

beforeEach(() => {
  connectionState = {
    sessionId: 's3',
    capabilities: { features: [] },
    workspaceCwd: '/w',
  };
  sessionsState = [
    { sessionId: 's1', workspaceCwd: '/w', displayName: 'One' },
    { sessionId: 's2', workspaceCwd: '/w', displayName: 'Two' },
    { sessionId: 's3', workspaceCwd: '/w', displayName: 'Three' },
    { sessionId: 's4', workspaceCwd: '/w', displayName: 'Four' },
  ];
});

afterEach(() => {
  act(() => root?.unmount());
  container?.remove();
  root = null;
  container = null;
});

function render(props: Record<string, unknown> = {}): void {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  act(() =>
    root!.render(
      <I18nProvider language="en">
        <SplitView onExit={() => {}} {...props} />
      </I18nProvider>,
    ),
  );
}

function panes(): HTMLElement[] {
  return Array.from(container!.querySelectorAll('[data-testid="chat-pane"]'));
}
function titles(): string[] {
  return Array.from(container!.querySelectorAll('[data-testid="pane-title"]')).map(
    (el) => el.textContent ?? '',
  );
}

describe('SplitView', () => {
  it('renders one pane per initial session, each under its own provider', () => {
    render({ initialSessionIds: ['s1', 's2'] });
    expect(panes()).toHaveLength(2);
    expect(titles()).toEqual(['One', 'Two']);
    const providers = container!.querySelectorAll('[data-session]');
    expect(providers[0].getAttribute('data-session')).toBe('s1');
    // Panes use a distinct client id so they don't collide with the main view.
    expect(providers[0].getAttribute('data-clientid')).toBe('split-pane:s1');
  });

  it('seeds with the current session when no initial sessions are given', () => {
    render({ initialSessionIds: [] });
    expect(titles()).toEqual(['Three']);
    expect(panes()[0].getAttribute('data-current')).toBe('yes');
  });

  it('dedupes initial sessions', () => {
    render({ initialSessionIds: ['s1', 's1', 's2'] });
    expect(titles()).toEqual(['One', 'Two']);
  });

  it('adds a pane from the picker', () => {
    render({ initialSessionIds: ['s1'] });
    expect(panes()).toHaveLength(1);
    const addButton = container!.querySelector(
      'button[aria-haspopup="listbox"]',
    ) as HTMLButtonElement;
    act(() =>
      addButton.dispatchEvent(new MouseEvent('click', { bubbles: true })),
    );
    // Picker lists sessions not already shown (s2, s3, s4).
    const options = container!.querySelectorAll('[role="option"] button');
    expect(options).toHaveLength(3);
    act(() =>
      options[0].dispatchEvent(new MouseEvent('click', { bubbles: true })),
    );
    expect(panes()).toHaveLength(2);
  });

  it('removes a pane via its close button', () => {
    render({ initialSessionIds: ['s1', 's2'] });
    const closes = container!.querySelectorAll('[data-testid="pane-close"]');
    act(() =>
      closes[0].dispatchEvent(new MouseEvent('click', { bubbles: true })),
    );
    expect(titles()).toEqual(['Two']);
  });

  it('exits via the back button', () => {
    const onExit = vi.fn();
    render({ initialSessionIds: ['s1'], onExit });
    // The back button is the first toolbar button (aria-label from common.back).
    const back = container!.querySelector('header button') as HTMLButtonElement;
    act(() => back.dispatchEvent(new MouseEvent('click', { bubbles: true })));
    expect(onExit).toHaveBeenCalledTimes(1);
  });

  it('caps the number of panes at MAX_PANES (6)', () => {
    sessionsState = Array.from({ length: 8 }, (_, i) => ({
      sessionId: `x${i}`,
      workspaceCwd: '/w',
      displayName: `Pane ${i}`,
    }));
    render({ initialSessionIds: sessionsState.map((s) => s.sessionId) });
    // Eight requested, but only six live panes mount.
    expect(panes()).toHaveLength(6);
  });
});
