// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, type ReactNode, type ComponentProps } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import type { WebShellBrand } from '../../brandContext';
import canonicalLightSvg from '../../public/assets/icon.svg?raw';
import {
  DAEMON_APPROVAL_MODES,
  clickSidebarElement,
  createSidebarMocks,
  installSidebarDomShims,
  sidebarSessionPage,
  staticSidebarSessionCatalogQuery,
} from '../../test/sidebarHarness';

const expectedDarkPath =
  'M12.604 1.34c.393.69.784 1.382 1.174 2.075a.18.18 0 00.157.091h5.552c.174 0 .322.11.446.327l1.454 2.57c.19.337.24.478.024.837-.26.43-.513.864-.76 1.3l-.367.658c-.106.196-.223.28-.04.512l2.652 4.637c.172.301.111.494-.043.77-.437.785-.882 1.564-1.335 2.34-.159.272-.352.375-.68.37-.777-.016-1.552-.01-2.327.016a.099.099 0 00-.081.05 575.097 575.097 0 01-2.705 4.74c-.169.293-.38.363-.725.364-.997.003-2.002.004-3.017.002a.537.537 0 01-.465-.271l-1.335-2.323a.09.09 0 00-.083-.049H4.982c-.285.03-.553-.001-.805-.092l-1.603-2.77a.543.543 0 01-.002-.54l1.207-2.12a.198.198 0 000-.197 550.951 550.951 0 01-1.875-3.272l-.79-1.395c-.16-.31-.173-.496.095-.965.465-.813.927-1.625 1.387-2.436.132-.234.304-.334.584-.335a338.3 338.3 0 012.589-.001.124.124 0 00.107-.063l2.806-4.895a.488.488 0 01.422-.246c.524-.001 1.053 0 1.583-.006L11.704 1c.341-.003.724.032.9.34zm-3.432.403a.06.06 0 00-.052.03L6.254 6.788a.157.157 0 01-.135.078H3.253c-.056 0-.07.025-.041.074l5.81 10.156c.025.042.013.062-.034.063l-2.795.015a.218.218 0 00-.2.116l-1.32 2.31c-.044.078-.021.118.068.118l5.716.008c.046 0 .08.02.104.061l1.403 2.454c.046.081.092.082.139 0l5.006-8.76.783-1.382a.055.055 0 01.096 0l1.424 2.53a.122.122 0 00.107.062l2.763-.02a.04.04 0 00.035-.02.041.041 0 000-.04l-2.9-5.086a.108.108 0 010-.113l.293-.507 1.12-1.977c.024-.041.012-.062-.035-.062H9.2c-.059 0-.073-.026-.043-.077l1.434-2.505a.107.107 0 000-.114L9.225 1.774a.06.06 0 00-.053-.031zm6.29 8.02c.046 0 .058.02.034.06l-.832 1.465-2.613 4.585a.056.056 0 01-.05.029.058.058 0 01-.05-.029L8.498 9.841c-.02-.034-.01-.052.028-.054l.216-.012 6.722-.012z';

const catalogOptions = vi.hoisted(() => vi.fn());
const catalogRefresh = vi.hoisted(() => vi.fn());
const catalogPolling = vi.hoisted(() => vi.fn());

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
  useSessionCatalogPolling: catalogPolling,
  useSessionCatalogQuery: () => staticSidebarSessionCatalogQuery(),
  useSessionCatalogQueries: mocks.useSessionCatalogQueries,
}));

const { I18nProvider } = await import('../../i18n');
const { BrandProvider } = await import('../../brandContext');
const { WebShellSidebar, DEFAULT_PRIMARY_NAV_ITEMS } = await import(
  './WebShellSidebar'
);

installSidebarDomShims();

let root: Root;
let container: HTMLDivElement;

function renderSidebar(
  brand?: WebShellBrand,
  branding?: false | { render?: () => ReactNode },
  sessionProps?: Pick<
    ComponentProps<typeof WebShellSidebar>,
    | 'sessionContent'
    | 'sessionHeader'
    | 'onNewSession'
    | 'onOpenArtifacts'
    | 'primaryNav'
    | 'hideProjectHeader'
    | 'collapsed'
    | 'theme'
    | 'containerWidth'
    | 'mobileOpen'
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
            theme="dark"
            onThemeChange={() => {}}
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
  return container.querySelector('svg[data-testid="qwen-brand-mark"]');
}

function normalizedSvgAttributes(
  element: Element | null | undefined,
): Array<[string, string]> | undefined {
  if (!element) return undefined;
  return Array.from(
    element.attributes,
    ({ name, value }) => [name, value] as [string, string],
  ).sort(([a], [b]) => a.localeCompare(b));
}

function expectCanonicalSvgChildren(
  mark: Element | null,
  canonicalRoot: Element,
): void {
  const expectedChildren = Array.from(canonicalRoot.children);
  expect(expectedChildren).toHaveLength(3);
  const actualChildren = Array.from(mark?.children ?? []);
  expect(actualChildren).toHaveLength(expectedChildren.length);
  actualChildren.forEach((child, index) => {
    const expected = expectedChildren[index];
    expect(child.localName).toBe(expected.localName);
    expect(child.namespaceURI).toBe(expected.namespaceURI);
    expect(normalizedSvgAttributes(child)).toEqual(
      normalizedSvgAttributes(expected),
    );
    expect(child.children).toHaveLength(expected.children.length);
  });
}

function expectCompactDarkMark(): void {
  const mark = builtInMark();
  expect(mark?.parentElement?.children).toHaveLength(1);
  expect(mark?.namespaceURI).toBe('http://www.w3.org/2000/svg');
  expect(normalizedSvgAttributes(mark)).toEqual([
    ['aria-hidden', 'true'],
    ['data-testid', 'qwen-brand-mark'],
    ['fill', 'currentColor'],
    ['fill-rule', 'evenodd'],
    ['viewBox', '0 0 24 24'],
  ]);
  expect(mark?.children).toHaveLength(1);
  const path = mark?.children[0];
  expect(path?.localName).toBe('path');
  expect(path?.namespaceURI).toBe('http://www.w3.org/2000/svg');
  expect(normalizedSvgAttributes(path)).toEqual([['d', expectedDarkPath]]);
  expect(path?.children).toHaveLength(0);
}

function expectOriginalLightMark(): void {
  const canonical = new DOMParser().parseFromString(
    canonicalLightSvg,
    'image/svg+xml',
  );
  const mark = builtInMark();
  expect(mark?.parentElement?.children).toHaveLength(1);
  expect(mark?.namespaceURI).toBe(canonical.documentElement.namespaceURI);
  expect(normalizedSvgAttributes(mark)).toEqual([
    ['aria-hidden', 'true'],
    ['data-testid', 'qwen-brand-mark'],
    ['viewBox', '17.5 27.7 135.6 135.6'],
  ]);
  expectCanonicalSvgChildren(mark, canonical.documentElement);
}

beforeEach(() => {
  catalogOptions.mockClear();
  catalogRefresh.mockClear();
  catalogPolling.mockClear();
  mocks.connection.capabilities = {
    qwenCodeVersion: '1.2.3',
    features: [],
  };
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

describe('sidebar catalog polling', () => {
  it('backs off only when the compact shell drawer is closed', () => {
    mocks.active.sessions.push({
      id: 'running',
      cwd: '/workspace/project',
      hasActivePrompt: true,
    });
    try {
      renderSidebar(undefined, undefined, { containerWidth: 1000 });
      expect(catalogPolling.mock.lastCall?.[2]).toBe(2000);
      renderSidebar(undefined, undefined, {
        containerWidth: 650,
        mobileOpen: false,
      });
      expect(catalogPolling.mock.lastCall?.[2]).toBe(30_000);
      renderSidebar(undefined, undefined, {
        containerWidth: 650,
        mobileOpen: true,
      });
      expect(catalogPolling.mock.lastCall?.[2]).toBe(2000);
    } finally {
      mocks.active.sessions.pop();
    }
  });
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

  it.each([undefined, false] as const)(
    'places display options in the workspace header with branding=%s',
    async (branding) => {
      mocks.connection.capabilities = {
        qwenCodeVersion: '1.2.3',
        features: ['session_last_user_prompt_sort'],
      };
      renderSidebar(undefined, branding);

      if (branding === false) {
        expect(container.textContent).not.toContain('Qwen Code');
      }
      const sort = container.querySelector<HTMLElement>(
        'button[aria-label="Display options"]',
      );
      expect(sort).not.toBeNull();
      const select = container.querySelector<HTMLElement>(
        'button[aria-label="Select sessions"]',
      );
      expect(select).not.toBeNull();
      expect(
        sort!.parentElement!.querySelector(
          'button[aria-label="Collapse all workspaces"]',
        ),
      ).not.toBeNull();
      expect(sort!.closest('[class*="newTaskNav"]')).toBeNull();
      expect(select!.parentElement!.parentElement).toBe(
        container.querySelector('button[aria-label="New session"]')!
          .parentElement,
      );
      expect(
        container.querySelectorAll('button[aria-label="Display options"]'),
      ).toHaveLength(1);
      expect(
        container.querySelector('[data-testid="manage-workspaces"]'),
      ).toBeNull();
      await act(async () => clickSidebarElement(sort!, true));
      const sortBy = Array.from(
        document.querySelectorAll<HTMLElement>('[role="menuitem"]'),
      ).find((item) => item.textContent?.startsWith('Sort by'));
      expect(sortBy).toBeDefined();
      await act(async () => {
        sortBy!.focus();
        sortBy!.dispatchEvent(
          new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }),
        );
      });
      const choice = Array.from(
        document.querySelectorAll<HTMLElement>('[role="menuitemradio"]'),
      ).find((item) => item.textContent === 'Last question');
      expect(choice).toBeDefined();
      await act(async () => clickSidebarElement(choice!));
      expect(
        catalogOptions.mock.calls.some(
          ([options]) => options.sortBy === 'lastUserPromptAt',
        ),
      ).toBe(true);
    },
  );

  it.each([
    { branding: undefined, hideProjectHeader: false },
    { branding: false, hideProjectHeader: false },
    { branding: undefined, hideProjectHeader: true },
    { branding: false, hideProjectHeader: true },
  ] as const)(
    'keeps sorting visible without newTask: %j',
    ({ branding, hideProjectHeader }) => {
      mocks.connection.capabilities = {
        qwenCodeVersion: '1.2.3',
        features: ['session_last_user_prompt_sort'],
      };
      renderSidebar(undefined, branding, {
        primaryNav: { items: [] },
        hideProjectHeader,
      });

      expect(
        container.querySelector('button[aria-label="Select sessions"]'),
      ).toBeNull();
      const sorts = container.querySelectorAll(
        'button[aria-label="Display options"]',
      );
      expect(sorts).toHaveLength(1);
      expect(
        sorts[0].parentElement!.parentElement!.querySelector(
          'button[aria-label="New session"]',
        ),
      ).toBeNull();
      if (hideProjectHeader) {
        expect(
          sorts[0].parentElement!.querySelector(
            'button[aria-label="Collapse all workspaces"]',
          ),
        ).toBeNull();
      } else {
        expect(
          sorts[0].parentElement!.querySelector(
            'button[aria-label="Collapse all workspaces"]',
          ),
        ).not.toBeNull();
      }
    },
  );

  it('omits the local sort control when the host provides session content', () => {
    mocks.connection.capabilities = {
      qwenCodeVersion: '1.2.3',
      features: ['session_last_user_prompt_sort'],
    };
    renderSidebar(undefined, undefined, {
      sessionContent: (
        <nav aria-label="Managed sessions">Managed history navigation</nav>
      ),
    });

    expect(
      container.querySelector('button[aria-label="Display options"]'),
    ).toBeNull();
  });

  it('keeps sorting reachable in the collapsed session popover', async () => {
    mocks.connection.capabilities = {
      qwenCodeVersion: '1.2.3',
      features: ['session_last_user_prompt_sort'],
    };
    renderSidebar(undefined, undefined, { collapsed: true });
    const trigger = container.querySelector<HTMLElement>(
      '[data-web-shell-collapsed-session-trigger]',
    );
    expect(trigger).not.toBeNull();
    await act(async () => clickSidebarElement(trigger!));
    const sorts = document.querySelectorAll<HTMLElement>(
      'button[aria-label="Display options"]',
    );
    expect(sorts).toHaveLength(1);
    expect(
      sorts[0].parentElement!.querySelector(
        'button[aria-label="Collapse all workspaces"]',
      ),
    ).not.toBeNull();
    await act(async () => clickSidebarElement(sorts[0], true));
    const sortBy = Array.from(
      document.querySelectorAll<HTMLElement>('[role="menuitem"]'),
    ).find((item) => item.textContent?.startsWith('Sort by'));
    expect(sortBy).toBeDefined();
    await act(async () => {
      sortBy!.focus();
      sortBy!.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }),
      );
    });
    expect(document.querySelectorAll('[role="menuitemradio"]')).toHaveLength(2);
    const option = Array.from(
      document.querySelectorAll<HTMLElement>('[role="menuitemradio"]'),
    ).find((item) => item.textContent === 'Last question');
    expect(option).toBeDefined();
    await act(async () => clickSidebarElement(option!));
    expect(
      catalogOptions.mock.calls.some(
        ([options]) => options.sortBy === 'lastUserPromptAt',
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

  it('uses the compact dark-theme artwork with theme-aware color', () => {
    renderSidebar();

    expectCompactDarkMark();
  });

  it('keeps the original blue mark in the light theme', () => {
    renderSidebar(undefined, undefined, { theme: 'light' });

    expectOriginalLightMark();
  });

  // Decode fallback shares the entire failure contract across themes.
  // Only the expected artwork differs.
  it.each([
    { theme: 'dark', expectMark: expectCompactDarkMark },
    { theme: 'light', expectMark: expectOriginalLightMark },
  ] as const)(
    'falls back after a logo decode failure in $theme',
    ({ theme, expectMark }) => {
      renderSidebar({ logoDataUri: 'data:image/svg+xml,NOT-SVG' }, undefined, {
        theme,
      });

      const image = brandLogoImage();
      expect(image).not.toBeNull();
      expect(builtInMark()).toBeNull();

      // The warning is the only signal for a daemon-approved but broken logo.
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
      try {
        act(() => {
          image!.dispatchEvent(new Event('error'));
        });

        expect(brandLogoImage()).toBeNull();
        expectMark();
        expect(warn).toHaveBeenCalledTimes(1);
        expect(warn).toHaveBeenNthCalledWith(
          1,
          '[web-shell] brand logo could not be rendered; falling back to the built-in mark',
        );
      } finally {
        warn.mockRestore();
      }
    },
  );

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

  it('includes artifacts in DEFAULT_PRIMARY_NAV_ITEMS and hides the nav entry when onOpenArtifacts is omitted', () => {
    expect(DEFAULT_PRIMARY_NAV_ITEMS).toContain('artifacts');

    renderSidebar(undefined, undefined, {});
    expect(
      container.querySelector('[data-testid="sidebar-artifacts-nav"]'),
    ).toBeNull();

    const onOpenArtifacts = vi.fn();
    renderSidebar(undefined, undefined, { onOpenArtifacts });
    const navBtn = container.querySelector(
      '[data-testid="sidebar-artifacts-nav"]',
    );
    expect(navBtn).not.toBeNull();
    expect(navBtn?.textContent).toContain('Artifacts');
    clickSidebarElement(navBtn);
    expect(onOpenArtifacts).toHaveBeenCalledOnce();
  });
});
