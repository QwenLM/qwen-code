/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  normalizeBrowserPanelUrl,
  shouldOpenLinkInApp,
  type BrowserPanelApi,
  type BrowserPanelBounds,
  type BrowserPanelState,
} from '../shared/browser-panel';

const MIN_PANEL_WIDTH = 360;
const MIN_WEB_SHELL_WIDTH = 480;

interface PanelElements {
  address: HTMLInputElement;
  back: HTMLButtonElement;
  close: HTMLButtonElement;
  content: HTMLDivElement;
  external: HTMLButtonElement;
  forward: HTMLButtonElement;
  panel: HTMLElement;
  reload: HTMLButtonElement;
  resize: HTMLDivElement;
}

interface Labels {
  address: string;
  back: string;
  close: string;
  external: string;
  forward: string;
  reload: string;
  title: string;
}

export function installBrowserPanel(
  api: BrowserPanelApi,
  platform: NodeJS.Platform,
): () => void {
  let elements: PanelElements | undefined;
  let panelWidth = initialPanelWidth();
  let state: BrowserPanelState = {
    url: '',
    loading: false,
    canGoBack: false,
    canGoForward: false,
  };
  let boundsObserver: ResizeObserver | undefined;

  const ignoreFailure = (): void => undefined;

  const syncBounds = (): void => {
    if (!elements || elements.panel.hidden) return;
    const bounds = elementBounds(elements.content);
    if (bounds) api.setBounds(bounds);
  };

  const closePanel = (): void => {
    if (!elements) return;
    elements.panel.hidden = true;
    void api.close().catch(ignoreFailure);
  };

  const updateState = (nextState: BrowserPanelState): void => {
    state = nextState;
    if (!elements) return;
    elements.back.disabled = !state.canGoBack;
    elements.forward.disabled = !state.canGoForward;
    elements.reload.textContent = state.loading ? '…' : '↻';
    if (state.url) elements.address.value = state.url;
  };

  const ensurePanel = (): PanelElements => {
    if (elements?.panel.isConnected) return elements;
    boundsObserver?.disconnect();
    const sidebar = document.querySelector<HTMLElement>(
      '[data-web-shell-root] [data-sidebar-shell]',
    );
    const shell = sidebar?.parentElement;
    if (!shell) throw new Error('Web Shell panel host is unavailable.');
    elements = createPanel(labelsFor(document.documentElement.lang));
    elements.panel.style.setProperty(
      '--qwen-desktop-browser-width',
      `${panelWidth}px`,
    );
    shell.append(elements.panel);
    bindPanelEvents(elements);
    if (typeof ResizeObserver !== 'undefined') {
      boundsObserver = new ResizeObserver(syncBounds);
      boundsObserver.observe(elements.content);
    }
    updateState(state);
    return elements;
  };

  const openPanel = (rawUrl: string): void => {
    const url = normalizeBrowserPanelUrl(rawUrl);
    if (!url) return;
    try {
      const panel = ensurePanel();
      panel.panel.hidden = false;
      panel.address.value = url;
      requestAnimationFrame(() => {
        const bounds = elementBounds(panel.content);
        if (!bounds) return;
        void api.open(url, bounds).catch(ignoreFailure);
      });
    } catch {
      return;
    }
  };

  const bindPanelEvents = (panel: PanelElements): void => {
    panel.back.addEventListener('click', () => {
      void api.goBack().catch(ignoreFailure);
    });
    panel.forward.addEventListener('click', () => {
      void api.goForward().catch(ignoreFailure);
    });
    panel.reload.addEventListener('click', () => {
      void api.reload().catch(ignoreFailure);
    });
    panel.close.addEventListener('click', closePanel);
    panel.external.addEventListener('click', () => {
      const url = normalizeBrowserPanelUrl(state.url || panel.address.value);
      if (url) void api.openExternal(url).catch(ignoreFailure);
    });
    panel.address.form?.addEventListener('submit', (event) => {
      event.preventDefault();
      const url = normalizeBrowserPanelUrl(panel.address.value);
      if (url) void api.navigate(url).catch(ignoreFailure);
    });
    panel.resize.addEventListener('pointerdown', (event) => {
      event.preventDefault();
      const startX = event.clientX;
      const startWidth = panelWidth;
      const previousCursor = document.body.style.cursor;
      const previousSelect = document.body.style.userSelect;
      document.body.style.cursor = 'col-resize';
      document.body.style.userSelect = 'none';
      const move = (moveEvent: PointerEvent): void => {
        const maxWidth = Math.max(
          MIN_PANEL_WIDTH,
          window.innerWidth - MIN_WEB_SHELL_WIDTH,
        );
        panelWidth = Math.max(
          MIN_PANEL_WIDTH,
          Math.min(maxWidth, startWidth + startX - moveEvent.clientX),
        );
        panel.panel.style.setProperty(
          '--qwen-desktop-browser-width',
          `${panelWidth}px`,
        );
        syncBounds();
      };
      const stop = (): void => {
        window.removeEventListener('pointermove', move);
        window.removeEventListener('pointerup', stop);
        window.removeEventListener('pointercancel', stop);
        document.body.style.cursor = previousCursor;
        document.body.style.userSelect = previousSelect;
      };
      window.addEventListener('pointermove', move);
      window.addEventListener('pointerup', stop);
      window.addEventListener('pointercancel', stop);
    });
  };

  const handleLinkClick = (event: MouseEvent): void => {
    const anchor = anchorFromEvent(event);
    if (
      !anchor ||
      !shouldOpenLinkInApp({
        button: event.button,
        ctrlKey: event.ctrlKey,
        metaKey: event.metaKey,
        pageUrl: window.location.href,
        platform,
        url: anchor.href,
      })
    ) {
      return;
    }
    event.preventDefault();
    event.stopImmediatePropagation();
    openPanel(anchor.href);
  };

  const stopStateUpdates = api.onStateChanged(updateState);
  document.addEventListener('click', handleLinkClick, true);
  window.addEventListener('resize', syncBounds);
  return () => {
    stopStateUpdates();
    boundsObserver?.disconnect();
    document.removeEventListener('click', handleLinkClick, true);
    window.removeEventListener('resize', syncBounds);
    elements?.panel.remove();
  };
}

function createPanel(labels: Labels): PanelElements {
  const panel = document.createElement('section');
  panel.dataset['qwenDesktopBrowserPanel'] = '';
  panel.hidden = true;
  panel.setAttribute('aria-label', labels.title);

  const resize = document.createElement('div');
  resize.dataset['qwenDesktopBrowserResize'] = '';
  resize.setAttribute('role', 'separator');
  resize.setAttribute('aria-orientation', 'vertical');
  resize.setAttribute('aria-label', labels.title);

  const surface = document.createElement('div');
  surface.dataset['qwenDesktopBrowserSurface'] = '';
  const toolbar = document.createElement('div');
  toolbar.dataset['qwenDesktopBrowserToolbar'] = '';
  const back = createButton(labels.back, '←');
  const forward = createButton(labels.forward, '→');
  const reload = createButton(labels.reload, '↻');
  const external = createButton(labels.external, '↗');
  const close = createButton(labels.close, '×');
  const form = document.createElement('form');
  form.dataset['qwenDesktopBrowserAddressForm'] = '';
  const address = document.createElement('input');
  address.dataset['qwenDesktopBrowserAddress'] = '';
  address.type = 'url';
  address.spellcheck = false;
  address.setAttribute('aria-label', labels.address);
  form.append(address);
  toolbar.append(back, forward, reload, form, external, close);
  const content = document.createElement('div');
  content.dataset['qwenDesktopBrowserContent'] = '';
  surface.append(toolbar, content);
  panel.append(resize, surface);
  return {
    address,
    back,
    close,
    content,
    external,
    forward,
    panel,
    reload,
    resize,
  };
}

function createButton(label: string, glyph: string): HTMLButtonElement {
  const button = document.createElement('button');
  button.type = 'button';
  button.textContent = glyph;
  button.title = label;
  button.setAttribute('aria-label', label);
  return button;
}

function anchorFromEvent(event: MouseEvent): HTMLAnchorElement | undefined {
  for (const node of event.composedPath()) {
    if (node instanceof HTMLAnchorElement) return node;
    if (node instanceof Element) {
      const anchor = node.closest<HTMLAnchorElement>('a[href]');
      if (anchor) return anchor;
    }
  }
  return undefined;
}

function elementBounds(element: HTMLElement): BrowserPanelBounds | undefined {
  const rect = element.getBoundingClientRect();
  if (rect.width <= 0 || rect.height <= 0) return undefined;
  return {
    x: Math.round(rect.x),
    y: Math.round(rect.y),
    width: Math.round(rect.width),
    height: Math.round(rect.height),
  };
}

function initialPanelWidth(): number {
  return Math.max(MIN_PANEL_WIDTH, Math.min(520, window.innerWidth * 0.45));
}

function labelsFor(language: string): Labels {
  if (language.toLowerCase().startsWith('zh')) {
    return {
      address: '地址',
      back: '后退',
      close: '关闭浏览器',
      external: '在默认浏览器中打开',
      forward: '前进',
      reload: '刷新',
      title: '浏览器',
    };
  }
  return {
    address: 'Address',
    back: 'Back',
    close: 'Close browser',
    external: 'Open in default browser',
    forward: 'Forward',
    reload: 'Reload',
    title: 'Browser',
  };
}
