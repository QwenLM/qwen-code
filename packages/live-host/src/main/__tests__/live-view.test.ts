import assert from 'node:assert/strict';
import { afterEach, describe, it } from 'node:test';
import { JSDOM } from 'jsdom';
import { LiveView } from '../../renderer/live-view.ts';
import type { HostPublicState, LiveHostApi } from '../../shared/host-api.ts';
import { liveMessage, liveText } from '@qwen-code/qwen-live/i18n';

const baseline: HostPublicState = {
  connection: 'ready',
  canOpenConfig: true,
  live: { v: 1, available: true, state: 'idle', shortcut: 'Command+E' },
  permissions: {
    microphone: 'granted',
    camera: 'granted',
    accessibility: 'granted',
    screenRecording: 'granted',
  },
  selfChecks: {
    audioInput: true,
    audioOutput: true,
    globalShortcut: true,
    appshot: true,
  },
  visualInput: {
    source: 'screen',
    mode: 'on-demand',
    fps: 1,
    liveWidth: 1280,
    liveHeight: 720,
  },
  memory: {
    enabled: true,
    visualEnabled: false,
    libraryId: 'default',
    model: 'qwen3.7-plus',
    libraries: [{ id: 'default', name: 'Default' }],
    locked: false,
  },
  visualReady: true,
};
const cleanup: Array<() => void> = [];
afterEach(() => {
  for (const run of cleanup.splice(0).reverse()) run();
});
const settled = () => new Promise<void>((resolve) => setImmediate(resolve));

function setup(overrides: Partial<LiveHostApi> = {}) {
  const dom = new JSDOM('<!doctype html><body><main id="app"></main></body>');
  const previous = Object.getOwnPropertyDescriptor(globalThis, 'document');
  Object.defineProperty(globalThis, 'document', {
    configurable: true,
    value: dom.window.document,
  });
  cleanup.push(() => {
    dom.window.close();
    if (previous) Object.defineProperty(globalThis, 'document', previous);
    else Reflect.deleteProperty(globalThis, 'document');
  });
  const app = dom.window.document.querySelector<HTMLElement>('#app')!;
  let current = structuredClone(baseline);
  const calls: unknown[][] = [];
  const layouts: string[] = [];
  let dismiss: () => void = () => {};
  let offsetChanged: (offset: { x: number; y: number }) => void = () => {};
  const api: LiveHostApi = {
    toggle: async () => {
      calls.push(['toggle']);
    },
    stop: async () => {
      calls.push(['stop']);
    },
    quit: async () => {
      calls.push(['quit']);
    },
    newConversation: async () => {},
    setInputMuted: async (value) => {
      calls.push(['input', value]);
    },
    setOutputMuted: async (value) => {
      calls.push(['output', value]);
    },
    setVisualSource: async (value) => {
      calls.push(['source', value]);
    },
    setVisualMode: async (value) => {
      calls.push(['mode', value]);
    },
    setScreenDisplay: async (value) => {
      calls.push(['display', value]);
    },
    memoryAction: async (value) => {
      calls.push(['memory', value]);
      return current.memory!;
    },
    setSettingsOpen: async (value) => {
      calls.push(['settings', value]);
    },
    openSubagents: async () => {
      calls.push(['openSubagents']);
    },
    openConfig: async () => {
      calls.push(['openConfig']);
    },
    setOverlayLayout: (layout) => {
      layouts.push(layout);
    },
    onSettingsDismiss: (callback) => {
      dismiss = callback;
      return () => {};
    },
    onOverlayOffset: (callback) => {
      offsetChanged = callback;
      return () => {};
    },
    dragOverlay: (phase, x, y) => {
      calls.push(['drag', phase, x, y]);
    },
    attachCameraPreview: () => {
      calls.push(['preview']);
    },
    requestPermission: async (value) => {
      calls.push(['permission', value]);
    },
    listInputDevices: async () => [
      { deviceId: 'mic-1', label: 'Microphone 1', selected: true },
      { deviceId: 'mic-2', label: 'Microphone 2', selected: false },
    ],
    setInputDevice: async (value) => {
      calls.push(['device', value]);
    },
    setLanguage: async (language) => {
      calls.push(['language', language]);
    },
    setTheme: async (theme) => {
      calls.push(['theme', theme]);
    },
    openWebShellForPermission: async () => {},
    getState: async () => current,
    onInputLevel: () => () => {},
    onState: () => () => {},
    ...overrides,
  };
  const view = new LiveView(app, api);
  cleanup.push(() => view.dispose());
  view.update(current);
  const get = <T extends HTMLElement = HTMLElement>(selector: string): T => {
    const element = app.querySelector<T>(selector);
    assert(element, `Missing ${selector}`);
    return element;
  };
  const click = (label: string) =>
    get<HTMLButtonElement>(`[aria-label="${label}"]`).click();
  const pointer = (element: HTMLElement, type: string, x = 0, y = 0) => {
    const event = new dom.window.MouseEvent(type, {
      bubbles: type !== 'pointerenter' && type !== 'pointerleave',
      button: 0,
      screenX: x,
      screenY: y,
    });
    Object.defineProperty(event, 'pointerId', { value: 1 });
    element.dispatchEvent(event);
  };
  const update = (next: HostPublicState) => {
    current = next;
    view.update(next);
  };
  return {
    dom,
    app,
    view,
    api,
    calls,
    layouts,
    get,
    click,
    pointer,
    update,
    dismiss: () => dismiss(),
    offset: (value: { x: number; y: number }) => offsetChanged(value),
    state: () => current,
  };
}

describe('persistent Live orb and Settings', () => {
  it('does not ask Screen Live Feed users for accessibility but preserves the On Demand requirement', () => {
    const h = setup();
    const state = h.state();
    h.update({
      ...state,
      live: { ...state.live, available: false, state: 'unavailable' },
      visualInput: { ...state.visualInput!, mode: 'live-feed' },
      permissions: { ...state.permissions, accessibility: 'denied' },
    });
    assert.equal(h.get('[data-permission="accessibility"]').hidden, true);
    assert.equal(h.get('[data-permission="screenRecording"]').hidden, false);
    h.update({
      ...h.state(),
      visualInput: { ...state.visualInput!, mode: 'on-demand' },
    });
    assert.equal(h.get('[data-permission="accessibility"]').hidden, false);
  });

  it('opens the active config with no path argument, without dragging or changing the call', async () => {
    const h = setup();
    h.click('Settings');
    await settled();
    const open = h.get<HTMLButtonElement>('[data-live-label="ui.openConfig"]');
    assert.equal(h.get('.settings-panel').lastElementChild, open.parentElement);
    assert.equal(open.textContent, 'Open configuration');
    assert.equal(open.disabled, false);
    assert.match(
      h.get('.settings-config-status').textContent ?? '',
      /restart Qwen Live/,
    );
    h.calls.length = 0;
    h.pointer(open, 'pointerdown', 100, 100);
    h.pointer(open, 'pointermove', 130, 120);
    h.pointer(open, 'pointerup', 130, 120);
    assert.deepEqual(h.calls, []);
    open.click();
    await settled();
    assert.deepEqual(h.calls, [['openConfig']]);
    assert.equal(h.get('.settings-layer').hidden, false);
    h.update({ ...h.state(), language: 'zh-CN' });
    assert.equal(open.textContent, '打开配置文件');
    assert.equal(open.getAttribute('aria-label'), '打开 config.json ↗');
    assert.match(
      h.get('.settings-config-status').textContent ?? '',
      /保存后重启/,
    );
    const groups = Array.from(
      h.app.querySelectorAll('.settings-field > strong'),
    );
    assert.deepEqual(
      groups.slice(-2).map((group) => group.textContent),
      ['语言', '外观'],
    );
  });

  it('deduplicates pending config opens and shows localized errors next to the action for retry', async () => {
    let calls = 0;
    let rejectOpen: (error: Error) => void = () => {};
    const h = setup({
      openConfig: () => {
        calls++;
        return new Promise<void>((_resolve, reject) => {
          rejectOpen = reject;
        });
      },
    });
    h.click('Settings');
    await settled();
    const open = h.get<HTMLButtonElement>('[data-live-label="ui.openConfig"]');
    open.click();
    open.click();
    assert.equal(calls, 1);
    assert.equal(open.disabled, true);
    assert.equal(
      h.get('.settings-config-status').textContent,
      'Opening editor…',
    );
    h.update({ ...h.state(), language: 'zh-CN' });
    assert.equal(
      h.get('.settings-config-status').textContent,
      '正在打开编辑器…',
    );
    rejectOpen(
      new Error(
        `Error invoking remote method 'live:open-config': Error: ${liveMessage('host.config.openFailed')}`,
      ),
    );
    await settled();
    assert.equal(open.disabled, false);
    assert.equal(
      h.get('.settings-config-status.error').textContent,
      liveText('zh-CN', 'host.config.openFailed'),
    );
    open.click();
    assert.equal(calls, 2);
    assert.equal(
      h.get('.settings-config-status').classList.contains('error'),
      false,
    );
    rejectOpen(new Error(liveMessage('host.config.inaccessible')));
    await settled();
    assert.equal(
      h.get('.settings-config-status.error').textContent,
      liveText('zh-CN', 'host.config.inaccessible'),
    );
  });

  it('does not offer config opening on unsupported, quitting or disconnected connections', async () => {
    const h = setup();
    h.click('Settings');
    await settled();
    const open = h.get<HTMLButtonElement>('[data-live-label="ui.openConfig"]');
    h.calls.length = 0;
    for (const state of [
      { ...baseline, canOpenConfig: undefined },
      { ...baseline, canOpenConfig: false },
      { ...baseline, quitState: 'pending' as const },
      { ...baseline, connection: 'disconnected' as const },
    ]) {
      h.update(state);
      assert.equal(open.disabled, true);
      open.click();
    }
    assert.equal(
      h.calls.some(([action]) => action === 'openConfig'),
      false,
    );
    assert.equal(h.get('.settings-layer').hidden, true);
  });

  it('keeps mute indicators below the primary call state in English and Chinese without requiring hover', () => {
    const h = setup();
    for (const language of ['en', 'zh-CN'] as const) {
      for (const [inputMuted, outputMuted, expected] of [
        [
          false,
          false,
          language === 'en' ? 'Screen · On Demand' : '屏幕 · 按需截图',
        ],
        [true, false, language === 'en' ? 'Mic off' : '麦克风已关闭'],
        [false, true, language === 'en' ? 'Speaker muted' : '播报已静音'],
        [
          true,
          true,
          language === 'en'
            ? 'Mic off · Speaker muted'
            : '麦克风已关闭 · 播报已静音',
        ],
      ] as const) {
        h.update({
          ...h.state(),
          language,
          live: {
            ...baseline.live,
            state: 'listening',
            inputMuted,
            outputMuted,
          },
        });
        assert.equal(h.get('.voice-status').hidden, false);
        assert.equal(
          h.get('.voice-status-primary').textContent,
          liveText(language, 'ui.listening'),
        );
        assert.equal(h.get('.voice-status-audio').textContent, expected);
        assert.equal(h.get('.voice-status-audio').hidden, !expected);
        assert.equal(
          h.get('.voice-controls').getAttribute('aria-hidden'),
          null,
        );
      }
    }
  });

  it('preserves mute indicators with permissions, errors and quit states and retains the full primary text', () => {
    const h = setup();
    h.update({
      ...h.state(),
      live: {
        ...baseline.live,
        state: 'listening',
        inputMuted: true,
        outputMuted: true,
        pendingPermission: { workspaceId: 'work', sessionId: 'session' },
      },
    });
    const status = h.get('.voice-status');
    assert.equal(status.hidden, false);
    assert.equal(h.get('.permission-link').hidden, false);
    assert.equal(status.contains(h.get('.permission-link')), true);
    assert.equal(h.get('.voice-status-primary').hidden, true);
    assert.equal(
      h.get('.voice-status-audio').textContent,
      'Mic off · Speaker muted',
    );
    for (const quitState of ['pending', 'failed'] as const) {
      h.update({ ...h.state(), quitState });
      assert.equal(h.get('.permission-link').hidden, true);
      assert.equal(h.get('.voice-status-primary').hidden, false);
      assert.equal(h.get('.voice-status-audio').hidden, false);
      assert.match(
        h.get('.voice-status-primary').textContent ?? '',
        quitState === 'pending' ? /Quitting/ : /retry Quit/,
      );
    }
    const error = 'Connection failed: '.repeat(12);
    h.update({
      ...h.state(),
      quitState: undefined,
      live: {
        ...baseline.live,
        state: 'error',
        message: error,
        inputMuted: true,
        outputMuted: true,
      },
    });
    assert.equal(h.get('.voice-status-primary').textContent, error);
    assert.equal(h.get('.voice-status-primary').title, error);
    assert.equal(
      h.get('.voice-status-primary').closest('[data-live-interactive]'),
      h.get('.voice-status-primary'),
    );
    assert.equal(
      h.get('.voice-surface').hasAttribute('data-live-interactive'),
      false,
    );
    h.calls.length = 0;
    h.pointer(h.get('.voice-status-primary'), 'pointerdown', 100, 100);
    h.pointer(h.get('.voice-status-primary'), 'pointermove', 150, 150);
    h.pointer(h.get('.voice-status-primary'), 'pointerup', 150, 150);
    assert.deepEqual(h.calls, []);
    assert.equal(status.classList.contains('error'), true);
    assert.equal(h.get('.voice-status-audio').hidden, false);
    h.update({ ...h.state(), live: baseline.live });
    assert.equal(
      h.get('.voice-status-audio').textContent,
      'Screen · On Demand',
    );
    assert.equal(status.classList.contains('has-audio-status'), false);
  });

  it('opens the embedded task summary without a hover window, and handles attention and disconnect', async () => {
    const hover: boolean[] = [];
    const h = setup({ setSubagentsHover: (value) => hover.push(value) });
    const summary = h.get<HTMLButtonElement>('.task-summary');
    assert.equal(summary.hidden, true);
    const layouts = [...h.layouts];
    h.update({
      ...h.state(),
      subagentsV1: {
        revision: 1,
        counts: {
          running: 2,
          completed: 3,
          needsAttention: 0,
          failed: 0,
          cancelled: 0,
          interrupted: 0,
        },
        tasks: [],
        omitted: 0,
        pendingUnassignedPermissions: 1,
      },
    });
    assert.equal(summary.hidden, false);
    assert.equal(h.get('.task-summary-running').textContent, '2');
    assert.equal(h.get('.task-summary-completed').textContent, '✓ 3');
    assert.equal(h.get('.task-summary-attention').hidden, false);
    h.pointer(h.get('.voice-card'), 'pointerenter');
    summary.focus();
    assert.deepEqual(hover, []);
    assert.deepEqual(h.layouts, layouts);
    summary.click();
    await settled();
    assert.deepEqual(h.calls.at(-1), ['openSubagents']);
    h.update({ ...h.state(), connection: 'disconnected' });
    assert.equal(summary.disabled, true);
    assert.equal(summary.hidden, false);
    h.update({ ...h.state(), subagentsV1: undefined });
    assert.equal(summary.hidden, true);
  });

  it('localizes device fallback labels and rejected language saves without translating real names', async () => {
    const h = setup({
      listInputDevices: async () => [
        {
          deviceId: 'unnamed',
          label: liveMessage('host.device.fallback', { index: 1 }),
          selected: true,
        },
        { deviceId: 'named', label: 'Original Device 名称', selected: false },
      ],
      setLanguage: async () => {
        throw new Error(liveMessage('ui.modeUnavailable'));
      },
    });
    h.click('Settings');
    await settled();
    const select = h.get<HTMLSelectElement>(
      'select[aria-label="Audio Source"]',
    );
    const fallback = select.querySelector('option[value="unnamed"]')!;
    const named = select.querySelector('option[value="named"]')!;
    assert.equal(
      fallback.textContent,
      liveText('en', 'host.device.fallback', { index: 1 }),
    );
    const language = h.get<HTMLSelectElement>(
      'select[data-live-label="language.label"]',
    );
    language.value = 'zh-CN';
    language.dispatchEvent(new h.dom.window.Event('change', { bubbles: true }));
    await settled();
    assert.equal(language.value, 'en');
    assert.match(h.get('.settings-status').textContent ?? '', /unavailable/);
    h.update({ ...h.state(), language: 'zh-CN' });
    assert.equal(select.querySelector('option[value="unnamed"]'), fallback);
    assert.equal(
      fallback.textContent,
      liveText('zh-CN', 'host.device.fallback', { index: 1 }),
    );
    assert.equal(named.textContent, 'Original Device 名称');
    assert.equal(
      h.get('.settings-status').textContent,
      liveText('zh-CN', 'ui.modeUnavailable'),
    );
  });

  it('waits for native placement before showing Settings and cancels stale placement after Escape or disconnect', async () => {
    const pending: Array<() => void> = [];
    const h = setup({
      setSettingsOpen: (open) =>
        open
          ? new Promise<void>((resolve) => pending.push(resolve))
          : Promise.resolve(),
    });
    const trigger = h.get('[aria-label="Settings"]');
    h.click('Settings');
    assert.equal(h.get('.settings-layer').hidden, true);
    assert.equal(Boolean(h.get('.voice-surface').inert), false);
    pending.shift()?.();
    await settled();
    assert.equal(h.get('.settings-layer').hidden, false);
    assert.equal(
      document.activeElement,
      h.get('[aria-label="Close settings"]'),
    );
    h.click('Close settings');
    h.click('Settings');
    document.dispatchEvent(
      new h.dom.window.KeyboardEvent('keydown', {
        key: 'Escape',
        bubbles: true,
      }),
    );
    pending.shift()?.();
    await settled();
    assert.equal(h.get('.settings-layer').hidden, true);
    assert.equal(Boolean(h.get('.voice-surface').inert), false);
    assert.equal(document.activeElement, trigger);
    h.click('Settings');
    h.update({ ...h.state(), connection: 'disconnected' });
    pending.shift()?.();
    await settled();
    assert.equal(h.get('.settings-layer').hidden, true);
  });

  it('reports a failed Settings placement instead of revealing an unclamped panel', async () => {
    const h = setup({
      setSettingsOpen: async (open) => {
        if (open) throw new Error('Placement failed');
      },
    });
    h.click('Settings');
    await settled();
    assert.equal(h.get('.settings-layer').hidden, true);
    assert.equal(Boolean(h.get('.voice-surface').inert), false);
    assert.match(h.get('.voice-status').textContent ?? '', /Placement failed/);
  });

  it('reflects real microphone peaks in bars, releases smoothly and resets on mute without scaling the disc', (context) => {
    context.mock.timers.enable({ apis: ['setTimeout'] });
    const h = setup();
    h.update({ ...h.state(), live: { ...baseline.live, state: 'listening' } });
    const bar = h.get('.voice-wave i:nth-child(4)');
    const scale = () =>
      Number(bar.style.transform.match(/scaleY\(([^)]+)\)/)?.[1]);
    h.view.setInputLevel(0.05);
    const peak = scale();
    assert(peak > 0.8 && peak <= 1);
    assert.equal(h.get('.orb-core').style.transform, '');
    h.view.setInputLevel(0);
    assert(scale() > 0.3 && scale() < peak);
    for (let frame = 0; frame < 24; frame++) context.mock.timers.tick(32);
    assert.equal(scale(), 0.3);
    h.view.setInputLevel(0.1);
    h.update({ ...h.state(), live: { ...h.state().live, inputMuted: true } });
    assert.equal(bar.style.transform, '');
    h.view.setInputLevel(1);
    assert.equal(bar.style.transform, '');
  });

  it('drags the Settings title while excluding its Close button', async () => {
    const h = setup();
    h.click('Settings');
    await settled();
    h.calls.length = 0;
    const header = h.get('.settings-panel > header');
    h.pointer(header, 'pointerdown', 100, 100);
    h.pointer(header, 'pointermove', 130, 120);
    h.pointer(header, 'pointerup', 130, 120);
    assert.deepEqual(h.calls.splice(0), [
      ['drag', 'start', 100, 100],
      ['drag', 'move', 130, 120],
      ['drag', 'end', 130, 120],
    ]);
    const close = h.get('[aria-label="Close settings"]');
    h.pointer(close, 'pointerdown', 100, 100);
    h.pointer(close, 'pointermove', 130, 120);
    h.pointer(close, 'pointerup', 130, 120);
    assert.deepEqual(h.calls, []);
    close.click();
    assert.equal(h.get('.settings-layer').hidden, true);
  });

  it('confirms language through state while retaining Memory drafts, focus and nodes', async () => {
    const h = setup();
    h.click('Settings');
    await settled();
    const panel = h.get('.settings-panel');
    const orb = h.get('.voice-orb');
    const groups = Array.from(
      panel.querySelectorAll('.settings-group > .settings-field > strong'),
    );
    assert.equal(groups.at(-2)?.textContent, 'Language');
    const chinese = h.get<HTMLSelectElement>(
      'select[data-live-label="language.label"]',
    );
    chinese.value = 'zh-CN';
    chinese.dispatchEvent(new h.dom.window.Event('change', { bubbles: true }));
    await settled();
    assert.deepEqual(h.calls.at(-1), ['language', 'zh-CN']);
    assert.equal(chinese.value, 'en');
    const rename = Array.from(panel.querySelectorAll('button')).find(
      (button) => button.textContent === 'Rename',
    )!;
    h.get<HTMLDetailsElement>('.memory-settings').open = true;
    rename.click();
    const name = h.get<HTMLInputElement>('#memory-library-name');
    name.value = 'My Draft 原名';
    name.dispatchEvent(new h.dom.window.Event('input', { bubbles: true }));
    name.focus();
    h.update({ ...h.state(), language: 'zh-CN' });
    assert.equal(chinese.value, 'zh-CN');
    assert.equal(h.get('.settings-panel'), panel);
    assert.equal(h.get('.voice-orb'), orb);
    assert.equal(name.value, 'My Draft 原名');
    assert.equal(document.activeElement, name);
    assert.equal(h.get('#settings-title').textContent, '设置');
    assert.equal(h.get('[aria-label="记忆库"] option').textContent, 'Default');
    assert.equal(
      h.get<HTMLInputElement>('[aria-label="记忆整理模型"]').value,
      'qwen3.7-plus',
    );
  });

  it('compensates native frame offsets for the card, settings and setup without replacing nodes', () => {
    const h = setup();
    const orb = h.get('.voice-orb');
    const slot = h.get('[data-live-camera-preview]');
    h.update({ ...h.state(), overlayOffset: { x: 0, y: -20 } });
    assert.equal(
      h.get('.voice-surface').style.transform,
      'translate(0px, -20px)',
    );
    h.offset({ x: 0, y: -130 });
    h.update({ ...h.state(), overlayOffset: { x: 0, y: 0 } });
    assert.equal(
      h.get('.voice-surface').style.transform,
      'translate(0px, -130px)',
    );
    h.click('Settings');
    assert.equal(
      h.get('.settings-layer').style.transform,
      'translate(0px, -130px)',
    );
    assert.equal(h.app.style.transform, '');
    assert.equal(
      h.get('.setup-panel').style.transform,
      'translate(0px, -130px)',
    );
    h.offset({ x: 0, y: 0 });
    assert.equal(
      h.get('.voice-surface').style.transform,
      'translate(0px, 0px)',
    );
    assert.equal(h.get('.voice-orb'), orb);
    assert.equal(h.get('[data-live-camera-preview]'), slot);
  });

  it('orders peer source groups and describes only the acknowledged capture mode', async () => {
    const h = setup();
    h.click('Settings');
    await settled();
    assert.deepEqual(
      Array.from(
        h.app.querySelectorAll('.settings-group > .settings-field > strong'),
      ).map((element) => element.textContent),
      [
        'Microphone',
        'Video Source',
        'Display',
        'Capture Mode',
        'Language',
        'Appearance',
      ],
    );
    const description = h.get('.capture-mode-description');
    const original = description.textContent;
    assert.match(original ?? '', /On Demand/);
    assert.doesNotMatch(original ?? '', /Live Feed/);
    const feed = Array.from(h.app.querySelectorAll('button')).find(
      (element) => element.textContent === 'Live Feed',
    )!;
    feed.click();
    await settled();
    assert.equal(description.textContent, original);
    h.update({
      ...h.state(),
      visualInput: { ...baseline.visualInput!, mode: 'live-feed' },
    });
    assert.equal(h.get('.capture-mode-description'), description);
    assert.match(description.textContent ?? '', /Live Feed/);
    assert.doesNotMatch(description.textContent ?? '', /On Demand/);
  });

  it('toggles camera preview visibility without changing source or reattaching video', () => {
    const h = setup();
    h.update({
      ...h.state(),
      visualInput: { ...baseline.visualInput!, source: 'camera' },
    });
    const slot = h.get('[data-live-camera-preview]');
    const video = h.dom.window.document.createElement('video');
    slot.append(video);
    assert.equal(h.get('.camera-preview').hidden, false);
    h.click('Hide camera preview');
    assert.equal(h.get('.camera-preview').hidden, true);
    assert.equal(
      h.get<HTMLButtonElement>('[aria-label="Show camera preview"]').hidden,
      false,
    );
    h.update({
      ...h.state(),
      live: { ...h.state().live, caption: 'New text' },
    });
    assert.equal(h.get('.camera-preview').hidden, true);
    h.click('Show camera preview');
    assert.equal(h.get('.camera-preview').hidden, false);
    assert.equal(h.get('[data-live-camera-preview]'), slot);
    assert.equal(video.parentElement, slot);
    assert.deepEqual(
      h.calls.filter(([name]) =>
        ['source', 'mode', 'permission', 'stop', 'toggle'].includes(
          String(name),
        ),
      ),
      [],
    );
    assert.equal(h.calls.filter(([name]) => name === 'preview').length, 1);
    h.click('Hide camera preview');
    h.update({
      ...h.state(),
      visualInput: { ...baseline.visualInput!, source: 'screen' },
    });
    assert.equal(h.get('.preview-toggle').hidden, true);
    h.update({
      ...h.state(),
      visualInput: { ...baseline.visualInput!, source: 'camera' },
    });
    assert.equal(h.get('.camera-preview').hidden, false);
  });

  it('keeps the preview envelope during call stopping and ignores caption-only layout changes', () => {
    const h = setup();
    h.update({
      ...h.state(),
      visualInput: { ...baseline.visualInput!, source: 'camera' },
      live: { ...baseline.live, state: 'listening' },
    });
    h.update({
      ...h.state(),
      live: { ...h.state().live, outputMuted: true, caption: 'Caption' },
    });
    h.update({ ...h.state(), live: { ...h.state().live, state: 'stopping' } });
    h.update({ ...h.state(), live: baseline.live });
    assert.deepEqual(h.layouts, ['orb', 'orb-preview']);
    h.click('Hide camera preview');
    assert.equal(h.layouts.at(-1), 'orb');
  });

  it('preserves orb, controls, focus, input scale and preview slot across state updates', () => {
    const h = setup();
    const state = {
      ...h.state(),
      visualInput: { ...baseline.visualInput!, source: 'camera' as const },
      live: { ...baseline.live, state: 'listening' as const },
    };
    h.update(state);
    const orb = h.get('.voice-orb');
    const slot = h.get('[data-live-camera-preview]');
    const settings = h.get<HTMLButtonElement>('[aria-label="Settings"]');
    settings.focus();
    h.view.setInputLevel(1);
    h.update({ ...state, live: { ...state.live, caption: 'changed caption' } });
    h.update(state);
    assert.equal(h.get('.voice-orb'), orb);
    assert.equal(h.get('[data-live-camera-preview]'), slot);
    assert.equal(h.get('[aria-label="Settings"]'), settings);
    assert.equal(document.activeElement, settings);
    assert.equal(
      h.get('.voice-wave i:nth-child(4)').style.transform,
      'scaleY(1)',
    );
    assert.deepEqual(
      h.calls.filter(([name]) => name === 'preview'),
      [['preview']],
    );
  });

  it('keeps controls visible after pointer leave and permits call controls beside non-modal settings', async (context) => {
    context.mock.timers.enable({ apis: ['setTimeout'] });
    const h = setup();
    const toolbar = h.get('.voice-controls');
    h.pointer(h.get('.orb-dock'), 'pointerleave');
    context.mock.timers.tick(1500);
    assert.equal(toolbar.getAttribute('aria-hidden'), null);
    assert.equal(Boolean(toolbar.inert), false);
    h.click('Settings');
    await settled();
    assert.equal(h.get('.settings-layer').hidden, false);
    assert.equal(h.get('.settings-panel').getAttribute('aria-modal'), null);
    assert.equal(
      h.get('.settings-layer').hasAttribute('data-live-interactive'),
      false,
    );
    assert.equal(Boolean(h.get('.voice-surface').inert), false);
    const mic = h.get<HTMLButtonElement>('[aria-label="Mute microphone"]');
    h.pointer(mic, 'pointerdown');
    assert.equal(h.get('.settings-layer').hidden, false);
    mic.click();
    await settled();
    assert.equal(h.get('.settings-layer').hidden, true);
    assert.deepEqual(h.calls.slice(-2), [
      ['input', true],
      ['settings', false],
    ]);
  });

  it('retains memory drafts through updates and Esc/outside/native dismissal without replacing controls', async () => {
    const h = setup();
    const trigger = h.get('[aria-label="Settings"]');
    h.click('Settings');
    await settled();
    const rename = Array.from(h.app.querySelectorAll('button')).find(
      (item) => item.textContent === 'Rename',
    )!;
    h.get<HTMLDetailsElement>('.memory-settings').open = true;
    rename.click();
    const name = h.get<HTMLInputElement>('#memory-library-name');
    name.value = 'A draft';
    name.dispatchEvent(new h.dom.window.Event('input', { bubbles: true }));
    name.setSelectionRange(1, 4);
    h.update({
      ...h.state(),
      live: { ...baseline.live, state: 'speaking' },
      memory: { ...baseline.memory!, locked: true },
    });
    assert.equal(document.activeElement, name);
    assert.equal(name.selectionStart, 1);
    assert.equal(name.selectionEnd, 4);
    name.dispatchEvent(
      new h.dom.window.KeyboardEvent('keydown', {
        key: 'Escape',
        bubbles: true,
      }),
    );
    assert.equal(h.get('.settings-layer').hidden, true);
    assert.equal(trigger.isConnected, true);
    h.click('Settings');
    assert.equal(name.value, 'A draft');
    await settled();
    h.get('.voice-card').click();
    assert.equal(h.get('.settings-layer').hidden, true);
    h.click('Settings');
    await settled();
    h.dismiss();
    assert.equal(h.get('.settings-layer').hidden, true);
    assert.equal(h.get('[aria-label="Settings"]'), trigger);
  });

  it('separates End call and Quit while leaving the stopped orb mounted', async () => {
    const h = setup();
    const orb = h.get('.voice-orb');
    h.click('Start call');
    await settled();
    h.update({ ...h.state(), live: { ...baseline.live, state: 'listening' } });
    h.click('End call');
    await settled();
    h.update({ ...h.state(), live: baseline.live });
    assert.equal(h.get('.voice-surface').hidden, false);
    assert.equal(h.get('.voice-orb'), orb);
    assert.equal(orb.classList.contains('idle'), true);
    h.get<HTMLButtonElement>('.quit-control').click();
    await settled();
    assert.deepEqual(h.calls, [['toggle'], ['stop'], ['quit']]);
  });

  it('surfaces failed Quit and permits a retry without removing the orb', async () => {
    let attempts = 0;
    const h = setup({
      quit: async () => {
        attempts++;
        throw new Error('Shutdown was not confirmed');
      },
    });
    h.get<HTMLButtonElement>('.quit-control').click();
    await settled();
    assert.match(h.get('.voice-status').textContent ?? '', /Please retry Quit/);
    assert.equal(h.get<HTMLButtonElement>('.quit-control').disabled, false);
    h.get<HTMLButtonElement>('.quit-control').click();
    await settled();
    assert.equal(attempts, 2);
    assert.equal(h.get('.voice-surface').hidden, false);
  });

  it('drags both setup and orb using a threshold without starting a call', () => {
    const h = setup();
    for (const selector of ['.voice-header', '.setup-header']) {
      const element = h.get(selector);
      h.pointer(element, 'pointerdown', 100, 100);
      h.pointer(element, 'pointermove', 102, 102);
      assert.equal(h.calls.length, 0);
      h.pointer(element, 'pointermove', 125, 140);
      h.pointer(element, 'pointerup', 125, 140);
      element.click();
      assert.deepEqual(h.calls.splice(0), [
        ['drag', 'start', 100, 100],
        ['drag', 'move', 125, 140],
        ['drag', 'end', 125, 140],
      ]);
    }
  });

  it('keeps the orb and failure feedback for native tray Quit across disconnects', () => {
    const h = setup();
    h.update({ ...h.state(), quitState: 'pending' });
    assert.equal(h.get<HTMLButtonElement>('.quit-control').disabled, true);
    assert.match(h.get('.voice-status').textContent ?? '', /Quitting/);
    h.update({
      ...h.state(),
      connection: 'disconnected',
      live: { ...baseline.live, available: false, state: 'unavailable' },
    });
    assert.equal(h.get('.voice-surface').hidden, false);
    h.update({ ...h.state(), quitState: 'failed' });
    assert.equal(h.get('.voice-surface').hidden, false);
    assert.equal(h.get<HTMLButtonElement>('.quit-control').disabled, false);
    assert.match(h.get('.voice-status').textContent ?? '', /Please retry Quit/);
  });

  it('hides preview and disables stale call controls while Quit is pending or failed', () => {
    const h = setup();
    h.update({
      ...h.state(),
      live: { ...baseline.live, state: 'speaking' },
      visualInput: { ...baseline.visualInput!, source: 'camera' },
    });
    assert.equal(h.get('.camera-preview').hidden, false);
    h.update({ ...h.state(), quitState: 'pending' });
    assert.equal(h.get('.camera-preview').hidden, true);
    h.update({ ...h.state(), quitState: 'failed' });
    assert.equal(h.get('.camera-preview').hidden, true);
    assert.equal(h.get('.voice-orb').classList.contains('error'), true);
    assert.equal(
      h.get<HTMLButtonElement>('[aria-label="Mute microphone"]').disabled,
      true,
    );
    assert.equal(
      h.get<HTMLButtonElement>('[aria-label="End call"]').disabled,
      true,
    );
    assert.equal(h.get<HTMLButtonElement>('.quit-control').disabled, false);
  });

  it('shows Quit progress and failure ahead of an existing background permission prompt', () => {
    const h = setup();
    h.update({
      ...h.state(),
      live: {
        ...baseline.live,
        state: 'listening',
        pendingPermission: { workspaceId: 'work', sessionId: 'session' },
      },
    });
    assert.equal(h.get('.permission-link').hidden, false);
    for (const quitState of ['pending', 'failed'] as const) {
      h.update({ ...h.state(), quitState });
      assert.equal(h.get('.voice-status').hidden, false);
      assert.equal(h.get('.permission-link').hidden, true);
      assert.equal(h.get<HTMLButtonElement>('.permission-link').disabled, true);
      assert.match(
        h.get('.voice-status').textContent ?? '',
        quitState === 'pending' ? /Quitting/ : /retry Quit/,
      );
    }
  });

  it('uses the last valid drag position when pointer capture is cancelled', () => {
    const h = setup();
    const orb = h.get('.voice-header');
    h.pointer(orb, 'pointerdown', 200, 200);
    h.pointer(orb, 'pointermove', 225, 240);
    h.pointer(orb, 'lostpointercapture');
    h.pointer(orb, 'pointerup', 0, 0);
    assert.deepEqual(h.calls, [
      ['drag', 'start', 200, 200],
      ['drag', 'move', 225, 240],
      ['drag', 'end', 225, 240],
    ]);
  });

  it('allows mute preferences before a call and allows Quit during another pending action', async () => {
    let complete: () => void = () => {};
    const h = setup({
      setInputMuted: () =>
        new Promise<void>((resolve) => {
          complete = resolve;
        }),
    });
    assert.equal(
      h.get<HTMLButtonElement>('[aria-label="Mute microphone"]').disabled,
      false,
    );
    h.click('Mute microphone');
    h.get<HTMLButtonElement>('.quit-control').click();
    await settled();
    assert.deepEqual(h.calls, [['quit']]);
    complete();
    await settled();
  });

  it('requires only selected-source permissions during setup and omits everyday settings', async () => {
    const h = setup();
    const state: HostPublicState = {
      ...h.state(),
      live: { ...baseline.live, available: false, state: 'unavailable' },
      permissions: {
        microphone: 'granted',
        camera: 'not_determined',
        accessibility: 'denied',
        screenRecording: 'denied',
      },
      visualInput: { ...baseline.visualInput!, source: 'camera' },
    };
    h.update(state);
    const panel = h.get('.setup-panel');
    assert.equal(panel.hidden, false);
    assert.equal(h.get('[data-permission="camera"]').hidden, false);
    assert.equal(h.get('[data-permission="screenRecording"]').hidden, true);
    assert.equal(h.get('[data-permission="accessibility"]').hidden, true);
    assert.equal(panel.querySelector('.memory-settings'), null);
    assert.equal(panel.querySelector('[aria-label="Audio Source"]'), null);
    h.click('Allow camera');
    await settled();
    assert.deepEqual(h.calls, [['permission', 'camera']]);
  });

  it('preserves acknowledged device selection on rejection and reports the failure', async () => {
    const h = setup({
      setInputDevice: async () => {
        throw new Error('Device unavailable');
      },
    });
    h.click('Settings');
    await settled();
    const select = h.get<HTMLSelectElement>(
      'select[aria-label="Audio Source"]',
    );
    assert.equal(select.value, 'mic-1');
    select.value = 'mic-2';
    select.dispatchEvent(new h.dom.window.Event('change', { bubbles: true }));
    await settled();
    assert.equal(select.value, 'mic-1');
    assert.match(
      h.get('.settings-status').textContent ?? '',
      /Device unavailable/,
    );
    assert.equal(select.disabled, false);
  });
});
