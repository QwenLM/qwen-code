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
import type { WebShellLanguage } from '../i18n';
import {
  DesktopRelayPanel,
  deriveDesktopRelayStatus,
  retainLiveDesktopRelayProbe,
  type DesktopRelayStatus,
} from './DesktopRelayControl';

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

let container: HTMLDivElement | null = null;
let root: Root | null = null;

function mount(status: DesktopRelayStatus, language: WebShellLanguage = 'en') {
  const handlers = {
    onConnect: vi.fn(),
    onDisconnect: vi.fn(),
    onCheckAgain: vi.fn(),
    onCopyCommand: vi.fn(),
  };
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
  act(() => {
    root!.render(
      <I18nProvider language={language}>
        <DesktopRelayPanel
          status={status}
          installCommand="npx -y @qwen-code/node-repl-mcp@0.1.7 desktop-relay install"
          copied={false}
          {...handlers}
        />
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

const text = () => container?.textContent ?? '';
const button = (label: string) =>
  Array.from(container?.querySelectorAll('button') ?? []).find(
    (candidate) => candidate.textContent?.trim() === label,
  );

describe('DesktopRelayPanel', () => {
  it('shows the one-time setup command when the relay is not installed', () => {
    const handlers = mount({ phase: 'missing' });
    expect(text()).toContain('desktop-relay install');
    act(() => button('Copy command')?.click());
    act(() => button('Check again')?.click());
    expect(handlers.onCopyCommand).toHaveBeenCalled();
    expect(handlers.onCheckAgain).toHaveBeenCalled();
    expect(button('Connect this computer')).toBeUndefined();
  });

  it('offers to connect when idle and to disconnect when connected', () => {
    const idle = mount({ phase: 'idle' });
    act(() => button('Connect this computer')?.click());
    expect(idle.onConnect).toHaveBeenCalled();
    expect(button('Disconnect')).toBeUndefined();
    act(() => root?.unmount());
    container?.remove();

    const connected = mount({ phase: 'connected' });
    expect(button('Connect this computer')).toBeUndefined();
    act(() => button('Disconnect')?.click());
    expect(connected.onDisconnect).toHaveBeenCalled();
  });

  it('points at the dialog while waiting for approval', () => {
    mount({ phase: 'awaiting-approval' });
    expect(text()).toContain('dialog that opened on this computer');
    expect(button('Connect this computer')).toBeUndefined();
  });

  it('explains how to grant browser local network access', () => {
    const handlers = mount({ phase: 'permission-required' });
    expect(text()).toContain('Allow local network access');
    act(() => button('Check again')?.click());
    expect(handlers.onCheckAgain).toHaveBeenCalled();
    expect(text()).not.toContain('desktop-relay install');
  });

  it('explains why the entry is unavailable', () => {
    mount({ phase: 'unavailable', blocker: 'unsupported-daemon' });
    expect(text()).toContain('QWEN_SERVE_CLIENT_MCP_OVER_WS=1');
  });

  it('explains a failed connection even when the relay provides no message', () => {
    mount({ phase: 'failed' });
    expect(container?.querySelector('[role="alert"]')?.textContent).toBe(
      'Could not reach the desktop relay on this computer.',
    );
    expect(button('Connect this computer')).toBeDefined();
  });

  it('uses the current Web Shell language', () => {
    mount({ phase: 'idle' }, 'zh-CN');
    expect(button('连接这台电脑')).toBeDefined();
  });
});

describe('deriveDesktopRelayStatus', () => {
  const base = {
    blocker: undefined,
    sessionId: 's1',
    daemonUrl: 'https://devbox:4170/',
    awaitingApproval: false,
    error: undefined,
  };

  it.each([
    { blocker: 'workspace-ineligible' as const },
    { blocker: 'workspace-resolving' as const },
    { blocker: 'unsupported-daemon' as const },
    { sessionId: undefined },
    { daemonUrl: undefined },
  ])(
    'keeps revocation available when connecting is blocked: %j',
    (overrides) => {
      const status = deriveDesktopRelayStatus({
        ...base,
        ...overrides,
        probe: {
          kind: 'ready',
          version: '0.1.6',
          active: {
            sessionId: 's1',
            daemonUrl: base.daemonUrl,
            phase: 'connected',
          },
        },
      });
      const handlers = mount(status);
      expect(button('Connect this computer')).toBeUndefined();
      expect(button('Disconnect')).toBeDefined();
      act(() => button('Disconnect')?.click());
      expect(handlers.onDisconnect).toHaveBeenCalledOnce();
    },
  );

  it('prefers blockers, then a missing session, then a pending approval', () => {
    expect(
      deriveDesktopRelayStatus({
        ...base,
        blocker: 'insecure-context',
        probe: undefined,
      }),
    ).toEqual({ phase: 'unavailable', blocker: 'insecure-context' });
    expect(
      deriveDesktopRelayStatus({
        ...base,
        sessionId: undefined,
        probe: undefined,
      }),
    ).toEqual({ phase: 'needs-session' });
    expect(
      deriveDesktopRelayStatus({
        ...base,
        awaitingApproval: true,
        probe: undefined,
      }),
    ).toEqual({ phase: 'awaiting-approval' });
  });

  it('follows the relay for this session and flags one held by another', () => {
    const probe = (
      sessionId: string,
      phase: 'connected' | 'registering' | 'failed',
    ) => ({
      kind: 'ready' as const,
      version: '0.1.5',
      active: {
        sessionId,
        daemonUrl: 'https://devbox:4170',
        phase,
        message: 'why',
      },
    });
    expect(
      deriveDesktopRelayStatus({ ...base, probe: probe('s1', 'connected') }),
    ).toEqual({
      phase: 'connected',
    });
    expect(
      deriveDesktopRelayStatus({ ...base, probe: probe('s1', 'registering') }),
    ).toEqual({
      phase: 'connecting',
    });
    expect(
      deriveDesktopRelayStatus({ ...base, probe: probe('s1', 'failed') }),
    ).toEqual({
      phase: 'failed',
      message: 'why',
    });
    expect(
      deriveDesktopRelayStatus({ ...base, probe: probe('s2', 'connected') }),
    ).toEqual({
      phase: 'other-session',
    });
    expect(
      deriveDesktopRelayStatus({ ...base, probe: { kind: 'missing' } }),
    ).toEqual({
      phase: 'missing',
    });
    expect(
      deriveDesktopRelayStatus({
        ...base,
        probe: { kind: 'permission-required' },
      }),
    ).toEqual({ phase: 'permission-required' });
  });
});

describe('retainLiveDesktopRelayProbe', () => {
  const live = {
    kind: 'ready' as const,
    version: '0.1.6',
    active: {
      sessionId: 's1',
      daemonUrl: 'https://devbox:4170/',
      phase: 'connected' as const,
    },
  };

  it.each([
    { kind: 'missing' as const },
    { kind: 'permission-required' as const },
  ])(
    'keeps a live revocation target across an inconclusive $kind probe',
    (next) => {
      expect(retainLiveDesktopRelayProbe(live, next)).toBe(live);
    },
  );

  it('accepts a conclusive ready probe that reports no active relay', () => {
    const idle = { kind: 'ready' as const, version: '0.1.6' };
    expect(retainLiveDesktopRelayProbe(live, idle)).toBe(idle);
  });
});
