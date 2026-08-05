// @vitest-environment jsdom

import { act } from 'react';
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

function mount(): HTMLElement {
  const container = document.createElement('div');
  document.body.appendChild(container);
  const root = createRoot(container);
  act(() => root.render(<LiveVoiceButton />));
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
