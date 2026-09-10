// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { WebShellBrand } from '../../brandContext';

const { connection, workspace, workspaceActions, active, pinned, archived } =
  vi.hoisted(() => {
    const makeSessions = () => {
      const state = {
        sessions: [] as never[],
        loading: false,
        error: null as Error | null,
        data: [] as never[] | undefined,
        reload: vi.fn().mockResolvedValue(undefined),
        deleteSession: vi.fn().mockResolvedValue(true),
        archiveSession: vi.fn().mockResolvedValue(true),
        unarchiveSession: vi.fn().mockResolvedValue(true),
        exportSession: vi.fn(),
      };
      state.data = state.sessions;
      return state;
    };
    return {
      connection: {
        status: 'connected',
        sessionId: null as string | null,
        workspaceCwd: '/tmp/project',
        capabilities: { qwenCodeVersion: '1.2.3', features: [] },
      },
      workspace: {
        capabilities: undefined,
        client: {
          workspaceByCwd: vi.fn(() => ({
            listWorkspaceSessions: vi.fn().mockResolvedValue([]),
            listSessionGroups: vi.fn().mockResolvedValue({
              groups: [],
              colorOptions: [],
            }),
          })),
        },
        refreshCapabilities: vi.fn(),
      },
      workspaceActions: {
        addWorkspace: vi.fn(),
        removeWorkspace: vi.fn(),
        listSessionGroups: vi.fn().mockResolvedValue({
          groups: [],
          colorOptions: [],
        }),
        createSessionGroup: vi.fn(),
        updateSessionGroup: vi.fn(),
        deleteSessionGroup: vi.fn(),
        updateSessionOrganization: vi.fn(),
      },
      active: makeSessions(),
      pinned: makeSessions(),
      archived: makeSessions(),
    };
  });

vi.mock('@qwen-code/web-shell/daemon-react-sdk', () => ({
  useConnection: () => connection,
  useActions: () => ({ renameSession: vi.fn() }),
  useWorkspace: () => workspace,
  useWorkspaceActions: () => workspaceActions,
  useChannels: () => ({ data: undefined, catalog: [], channels: {} }),
  useSessions: (options?: { archiveState?: string; group?: string }) => {
    if (options?.archiveState === 'archived') return archived;
    if (options?.group === 'pinned') return pinned;
    return active;
  },
}));

vi.mock('../../session-catalog/session-catalog-hooks', () => ({
  useWebShellSessions: (options?: {
    archiveState?: string;
    group?: string;
  }) => {
    if (options?.archiveState === 'archived') return archived;
    if (options?.group === 'pinned') return pinned;
    return active;
  },
  useSessionCatalogController: () => ({
    refreshQueries: vi.fn(),
    invalidateWorkspace: vi.fn(),
    refreshWorkspace: vi.fn(),
    renamed: vi.fn(),
  }),
  useSessionCatalogPolling: () => undefined,
  useSessionCatalogQuery: () => ({
    sessions: [],
    loading: false,
    error: undefined,
    reload: vi.fn(),
  }),
  useSessionCatalogQueries: vi.fn(() => []),
}));

const SIDEBAR_WIDTH_STORAGE_KEY = 'qwen-code-web-shell-sidebar-width';

const { I18nProvider } = await import('../../i18n');
const { BrandProvider } = await import('../../brandContext');
const { WebShellSidebar } = await import('./WebShellSidebar');

globalThis.IS_REACT_ACT_ENVIRONMENT = true;
if (!globalThis.PointerEvent) {
  globalThis.PointerEvent = MouseEvent as typeof PointerEvent;
}
if (!Element.prototype.hasPointerCapture) {
  Element.prototype.hasPointerCapture = () => false;
}
if (!Element.prototype.setPointerCapture) {
  Element.prototype.setPointerCapture = () => {};
}
if (!Element.prototype.releasePointerCapture) {
  Element.prototype.releasePointerCapture = () => {};
}
if (!Element.prototype.scrollIntoView) {
  Element.prototype.scrollIntoView = () => {};
}

let root: Root;
let container: HTMLDivElement;

function renderSidebar(
  brand?: WebShellBrand,
  branding?: { render?: () => ReactNode },
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
  return container.querySelector('svg[viewBox="0 0 141.38 140"]');
}

beforeEach(() => {
  window.localStorage.clear();
  // Mount above the compact footer breakpoint (344px): below it the version
  // label leaves the row (#11470), and the brand tooltip assertions query
  // that label's title.
  window.localStorage.setItem('qwen-code-web-shell-sidebar-width', '360');
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
    // `""` means "use the built-in name" on the settings surface, so a host
    // that builds its prop the same way must not get an empty sidebar row and
    // a version tooltip reading " v1.2.3".
    window.localStorage.setItem(SIDEBAR_WIDTH_STORAGE_KEY, '360');
    renderSidebar({ name: '' });

    expect(container.textContent).toContain('Qwen Code');
    expect(
      container.querySelector('[title="Qwen Code v1.2.3"]'),
    ).not.toBeNull();
  });

  it('names the version tooltip after the brand', () => {
    window.localStorage.setItem(SIDEBAR_WIDTH_STORAGE_KEY, '360');
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
