// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, type ReactNode, type ComponentProps } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { WebShellBrand } from '../../brandContext';
import {
  DAEMON_APPROVAL_MODES,
  createSidebarMocks,
  installSidebarDomShims,
  sidebarSessionPage,
  staticSidebarSessionCatalogQuery,
} from '../../test/sidebarHarness';

const catalogOptions = vi.hoisted(() => vi.fn());
const catalogRefresh = vi.hoisted(() => vi.fn());

const mocks = createSidebarMocks({
  connectionCapabilities: { qwenCodeVersion: '1.2.3', features: [] },
});

vi.mock('@qwen-code/web-shell/daemon-react-sdk', () => ({
  DAEMON_APPROVAL_MODES,
  useConnection: () => mocks.connection,
  useActions: () => mocks.actions,
  useWorkspace: () => mocks.workspace,
  useWorkspaceActions: () => mocks.workspaceActions,
  useChannels: () => mocks.channels,
  useSessions: (options?: { archiveState?: string; group?: string }) =>
    sidebarSessionPage(mocks, options),
}));

vi.mock('../../session-catalog/session-catalog-hooks', () => ({
  useWebShellSessions: (options?: {
    enabled?: boolean;
    autoLoad?: boolean;
    archiveState?: string;
    group?: string;
  }) => {
    catalogOptions(options);
    return sidebarSessionPage(mocks, options);
  },
  useSessionCatalogController: () => ({
    refreshQueries: mocks.refreshSessionCatalogQueries,
    invalidateWorkspace: vi.fn(),
    refreshWorkspace: catalogRefresh,
    renamed: vi.fn(),
  }),
  useSessionCatalogPolling: () => undefined,
  useSessionCatalogQuery: () => staticSidebarSessionCatalogQuery(),
  useSessionCatalogQueries: mocks.useSessionCatalogQueries,
}));

const { I18nProvider } = await import('../../i18n');
const { BrandProvider } = await import('../../brandContext');
const { WebShellSidebar } = await import('./WebShellSidebar');

installSidebarDomShims();

let root: Root;
let container: HTMLDivElement;

function renderSidebar(
  brand?: WebShellBrand,
  branding?: { render?: () => ReactNode },
  sessionProps?: Pick<
    ComponentProps<typeof WebShellSidebar>,
    'sessionContent' | 'sessionHeader' | 'onNewSession'
  >,
) {
  act(() => {
    root.render(
      <I18nProvider language="en">
        <BrandProvider value={brand ?? {}}>
          <WebShellSidebar
            collapsed={false}
            onCollapsedChange={() => {}}
            onOpenSettings={() => {}}
            onOpenDaemonStatus={() => {}}
            onOpenScheduledTasks={() => {}}
            onOpenWorkflows={() => {}}
            onOpenGoals={() => {}}
            onOpenSessions={() => {}}
            onOpenSplitView={() => {}}
            onNewSession={() => false}
            onLoadSession={vi.fn()}
            onError={() => {}}
            footer={{ items: ['version'] }}
            branding={branding}
            {...sessionProps}
          />
        </BrandProvider>
      </I18nProvider>,
    );
  });
}

function brandLogoImage(): HTMLImageElement | null {
  return container.querySelector('img[src^="data:image/svg+xml,"]');
}

/** The built-in inline mark — the one every unconfigured deployment sees. */
function builtInMark(): Element | null {
  return container.querySelector('svg[viewBox="17.5 27.7 135.6 135.6"]');
}

beforeEach(() => {
  catalogOptions.mockClear();
  catalogRefresh.mockClear();
  window.localStorage.clear();
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => {
    root.unmount();
  });
  container.remove();
});

describe('sidebar brand', () => {
  it('uses external history without loading or invalidating daemon catalogs, and restores local catalogs when removed', async () => {
    const onNewSession = vi.fn(() => true);
    renderSidebar(undefined, undefined, {
      sessionHeader: <div data-testid="session-modes">Local / Managed</div>,
      sessionContent: (
        <nav aria-label="Managed sessions">Managed history navigation</nav>
      ),
      onNewSession,
    });
    expect(
      container.querySelector('nav[aria-label="Managed sessions"]'),
    ).not.toBeNull();
    expect(
      container.querySelector('[data-testid="session-modes"]'),
    ).not.toBeNull();
    expect(
      catalogOptions.mock.calls.every(
        ([options]) => options.enabled === false && options.autoLoad === false,
      ),
    ).toBe(true);
    const create = container.querySelector<HTMLButtonElement>(
      'button[aria-label="New session"]',
    );
    expect(create).not.toBeNull();
    await act(async () => {
      create!.click();
      await Promise.resolve();
    });
    expect(onNewSession).toHaveBeenCalledOnce();
    expect(catalogRefresh).not.toHaveBeenCalled();
    catalogOptions.mockClear();
    renderSidebar(undefined, undefined, {
      sessionHeader: <div data-testid="session-modes">Local / Managed</div>,
    });
    expect(
      container.querySelector('nav[aria-label="Managed sessions"]'),
    ).toBeNull();
    expect(
      container.querySelector('[data-testid="session-modes"]'),
    ).not.toBeNull();
    expect(
      catalogOptions.mock.calls.some(
        ([options]) => options.enabled === true && options.autoLoad === true,
      ),
    ).toBe(true);
  });

  it('renders the built-in name and inline mark when no brand is configured', () => {
    renderSidebar();

    expect(container.textContent).toContain('Qwen Code');
    expect(brandLogoImage()).toBeNull();
    // The positive half of "default unchanged": the built-in mark is actually
    // there, not merely that no img is present (an empty 28px box passes that).
    expect(builtInMark()).not.toBeNull();
  });

  it('renders the configured name', () => {
    renderSidebar({ name: 'QiuQiu Code' });

    expect(container.textContent).toContain('QiuQiu Code');
    expect(container.textContent).not.toContain('Qwen Code');
  });

  it('treats an empty name as unset rather than blanking the brand row', () => {
    // The version tooltip is rendered above the 344px compact breakpoint.
    window.localStorage.setItem('qwen-code-web-shell-sidebar-width', '360');
    // `""` means "use the built-in name" on the settings surface, so a host
    // that builds its prop the same way must not get an empty sidebar row and
    // a version tooltip reading " v1.2.3".
    renderSidebar({ name: '' });

    expect(container.textContent).toContain('Qwen Code');
    expect(
      container.querySelector('[title="Qwen Code v1.2.3"]'),
    ).not.toBeNull();
  });

  it('names the version tooltip after the brand', () => {
    // The version tooltip is rendered above the 344px compact breakpoint.
    window.localStorage.setItem('qwen-code-web-shell-sidebar-width', '360');
    renderSidebar({ name: 'QiuQiu Code' });

    expect(
      container.querySelector('[title="QiuQiu Code v1.2.3"]'),
    ).not.toBeNull();
  });

  it('renders a configured logo as an image, never as injected markup', () => {
    // The daemon does not sanitize the SVG it read, so this is the invariant
    // that keeps a hostile logo file inert: the payload may only ever reach the
    // DOM as an img src. If a future change inlines it, this test must fail.
    // The spy installs BEFORE the render on purpose: the fallback warning
    // must fire only on a real decode failure, so a logo that renders must
    // never produce it — not even during mount.
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const hostile =
        'data:image/svg+xml,' +
        encodeURIComponent(
          '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>',
        );

      renderSidebar({ name: 'QiuQiu Code', logoDataUri: hostile });

      expect(brandLogoImage()?.getAttribute('src')).toBe(hostile);
      expect(builtInMark()).toBeNull();
      expect(container.querySelectorAll('script')).toHaveLength(0);
      expect(container.innerHTML).not.toContain('alert(1)</script>');
      expect(warn).not.toHaveBeenCalled();
    } finally {
      warn.mockRestore();
    }
  });

  it('falls back to the built-in mark when the logo image fails to decode', () => {
    renderSidebar({ logoDataUri: 'data:image/svg+xml,NOT-SVG' });

    const img = brandLogoImage();
    expect(img).not.toBeNull();
    expect(builtInMark()).toBeNull();

    // A data URI the browser cannot decode (malformed XML, an xmlns-less root)
    // fires `error` — the mark must come back rather than leaving a blank box.
    // And the swap must be audible: the daemon validates only the root tag,
    // so this is the one logo failure with no other signal channel.
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      act(() => {
        img!.dispatchEvent(new Event('error'));
      });

      expect(brandLogoImage()).toBeNull();
      expect(builtInMark()).not.toBeNull();
      expect(warn).toHaveBeenCalledTimes(1);
      expect(warn).toHaveBeenCalledWith(
        expect.stringContaining('brand logo could not be rendered'),
      );
    } finally {
      warn.mockRestore();
    }
  });

  it('gives a replacement logo a fresh mount after a decode failure', () => {
    // The host-prop path goes URI A → URI B with no intermediate undefined.
    // Without `key={brand.logoDataUri}` remounting the image, A's failed
    // state would stick and B — a perfectly good logo — would render the
    // built-in mark instead: the leak the key exists to prevent.
    renderSidebar({ logoDataUri: 'data:image/svg+xml,BROKEN' });
    act(() => {
      brandLogoImage()!.dispatchEvent(new Event('error'));
    });
    expect(builtInMark()).not.toBeNull();

    renderSidebar({ logoDataUri: 'data:image/svg+xml,GOOD' });

    expect(brandLogoImage()?.getAttribute('src')).toBe(
      'data:image/svg+xml,GOOD',
    );
    expect(builtInMark()).toBeNull();
  });

  it('renders a host-provided logo node in place of the built-in mark', () => {
    renderSidebar({ logo: <span data-testid="host-logo" /> });

    expect(container.querySelector('[data-testid="host-logo"]')).not.toBeNull();
    // "In place of", not "alongside": the built-in mark must not render beside
    // a replacement — that is the one leak a white-label feature exists to stop.
    expect(builtInMark()).toBeNull();
  });

  it('falls back when the host logo node is falsy', () => {
    // The common host idiom `logo: hasCustomLogo && <Logo />` yields `false` —
    // a legal ReactNode that renders nothing. It must mean "no logo", matching
    // the empty-name rule, or the row would blank.
    renderSidebar({ logo: false });

    expect(builtInMark()).not.toBeNull();
  });

  it('still lets the branding render override replace the whole row', () => {
    renderSidebar(
      { name: 'QiuQiu Code' },
      { render: () => <span data-testid="custom-brand">Custom</span> },
    );

    expect(
      container.querySelector('[data-testid="custom-brand"]'),
    ).not.toBeNull();
    expect(container.textContent).not.toContain('QiuQiu Code');
  });
});
