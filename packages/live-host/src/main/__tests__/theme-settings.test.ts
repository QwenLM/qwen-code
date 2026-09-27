import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { afterEach, describe, it } from 'node:test';
import { JSDOM } from 'jsdom';
import { liveMessage, liveText } from '@qwen-code/qwen-live/i18n';
import { LiveView } from '../../renderer/live-view.ts';
import { SubagentsView } from '../../renderer/subagents-view.ts';
import { applyTheme } from '../../renderer/theme.ts';
import type { HostPublicState, LiveHostApi } from '../../shared/host-api.ts';
import type { SubagentsWindowState } from '../../shared/subagents-api.ts';
import type { LiveTheme } from '../../shared/theme.ts';

const cleanup: Array<() => void> = [];
afterEach(() => {
  for (const dispose of cleanup.splice(0).reverse()) dispose();
});
const settled = () => new Promise<void>((resolve) => setImmediate(resolve));

function documentRoot() {
  const dom = new JSDOM('<!doctype html><main id="app"></main>');
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
  return {
    dom,
    app: dom.window.document.querySelector<HTMLElement>('#app')!,
  };
}

function host(overrides: Partial<LiveHostApi> = {}) {
  const { dom, app } = documentRoot();
  const state: HostPublicState = {
    language: 'en',
    connection: 'ready',
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
      source: 'camera',
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
  const themes: LiveTheme[] = [];
  let previews = 0;
  const api: LiveHostApi = {
    toggle: async () => {},
    stop: async () => {},
    quit: async () => {},
    newConversation: async () => {},
    setInputMuted: async () => {},
    setOutputMuted: async () => {},
    setVisualSource: async () => {},
    setVisualMode: async () => {},
    setScreenDisplay: async () => {},
    memoryAction: async () => {
      throw new Error('Theme updates must not change memory');
    },
    setLanguage: async () => {
      throw new Error('Theme updates must not change language');
    },
    setTheme: async (theme) => {
      themes.push(theme);
    },
    setSettingsOpen: async () => {},
    openConfig: async () => {},
    setOverlayLayout: () => {},
    onSettingsDismiss: () => () => {},
    onOverlayOffset: () => () => {},
    dragOverlay: () => {},
    attachCameraPreview: () => {
      previews++;
    },
    requestPermission: async () => {},
    listInputDevices: async () => [],
    setInputDevice: async () => {},
    openWebShellForPermission: async () => {},
    getState: async () => state,
    onInputLevel: () => () => {},
    onState: () => () => {},
    ...overrides,
  };
  const view = new LiveView(app, api);
  cleanup.push(() => view.dispose());
  view.update(state);
  const get = <T extends HTMLElement = HTMLElement>(selector: string): T => {
    const node = app.querySelector<T>(selector);
    assert(node, `Missing ${selector}`);
    return node;
  };
  const update = (next: Partial<HostPublicState>) => {
    Object.assign(state, next);
    view.update({ ...state });
  };
  return { dom, app, get, update, themes, previews: () => previews };
}

describe('Live Host theme settings', () => {
  it('offers a persistent display choice without changing Camera or init and retains unavailable selections', async () => {
    const selections: string[] = [];
    const h = host({
      setScreenDisplay: async (id) => {
        selections.push(id);
      },
    });
    const id = '11223344-5566-7788-99aa-bbccddeeff00';
    const settings = {
      source: 'screen',
      mode: 'live-feed',
      fps: 1,
      liveWidth: 1280,
      liveHeight: 720,
      screenDisplayId: 'primary',
    } as const;
    h.update({
      visualInput: settings,
      canSelectScreenDisplay: true,
      screenDisplays: [
        {
          id,
          name: 'Studio Display',
          width: 5120,
          height: 2880,
          primary: true,
        },
      ],
    });
    h.get<HTMLButtonElement>('.settings-control').click();
    await settled();
    const display = h.get<HTMLSelectElement>('select[aria-label="Display"]');
    assert.equal(display.value, 'primary');
    assert.equal(display.options[0]?.textContent, 'Primary display');
    assert.match(display.options[1]?.textContent ?? '', /Studio Display.*5120/);
    display.value = id;
    display.dispatchEvent(new h.dom.window.Event('change', { bubbles: true }));
    await settled();
    assert.deepEqual(selections, [id]);
    assert.equal(display.value, 'primary');
    h.update({
      visualInput: { ...settings, screenDisplayId: id },
      language: 'zh-CN',
    });
    assert.equal(display.value, id);
    assert.equal(display.getAttribute('aria-label'), '显示器');
    h.update({ screenDisplays: [] });
    h.update({ visualSettingsError: liveMessage('runtime.displaySaveFailed') });
    assert.match(
      h.get('.settings-status').textContent ?? '',
      /无法保存显示器选择/,
    );
    assert.equal(display.value, id);
    assert.match(display.selectedOptions[0]?.textContent ?? '', /不可用/);
    h.update({ visualInput: { ...settings, source: 'camera' } });
    assert.equal(display.closest<HTMLElement>('.settings-field')?.hidden, true);
  });

  it('places Theme after Language, defaults to System and sends each preference', async () => {
    const h = host();
    h.get<HTMLButtonElement>('.settings-control').click();
    await settled();
    const fields = h.app.querySelectorAll('.settings-body > .settings-field');
    assert.equal(
      fields[fields.length - 2]?.firstChild?.textContent,
      'Language',
    );
    assert.equal(fields[fields.length - 1]?.firstChild?.textContent, 'Theme');
    assert.equal(
      h.get('[data-theme="system"]').getAttribute('aria-pressed'),
      'true',
    );
    for (const theme of ['light', 'dark', 'system'] as const) {
      h.get<HTMLButtonElement>(`[data-theme="${theme}"]`).click();
      await settled();
    }
    assert.deepEqual(h.themes, ['light', 'dark', 'system']);
    assert.equal(
      h.get('[data-theme="system"]').getAttribute('aria-pressed'),
      'true',
    );
    assert.equal(h.dom.window.document.documentElement.dataset.theme, 'dark');
    h.update({ theme: 'system', resolvedTheme: 'light', language: 'zh-CN' });
    assert.equal(h.get('[data-theme="system"]').textContent, '跟随系统');
    assert.equal(h.get('[data-theme="light"]').textContent, '白天模式');
    assert.equal(h.get('[data-theme="dark"]').textContent, '黑暗模式');
    assert.equal(
      h.get('[data-theme="system"]').getAttribute('aria-pressed'),
      'true',
    );
    assert.equal(h.get('[data-language="en"]').textContent, 'English');
    assert.equal(h.get('[data-language="zh-CN"]').textContent, '简体中文');
  });

  it('keeps the saved preference selected when saving fails and restores controls', async () => {
    const h = host({
      setTheme: async () => {
        throw new Error(liveMessage('host.theme.saveFailed'));
      },
    });
    h.update({ theme: 'dark', resolvedTheme: 'dark', language: 'zh-CN' });
    h.get<HTMLButtonElement>('.settings-control').click();
    await settled();
    const light = h.get<HTMLButtonElement>('[data-theme="light"]');
    light.click();
    assert.equal(light.disabled, true);
    await settled();
    assert.equal(light.disabled, false);
    assert.equal(
      h.get('[data-theme="dark"]').getAttribute('aria-pressed'),
      'true',
    );
    assert.equal(
      h.get('.settings-status.error').textContent,
      liveText('zh-CN', 'host.theme.saveFailed'),
    );
    assert.equal(h.dom.window.document.documentElement.dataset.theme, 'dark');
  });

  it('applies the same resolved appearance to every surface without replacing media or task nodes', () => {
    const h = host();
    const orb = h.get('.voice-orb');
    const slot = h.get('.camera-preview-slot');
    const video = h.dom.window.document.createElement('video');
    slot.append(video);
    const model = h.get<HTMLInputElement>('.memory-model-form input');
    model.value = 'Keep my model draft';
    model.dispatchEvent(new h.dom.window.Event('input', { bubbles: true }));
    const { dom, app } = documentRoot();
    const view = new SubagentsView(app, {
      getState: async () => ({ language: 'en', connected: true, mode: 'list' }),
      onState: () => () => {},
      setHover: () => {},
      back: async () => {},
      expand: async () => {},
      close: () => {},
      openDetail: async () => {},
      control: async () => ({ type: 'error', code: 'unsupported' }),
    });
    cleanup.push(() => view.dispose());
    for (const mode of ['summary', 'list', 'detail'] as const) {
      for (const resolvedTheme of ['light', 'dark'] as const) {
        h.update({ theme: 'system', resolvedTheme });
        const state: SubagentsWindowState = {
          language: 'en',
          connected: true,
          mode,
          theme: 'system',
          resolvedTheme,
          selectedId: 'theme-task',
          snapshot: {
            revision: 1,
            counts: {
              running: 1,
              completed: 0,
              needsAttention: 0,
              failed: 0,
              cancelled: 0,
              interrupted: 0,
            },
            omitted: 0,
            tasks: [
              {
                id: 'theme-task',
                kind: 'harness',
                title: 'Keep task nodes',
                status: 'running',
                createdAt: 1,
                updatedAt: 1,
                request: 'Original request',
                output: 'Original output',
                activity: 'Still running',
                events: [],
              },
            ],
          },
        };
        view.update(state);
        const children = Array.from(app.children);
        const task = app.querySelector('.subagent-task');
        const output = app.querySelector('.subagent-output');
        view.update({
          ...state,
          resolvedTheme: resolvedTheme === 'light' ? 'dark' : 'light',
        });
        view.update(state);
        assert.equal(
          dom.window.document.documentElement.dataset.theme,
          resolvedTheme,
        );
        assert.equal(
          h.dom.window.document.documentElement.dataset.theme,
          resolvedTheme,
        );
        assert.deepEqual(Array.from(app.children), children);
        assert.equal(app.querySelector('.subagent-task'), task);
        assert.equal(app.querySelector('.subagent-output'), output);
        assert.equal(h.get('.voice-orb'), orb);
        assert.equal(h.get('.camera-preview-slot').firstChild, video);
        assert.equal(model.value, 'Keep my model draft');
        assert.equal(h.get('.memory-model-form input'), model);
      }
    }
    assert.equal(h.previews(), 1);
  });

  it('does not mutate the document for an unchanged appearance', () => {
    const { dom } = documentRoot();
    const document = dom.window.document;
    applyTheme(document);
    const observer = new dom.window.MutationObserver(() => {});
    observer.observe(document.documentElement, { attributes: true });
    applyTheme(document, 'dark');
    assert.equal(observer.takeRecords().length, 0);
    applyTheme(document, 'light');
    assert.equal(observer.takeRecords().length, 1);
    observer.disconnect();
  });
});

describe('shared theme palette', () => {
  const read = (file: string) =>
    readFileSync(new URL(`../../renderer/${file}`, import.meta.url), 'utf8');
  const theme = read('theme.css');
  const tokens = (body: string) =>
    Object.fromEntries(
      Array.from(body.matchAll(/(--live-[\w-]+):\s*([^;]+);/g), (match) => [
        match[1]!,
        match[2]!,
      ]),
    );
  const dark = tokens(theme.match(/:root\s*\{([^}]+)\}/)![1]!);
  const light = tokens(
    theme.match(/:root\[data-theme='light'\]\s*\{([^}]+)\}/)![1]!,
  );

  it('defines both appearances for every semantic token and leaves literal colors only in the brand orb', () => {
    assert.deepEqual(Object.keys(dark).sort(), Object.keys(light).sort());
    for (const name of ['style.css', 'subagents.css']) {
      const css = read(name);
      assert.match(css, /@import '\.\/theme\.css'/);
      for (const match of css.matchAll(/var\((--live-[\w-]+)/g))
        assert(match[1]! in dark, `Undefined ${match[1]}`);
      const surfaceRules = css.replace(/[^{}]+\{[^{}]+\}/g, (rule) =>
        rule.split('{')[0]!.includes('orb-core') ? '' : rule,
      );
      assert.doesNotMatch(surfaceRules, /#[\da-f]{3,8}\b|rgba?\(/i);
    }
    assert.match(
      read('style.css'),
      /linear-gradient\(145deg, #8bd7ed, #8671ce 72%, #b982d4\)/,
    );
    assert.match(dark['--live-status-bg']!, /\/ 68%\)/);
    assert.match(light['--live-status-bg']!, /\/ 96%\)/);
  });

  it('keeps light text, errors, statuses and primary buttons readable', () => {
    const rgb = (hex: string) =>
      hex
        .replace('#', '')
        .match(/../g)!
        .map((v) => parseInt(v, 16));
    const luminance = (color: number[]) =>
      color
        .map((v) => v / 255)
        .map((v) => (v <= 0.04045 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4))
        .reduce(
          (sum, value, i) => sum + value * [0.2126, 0.7152, 0.0722][i]!,
          0,
        );
    const contrast = (fg: number[], bg: number[]) => {
      const [a, b] = [luminance(fg), luminance(bg)].sort((a, b) => b - a);
      return (a! + 0.05) / (b! + 0.05);
    };
    for (const color of [
      'text',
      'muted',
      'subtle',
      'error',
      'success',
      'warning',
    ]) {
      assert(
        contrast(
          rgb(light[`--live-${color}`]!),
          rgb(light['--live-surface']!),
        ) >= 4.5,
        color,
      );
    }
    for (const desktop of [0, 255]) {
      const background = [249, 250, 255].map((v) => v * 0.96 + desktop * 0.04);
      assert(contrast(rgb(light['--live-text']!), background) >= 4.5);
      assert(contrast(rgb(light['--live-error']!), background) >= 4.5);
    }
    assert(contrast([255, 255, 255], rgb(light['--live-primary-bg']!)) >= 4.5);
  });
});
