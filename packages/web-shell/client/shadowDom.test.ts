// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import {
  isPluginShadowPanel,
  installWebShellShadowStyles,
  resolveWebShellShadowDom,
} from './shadowDom';

describe('isPluginShadowPanel', () => {
  it.each(['plugins', 'extensions', 'mcp', 'skills', 'agents'])(
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
});
