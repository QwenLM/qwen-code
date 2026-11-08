// @vitest-environment jsdom
import { describe, expect, it, vi } from 'vitest';
import {
  isPluginShadowPanel,
  installWebShellShadowStyles,
  resolveWebShellShadowDom,
} from './shadowDom';

describe('isPluginShadowPanel', () => {
  it.each(['plugins', 'extensions', 'mcp', 'skills', 'agents', 'channels'])(
    'includes the %s management surface',
    (panel) => {
      expect(isPluginShadowPanel(panel)).toBe(true);
    },
  );

  it.each([null, 'settings', 'status', 'sessions'])(
    'excludes the %s non-plugin surface',
    (panel) => {
      expect(isPluginShadowPanel(panel)).toBe(false);
    },
  );
});

describe('resolveWebShellShadowDom', () => {
  it('keeps Shadow DOM disabled by default', () => {
    expect(resolveWebShellShadowDom(undefined)).toEqual({
      plugins: false,
      portals: false,
      styles: undefined,
    });
  });

  it('enables both scenes for the boolean shorthand', () => {
    expect(resolveWebShellShadowDom(true)).toEqual({
      plugins: true,
      portals: true,
    });
  });

  it('resolves plugin and portal scenes independently', () => {
    expect(
      resolveWebShellShadowDom({
        plugins: true,
        portals: false,
        styles: '.custom {}',
      }),
    ).toEqual({
      plugins: true,
      portals: false,
      styles: '.custom {}',
    });
  });
});

describe('installWebShellShadowStyles', () => {
  it('copies package CSS before consumer CSS and cleans up both', () => {
    const packageStyle = document.createElement('style');
    packageStyle.dataset.qwenWebShell = 'component';
    packageStyle.textContent = '[data-web-shell-root] { color: black; }';
    document.head.appendChild(packageStyle);
    const host = document.createElement('div');
    const shadowRoot = host.attachShadow({ mode: 'open' });

    const cleanup = installWebShellShadowStyles(
      shadowRoot,
      '.consumer-content { color: rebeccapurple; }',
    );

    expect(
      Array.from(shadowRoot.querySelectorAll('style')).map(
        (style) => style.textContent,
      ),
    ).toEqual([
      '[data-web-shell-root] { color: black; }',
      '.consumer-content { color: rebeccapurple; }',
    ]);
    cleanup();
    packageStyle.remove();
    expect(shadowRoot.querySelector('style')).toBeNull();
  });

  it('does not release a shared constructable sheet while another shell uses it', () => {
    const replaceSync = vi.fn();
    vi.stubGlobal(
      'CSSStyleSheet',
      class {
        replaceSync(css: string) {
          replaceSync(css);
        }
      },
    );
    const packageStyle = document.createElement('style');
    packageStyle.dataset.qwenWebShell = 'component';
    packageStyle.textContent = '[data-web-shell-root] { color: green; }';
    document.head.appendChild(packageStyle);
    const host = document.createElement('div');
    const shadow = host.attachShadow({ mode: 'open' });
    let sheets: CSSStyleSheet[] = [];
    Object.defineProperty(shadow, 'adoptedStyleSheets', {
      get: () => sheets,
      set: (next: CSSStyleSheet[]) => {
        sheets = next;
      },
    });
    try {
      const releaseFirst = installWebShellShadowStyles(shadow);
      const releaseSecond = installWebShellShadowStyles(shadow);
      expect(replaceSync).toHaveBeenCalledWith(packageStyle.textContent);
      expect(sheets).toHaveLength(1);
      releaseFirst();
      expect(sheets).toHaveLength(1);
      releaseSecond();
      expect(sheets).toHaveLength(0);
    } finally {
      packageStyle.remove();
      vi.unstubAllGlobals();
    }
  });

  it('keeps a sibling shell styled when one release is called twice', () => {
    vi.stubGlobal(
      'CSSStyleSheet',
      class {
        replaceSync() {}
      },
    );
    const packageStyle = document.createElement('style');
    packageStyle.dataset.qwenWebShell = 'component';
    packageStyle.textContent = '[data-web-shell-root] { color: teal; }';
    document.head.appendChild(packageStyle);
    const host = document.createElement('div');
    const shadow = host.attachShadow({ mode: 'open' });
    let sheets: CSSStyleSheet[] = [];
    Object.defineProperty(shadow, 'adoptedStyleSheets', {
      get: () => sheets,
      set: (next: CSSStyleSheet[]) => {
        sheets = next;
      },
    });
    try {
      const releaseFirst = installWebShellShadowStyles(shadow);
      const releaseSecond = installWebShellShadowStyles(shadow);
      releaseFirst();
      releaseFirst();
      expect(sheets).toHaveLength(1);
      releaseSecond();
      expect(sheets).toHaveLength(0);
    } finally {
      packageStyle.remove();
      vi.unstubAllGlobals();
    }
  });
});
