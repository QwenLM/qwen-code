/* global document, Element, HTMLAnchorElement, navigator, requestAnimationFrame, ResizeObserver, URL, window */

(() => {
  const tauri = window.__TAURI__;
  if (!tauri?.core?.invoke) return;

  const MIN_PANEL_WIDTH = 360;
  const MIN_WEB_SHELL_WIDTH = 480;
  const STATE_EVENT = 'qwen-desktop-browser-state';
  let elements;
  let panelWidth = Math.max(
    MIN_PANEL_WIDTH,
    Math.min(520, window.innerWidth * 0.45),
  );
  let state = {
    url: '',
    loading: false,
    canGoBack: false,
    canGoForward: false,
  };
  let boundsObserver;

  const invoke = (command, args = {}) => tauri.core.invoke(command, args);
  const ignoreFailure = () => undefined;

  const normalizeUrl = (raw) => {
    if (typeof raw !== 'string') return undefined;
    try {
      const url = new URL(raw.trim());
      return url.protocol === 'http:' || url.protocol === 'https:'
        ? url.href
        : undefined;
    } catch {
      return undefined;
    }
  };

  const elementBounds = (element) => {
    const rect = element.getBoundingClientRect();
    if (rect.width <= 0 || rect.height <= 0) return undefined;
    return {
      x: Math.round(rect.x),
      y: Math.round(rect.y),
      width: Math.round(rect.width),
      height: Math.round(rect.height),
    };
  };

  const syncBounds = () => {
    if (!elements || elements.panel.hidden) return;
    const bounds = elementBounds(elements.content);
    if (bounds) {
      void invoke('browser_panel_set_bounds', { bounds }).catch(ignoreFailure);
    }
  };

  const updateState = (nextState) => {
    state = nextState;
    if (!elements) return;
    elements.back.disabled = !state.canGoBack;
    elements.forward.disabled = !state.canGoForward;
    elements.reload.textContent = state.loading ? '…' : '↻';
    if (state.url) elements.address.value = state.url;
  };

  const createButton = (label, glyph) => {
    const button = document.createElement('button');
    button.type = 'button';
    button.textContent = glyph;
    button.title = label;
    button.setAttribute('aria-label', label);
    return button;
  };

  const labelsFor = () => {
    if (document.documentElement.lang.toLowerCase().startsWith('zh')) {
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
  };

  const closePanel = () => {
    if (!elements) return;
    elements.panel.hidden = true;
    void invoke('browser_panel_close').catch(ignoreFailure);
  };

  const bindPanelEvents = (panel) => {
    panel.back.addEventListener('click', () => {
      void invoke('browser_panel_go_back').catch(ignoreFailure);
    });
    panel.forward.addEventListener('click', () => {
      void invoke('browser_panel_go_forward').catch(ignoreFailure);
    });
    panel.reload.addEventListener('click', () => {
      void invoke('browser_panel_reload').catch(ignoreFailure);
    });
    panel.close.addEventListener('click', closePanel);
    panel.external.addEventListener('click', () => {
      const url = normalizeUrl(state.url || panel.address.value);
      if (url) {
        void invoke('browser_panel_open_external', { url }).catch(
          ignoreFailure,
        );
      }
    });
    panel.address.form?.addEventListener('submit', (event) => {
      event.preventDefault();
      const url = normalizeUrl(panel.address.value);
      if (url) {
        void invoke('browser_panel_navigate', { url }).catch(ignoreFailure);
      }
    });
    panel.resize.addEventListener('pointerdown', (event) => {
      event.preventDefault();
      const startX = event.clientX;
      const startWidth = panelWidth;
      const previousCursor = document.body.style.cursor;
      const previousSelect = document.body.style.userSelect;
      document.body.style.cursor = 'col-resize';
      document.body.style.userSelect = 'none';
      const move = (moveEvent) => {
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
      const stop = () => {
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

  const createPanel = () => {
    const labels = labelsFor();
    const panel = document.createElement('section');
    panel.dataset.qwenDesktopBrowserPanel = '';
    panel.hidden = true;
    panel.setAttribute('aria-label', labels.title);

    const resize = document.createElement('div');
    resize.dataset.qwenDesktopBrowserResize = '';
    resize.setAttribute('role', 'separator');
    resize.setAttribute('aria-orientation', 'vertical');
    resize.setAttribute('aria-label', labels.title);

    const surface = document.createElement('div');
    surface.dataset.qwenDesktopBrowserSurface = '';
    const toolbar = document.createElement('div');
    toolbar.dataset.qwenDesktopBrowserToolbar = '';
    const back = createButton(labels.back, '←');
    const forward = createButton(labels.forward, '→');
    const reload = createButton(labels.reload, '↻');
    const external = createButton(labels.external, '↗');
    const close = createButton(labels.close, '×');
    const form = document.createElement('form');
    form.dataset.qwenDesktopBrowserAddressForm = '';
    const address = document.createElement('input');
    address.dataset.qwenDesktopBrowserAddress = '';
    address.type = 'url';
    address.spellcheck = false;
    address.setAttribute('aria-label', labels.address);
    form.append(address);
    toolbar.append(back, forward, reload, form, external, close);
    const content = document.createElement('div');
    content.dataset.qwenDesktopBrowserContent = '';
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
  };

  const ensurePanel = () => {
    if (elements?.panel.isConnected) return elements;
    boundsObserver?.disconnect();
    const sidebar = document.querySelector(
      '[data-web-shell-root] [data-sidebar-shell]',
    );
    const shell = sidebar?.parentElement;
    if (!shell) throw new Error('Web Shell panel host is unavailable.');
    elements = createPanel();
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

  const openPanel = (rawUrl) => {
    const url = normalizeUrl(rawUrl);
    if (!url) return;
    let panel;
    try {
      panel = ensurePanel();
    } catch {
      return;
    }
    panel.panel.hidden = false;
    panel.address.value = url;
    requestAnimationFrame(() => {
      const bounds = elementBounds(panel.content);
      if (!bounds) return;
      void invoke('browser_panel_open', { url, bounds }).catch(() => {
        panel.panel.hidden = true;
      });
    });
  };

  const anchorFromEvent = (event) => {
    for (const node of event.composedPath()) {
      if (node instanceof HTMLAnchorElement) return node;
      if (node instanceof Element) {
        const anchor = node.closest('a[href]');
        if (anchor) return anchor;
      }
    }
    return undefined;
  };

  const shouldOpenInApp = (event, anchor) => {
    if (event.button !== 0) return false;
    const isMac = /Mac|iPhone|iPad|iPod/.test(navigator.platform);
    if (isMac ? !event.metaKey : !event.ctrlKey) return false;
    const url = normalizeUrl(anchor.href);
    if (!url) return false;
    try {
      return new URL(url).origin !== window.location.origin;
    } catch {
      return false;
    }
  };

  document.addEventListener(
    'click',
    (event) => {
      const anchor = anchorFromEvent(event);
      if (!anchor || !shouldOpenInApp(event, anchor)) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      openPanel(anchor.href);
    },
    true,
  );
  window.addEventListener(STATE_EVENT, (event) => {
    if (event.detail && typeof event.detail === 'object') {
      updateState(event.detail);
    }
  });
  window.addEventListener('resize', syncBounds);

  const style = document.createElement('style');
  style.dataset.qwenDesktopBrowserStyle = '';
  style.textContent = `
    [data-qwen-desktop-browser-panel] {
      background: var(--background, #fff);
      color: var(--foreground, #111);
      display: flex;
      flex: 0 0 var(--qwen-desktop-browser-width, 520px);
      height: 100%;
      min-height: 0;
      min-width: 0;
      width: var(--qwen-desktop-browser-width, 520px);
    }
    [data-qwen-desktop-browser-panel][hidden] { display: none; }
    [data-qwen-desktop-browser-resize] {
      cursor: col-resize;
      flex: 0 0 8px;
      position: relative;
      touch-action: none;
      width: 8px;
      z-index: 2;
    }
    [data-qwen-desktop-browser-resize]::after {
      background: var(--border, #d4d4d4);
      content: '';
      inset: 0 3px;
      position: absolute;
    }
    [data-qwen-desktop-browser-surface] {
      border-left: 1px solid var(--border, #d4d4d4);
      display: flex;
      flex: 1 1 auto;
      flex-direction: column;
      min-height: 0;
      min-width: 0;
      overflow: hidden;
    }
    [data-qwen-desktop-browser-toolbar] {
      align-items: center;
      background: var(--sidebar-background, var(--background, #fff));
      border-bottom: 1px solid var(--border, #d4d4d4);
      display: flex;
      flex: 0 0 42px;
      gap: 4px;
      min-width: 0;
      padding: 5px 7px;
    }
    [data-qwen-desktop-browser-toolbar] button {
      align-items: center;
      background: transparent;
      border: 0;
      border-radius: 6px;
      color: inherit;
      cursor: pointer;
      display: inline-flex;
      font: inherit;
      height: 30px;
      justify-content: center;
      padding: 0;
      width: 30px;
    }
    [data-qwen-desktop-browser-toolbar] button:hover:not(:disabled) {
      background: var(--accent, rgba(127, 127, 127, 0.16));
    }
    [data-qwen-desktop-browser-toolbar] button:disabled {
      cursor: default;
      opacity: 0.35;
    }
    [data-qwen-desktop-browser-address-form] {
      flex: 1 1 auto;
      min-width: 0;
    }
    [data-qwen-desktop-browser-address] {
      background: var(--background, #fff);
      border: 1px solid var(--border, #d4d4d4);
      border-radius: 6px;
      color: inherit;
      font: inherit;
      height: 30px;
      min-width: 0;
      outline: none;
      padding: 0 9px;
      width: 100%;
    }
    [data-qwen-desktop-browser-address]:focus {
      border-color: var(--ring, #737373);
    }
    [data-qwen-desktop-browser-content] {
      background: #fff;
      flex: 1 1 auto;
      min-height: 0;
      min-width: 0;
      position: relative;
    }
  `;
  const styleRoot = document.head || document.documentElement;
  if (styleRoot) {
    styleRoot.append(style);
  } else {
    document.addEventListener(
      'DOMContentLoaded',
      () => (document.head || document.documentElement)?.append(style),
      { once: true },
    );
  }
})();
