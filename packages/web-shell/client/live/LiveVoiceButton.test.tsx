// @vitest-environment jsdom

import { act, type ComponentProps } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { LiveVoiceButton } from './LiveVoiceButton';
import type { UseLiveVoiceResult } from './useLiveVoice';

(
  globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
).IS_REACT_ACT_ENVIRONMENT = true;

const mocks = vi.hoisted(() => ({
  result: {
    supported: true,
    nativeSupported: true,
    browserSupported: false,
    browserHost: {
      phase: 'idle' as const,
      closeReason: undefined,
      errorMessage: undefined,
      captureMode: undefined,
      inputLevel: { current: { level: 0, at: 0, dropping: false } },
      connect: vi.fn(),
      disconnect: vi.fn(),
    },
    status: {
      v: 1 as const,
      available: false,
      state: 'unavailable' as const,
      shortcut: 'Command+Q',
      blocker: 'host_missing' as const,
      requirements: { host: 'missing' as const },
    },
    loading: false,
    mutating: false,
    refresh: vi.fn(async () => undefined),
    start: vi.fn(async () => undefined),
    stop: vi.fn(async () => undefined),
    setMute: vi.fn(async () => undefined),
  } as UseLiveVoiceResult,
}));

vi.mock('./useLiveVoice', () => ({
  useLiveVoice: () => mocks.result,
}));

const mounted: Array<{ root: Root; container: HTMLElement }> = [];

function mount(
  props: ComponentProps<typeof LiveVoiceButton> = {},
): HTMLElement {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  act(() => root.render(<LiveVoiceButton {...props} />));
  mounted.push({ root, container });
  return container;
}

function click(element: Element): void {
  act(() => {
    element.dispatchEvent(new MouseEvent('click', { bubbles: true }));
  });
}

function buttonNamed(name: string): HTMLButtonElement {
  const button = [...document.querySelectorAll('button')].find(
    (candidate) => candidate.textContent === name,
  );
  if (!(button instanceof HTMLButtonElement)) {
    throw new Error(`Button ${name} was not rendered`);
  }
  return button;
}

beforeEach(() => {
  mocks.result.supported = true;
  mocks.result.status = {
    v: 1,
    available: false,
    state: 'unavailable',
    shortcut: 'Command+Q',
    blocker: 'host_missing',
    requirements: { host: 'missing' },
  };
  mocks.result.loading = false;
  mocks.result.mutating = false;
  mocks.result.refresh.mockClear();
  mocks.result.start.mockClear();
  mocks.result.stop.mockClear();
  mocks.result.setMute.mockClear();
  const getUserMedia = navigator.mediaDevices?.getUserMedia;
  if (getUserMedia && vi.isMockFunction(getUserMedia)) {
    getUserMedia.mockClear();
  }
});

afterEach(() => {
  for (const { root, container } of mounted.splice(0)) {
    act(() => root.unmount());
    container.remove();
  }
  document.body.replaceChildren();
});

describe('LiveVoiceButton', () => {
  it('stays absent when the daemon lacks realtime_voice', () => {
    mocks.result.supported = false;
    const container = mount();

    expect(container.querySelector('button')).toBeNull();
  });

  it('refreshes Live status when the dialog opens', () => {
    const container = mount();
    const trigger = container.querySelector('button');
    if (!trigger) throw new Error('Live trigger was not rendered');

    click(trigger);

    expect(mocks.result.refresh).toHaveBeenCalledOnce();
  });

  it('shows the hard gate and refuses start while Host is missing', () => {
    const container = mount();
    const trigger = container.querySelector('button');
    if (!trigger) throw new Error('Live trigger was not rendered');
    click(trigger);

    expect(document.body.textContent).toContain('live.noFallback');
    expect(buttonNamed('live.startOrResume').disabled).toBe(true);
    expect(buttonNamed('live.newConversation').disabled).toBe(true);
    click(buttonNamed('live.refresh'));
    expect(mocks.result.refresh).toHaveBeenCalledTimes(2);
    expect(mocks.result.start).not.toHaveBeenCalled();
  });

  it('offers explicit resume and new conversation only when ready', () => {
    mocks.result.status = {
      v: 1,
      available: true,
      state: 'idle',
      shortcut: 'Command+Q',
      requirements: {
        host: 'ready',
        microphone: 'ready',
        accessibility: 'ready',
        screenRecording: 'ready',
        provider: 'ready',
      },
    };
    const container = mount();
    const trigger = container.querySelector('button');
    if (!trigger) throw new Error('Live trigger was not rendered');
    click(trigger);

    click(buttonNamed('live.startOrResume'));
    click(buttonNamed('live.newConversation'));

    expect(mocks.result.start).toHaveBeenNthCalledWith(1, 'resume');
    expect(mocks.result.start).toHaveBeenNthCalledWith(2, 'new');
  });

  it('lets an active call mute or stop without browser audio capture', () => {
    mocks.result.status = {
      v: 1,
      available: true,
      state: 'listening',
      shortcut: 'Command+Q',
      inputMuted: false,
      outputMuted: false,
      transcript: '看看当前页面',
      caption: '当前页面是文档编辑器。',
      statusText: 'Reading screen…',
    };
    const container = mount();
    const trigger = container.querySelector('button');
    if (!trigger) throw new Error('Live trigger was not rendered');
    click(trigger);

    click(buttonNamed('live.muteInput'));
    click(buttonNamed('live.muteOutput'));
    click(buttonNamed('live.stop'));

    expect(mocks.result.setMute).toHaveBeenCalledWith({ inputMuted: true });
    expect(mocks.result.setMute).toHaveBeenCalledWith({ outputMuted: true });
    expect(document.body.textContent).toContain('看看当前页面');
    expect(document.body.textContent).toContain('当前页面是文档编辑器。');
    expect(document.body.textContent).toContain('Reading screen…');
    expect(mocks.result.stop).toHaveBeenCalledOnce();
    expect(document.body.textContent).not.toContain('live.newConversation');
    expect(mocks.result.start).not.toHaveBeenCalled();
    expect(navigator.mediaDevices?.getUserMedia).not.toHaveBeenCalled();
  });
});

describe('LiveVoiceButton as a browser Host', () => {
  function openDialog(): void {
    const trigger = mount().querySelector('button');
    if (!trigger) throw new Error('Live trigger was not rendered');
    click(trigger);
  }

  function requirementLabels(): string[] {
    return [...document.querySelectorAll('li > span:first-child')].map(
      (element) => element.textContent ?? '',
    );
  }

  beforeEach(() => {
    mocks.result.nativeSupported = false;
    mocks.result.browserSupported = true;
    mocks.result.status = {
      v: 1,
      available: false,
      state: 'unavailable',
      shortcut: '',
      blocker: 'host_missing',
      message: 'Qwen Live Host is not connected.',
      requirements: { host: 'missing' },
    };
    mocks.result.browserHost = {
      phase: 'idle',
      closeReason: undefined,
      errorMessage: undefined,
      captureMode: undefined,
      inputLevel: { current: { level: 0, at: 0, dropping: false } },
      connect: vi.fn(),
      disconnect: vi.fn(),
    };
  });

  afterEach(() => {
    mocks.result.nativeSupported = true;
    mocks.result.browserSupported = false;
  });

  it('offers this tab as the endpoint instead of the native install gate', () => {
    openDialog();

    expect(document.body.textContent).not.toContain('live.noFallback');
    expect(document.body.textContent).toContain(
      'live.browser.setupDescription',
    );
    // No OS permissions a page could never grant.
    expect(requirementLabels()).toEqual([
      'live.browser.requirement.host',
      'live.requirement.microphone',
      'live.requirement.audioInput',
      'live.requirement.audioOutput',
      'live.browser.requirement.runtime',
      'live.requirement.provider',
    ]);
    // The daemon's "Qwen Live Host is not connected" is about the native app.
    expect(document.body.textContent).not.toContain('Qwen Live Host');

    click(buttonNamed('live.browser.connect'));
    expect(mocks.result.browserHost.connect).toHaveBeenCalledWith({
      takeover: false,
    });
  });

  it('drives the call from this tab once it holds the lease', () => {
    mocks.result.browserHost.phase = 'connected';
    mocks.result.status = {
      v: 1,
      available: true,
      state: 'idle',
      shortcut: 'Command+Q',
      host: { version: 'web-shell', protocolVersion: 9, kind: 'browser' },
    };
    openDialog();

    expect(document.body.textContent).toContain(
      'live.browser.readyDescription',
    );
    // A page has no global shortcut to advertise.
    expect(document.body.textContent).not.toContain('live.shortcutHint');
    expect(buttonNamed('live.startOrResume').disabled).toBe(false);
    expect(document.querySelector('[data-live-browser-connect]')).toBeNull();

    click(buttonNamed('live.browser.disconnect'));
    expect(mocks.result.browserHost.disconnect).toHaveBeenCalledOnce();
  });

  it('shows the microphone level only while this tab is the endpoint', () => {
    mocks.result.browserHost.phase = 'connected';
    mocks.result.status = {
      v: 1,
      available: true,
      state: 'listening',
      shortcut: '',
      host: { kind: 'browser' },
    };
    openDialog();
    expect(document.querySelector('[data-live-level-meter]')).not.toBeNull();
    expect(
      document
        .querySelector('[data-live-level-meter]')
        ?.getAttribute('data-muted'),
    ).toBe('false');
  });

  it('marks the meter muted when input is muted', () => {
    mocks.result.browserHost.phase = 'connected';
    mocks.result.status = {
      v: 1,
      available: true,
      state: 'listening',
      shortcut: '',
      inputMuted: true,
      host: { kind: 'browser' },
    };
    openDialog();
    expect(
      document
        .querySelector('[data-live-level-meter]')
        ?.getAttribute('data-muted'),
    ).toBe('true');
  });

  it('records which capture path is live, for support', () => {
    mocks.result.browserHost.phase = 'connected';
    mocks.result.browserHost.captureMode = 'worklet';
    mocks.result.status = {
      v: 1,
      available: true,
      state: 'idle',
      shortcut: '',
      host: { kind: 'browser' },
    };
    openDialog();
    expect(
      document
        .querySelector('[data-live-capture]')
        ?.getAttribute('data-live-capture'),
    ).toBe('worklet');
  });

  it('has a status region ready, and empty, while this tab is the endpoint', () => {
    mocks.result.browserHost.phase = 'connected';
    mocks.result.status = {
      v: 1,
      available: true,
      state: 'listening',
      shortcut: '',
      host: { kind: 'browser' },
    };
    openDialog();

    // Mounted before it has anything to say: a live region that appears
    // together with its text is not announced.
    const region = document.querySelector('[data-live-input-dropping]');
    expect(region?.getAttribute('role')).toBe('status');
    expect(region?.textContent).toBe('');
    expect(region?.getAttribute('data-live-input-dropping')).toBe('false');
  });

  it('shows no meter for a call another endpoint is carrying', () => {
    mocks.result.status = {
      v: 1,
      available: true,
      state: 'listening',
      shortcut: '',
      host: { kind: 'browser' },
    };
    openDialog();
    expect(document.querySelector('[data-live-level-meter]')).toBeNull();
  });

  it('keeps the microphone while a call is running', () => {
    mocks.result.browserHost.phase = 'connected';
    mocks.result.status = {
      v: 1,
      available: true,
      state: 'listening',
      shortcut: '',
      host: { kind: 'browser' },
    };
    openDialog();

    expect(document.querySelector('[data-live-browser-disconnect]')).toBeNull();
    expect(buttonNamed('live.stop')).toBeTruthy();
  });

  it('asks before taking the call over from another tab', () => {
    mocks.result.status = {
      v: 1,
      available: true,
      state: 'listening',
      shortcut: '',
      host: { kind: 'browser' },
    };
    openDialog();

    expect(document.body.textContent).toContain(
      'live.browser.otherTabDescription',
    );
    click(buttonNamed('live.browser.takeOver'));
    expect(mocks.result.browserHost.connect).toHaveBeenCalledWith({
      takeover: true,
    });
  });

  it('turns a refused lease into a takeover offer', () => {
    mocks.result.browserHost.phase = 'error';
    mocks.result.browserHost.closeReason = 'occupied';
    openDialog();

    expect(document.body.textContent).toContain('live.browser.closed.occupied');
    click(buttonNamed('live.browser.takeOver'));
    expect(mocks.result.browserHost.connect).toHaveBeenCalledWith({
      takeover: true,
    });
  });

  it('says so when the native Host took the call away', () => {
    mocks.result.browserHost.phase = 'error';
    mocks.result.browserHost.closeReason = 'superseded-native';
    mocks.result.status = {
      v: 1,
      available: true,
      state: 'idle',
      shortcut: 'Command+Q',
      host: { version: '1.0.0', protocolVersion: 9 },
    };
    openDialog();

    expect(document.body.textContent).toContain(
      'live.browser.closed.supersededNative',
    );
  });

  it('shows the browser microphone error verbatim', () => {
    mocks.result.browserHost.phase = 'error';
    mocks.result.browserHost.closeReason = 'microphone';
    mocks.result.browserHost.errorMessage = 'No microphone found.';
    openDialog();

    expect(document.body.textContent).toContain('No microphone found.');
  });

  it('stays a plain remote control while a native Host is attached', () => {
    mocks.result.nativeSupported = true;
    mocks.result.status = {
      v: 1,
      available: true,
      state: 'idle',
      shortcut: 'Command+Q',
      host: { version: '1.0.0', protocolVersion: 9 },
    };
    openDialog();

    expect(document.querySelector('[data-live-browser-connect]')).toBeNull();
    expect(document.body.textContent).toContain('live.readyDescription');
    expect(document.body.textContent).toContain('live.shortcutHint');
    expect(document.body.textContent).not.toContain('live.browser.');
  });

  it('keeps the native gate first on macOS and offers the browser second', () => {
    mocks.result.nativeSupported = true;
    mocks.result.status = { ...mocks.result.status!, shortcut: 'Command+Q' };
    openDialog();

    // Until a Host is chosen the dialog is still the native one...
    expect(document.body.textContent).toContain('live.setupDescription');
    expect(requirementLabels()).toHaveLength(9);
    expect(document.body.textContent).toContain('live.shortcutHint');
    // ...minus the claim that the browser microphone is never used.
    expect(document.body.textContent).not.toContain('live.noFallback');
    expect(buttonNamed('live.browser.connect')).toBeTruthy();
  });
});

describe('mobile Live voice entry', () => {
  it('opens from a controlled secondary entry while keeping the idle trigger hidden', () => {
    const onSupportedChange = vi.fn();
    const container = mount({
      hideInactiveTrigger: true,
      open: true,
      onOpenChange: vi.fn(),
      onSupportedChange,
    });
    expect(container.querySelector('button')).toBeNull();
    expect(
      document.querySelector('[data-web-shell-live-dialog]'),
    ).not.toBeNull();
    expect(onSupportedChange).toHaveBeenCalledWith(true);
    expect(mocks.result.refresh).toHaveBeenCalledOnce();
  });
  it('reports capability arrival and removal on the same mounted root', () => {
    mocks.result.supported = false;
    const onSupportedChange = vi.fn();
    mount({ onSupportedChange });
    expect(onSupportedChange).toHaveBeenLastCalledWith(false);
    for (const supported of [true, false]) {
      mocks.result.supported = supported;
      act(() =>
        mounted
          .at(-1)!
          .root.render(
            <LiveVoiceButton onSupportedChange={onSupportedChange} />,
          ),
      );
      expect(onSupportedChange).toHaveBeenLastCalledWith(supported);
    }
    expect(onSupportedChange).toHaveBeenCalledTimes(3);
  });

  it('forwards controlled trigger opening and closing through the parent', () => {
    const onOpenChange = vi.fn();
    const container = mount({ open: false, onOpenChange });
    click(container.querySelector('button')!);
    expect(onOpenChange).toHaveBeenLastCalledWith(true);
    expect(document.querySelector('[data-web-shell-live-dialog]')).toBeNull();
    act(() =>
      mounted
        .at(-1)!
        .root.render(<LiveVoiceButton open onOpenChange={onOpenChange} />),
    );
    expect(
      document.querySelector('[data-web-shell-live-dialog]'),
    ).not.toBeNull();
    expect(mocks.result.refresh).toHaveBeenCalledOnce();
    click(
      document.querySelector(
        '[data-web-shell-live-dialog] [data-slot="dialog-close"]',
      )!,
    );
    expect(onOpenChange).toHaveBeenLastCalledWith(false);
  });

  it('returns focus to the supplied mobile entry when the hidden-trigger dialog closes', async () => {
    const fallback = document.createElement('button');
    document.body.append(fallback);
    const onRequestFocusFallback = () => fallback.focus();
    mount({ hideInactiveTrigger: true, open: true, onRequestFocusFallback });
    await act(async () => {
      mounted
        .at(-1)!
        .root.render(
          <LiveVoiceButton
            hideInactiveTrigger
            open={false}
            onRequestFocusFallback={onRequestFocusFallback}
          />,
        );
    });
    await act(async () => {
      await new Promise((r) => setTimeout(r, 50));
    });
    expect(document.activeElement).toBe(fallback);
  });

  it('keeps the toolbar trigger available during an active call', () => {
    mocks.result.status = {
      ...mocks.result.status!,
      available: true,
      state: 'listening',
    };
    const container = mount({ hideInactiveTrigger: true });
    expect(container.querySelector('[data-active="true"]')).not.toBeNull();
  });
});
