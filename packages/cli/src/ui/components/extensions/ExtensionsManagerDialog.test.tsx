/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import { render } from 'ink-testing-library';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { waitFor } from '@testing-library/react';
import { ExtensionsManagerDialog } from './ExtensionsManagerDialog.js';
import { EXTENSIONS_TABS } from './types.js';
import { UIStateContext } from '../../contexts/UIStateContext.js';
import { KeypressProvider } from '../../contexts/KeypressContext.js';
import { SettingsContext } from '../../contexts/SettingsContext.js';
import { ShellFocusContext } from '../../contexts/ShellFocusContext.js';
import { LoadedSettings } from '../../../config/settings.js';
import type { UIState } from '../../contexts/UIStateContext.js';
import type {
  Config,
  Extension,
  DiscoveredPlugin,
  MarketplaceSource,
} from '@qwen-code/qwen-code-core';
import type { ExtensionUpdateState } from '../../state/extensions.js';

const mockExtension = (name: string, isActive = true): Extension =>
  ({
    id: name,
    name,
    version: '1.0.0',
    path: `/home/user/.qwen/extensions/${name}`,
    isActive,
    installMetadata: { type: 'git', source: `github:user/${name}` },
    mcpServers: {},
    commands: [],
    skills: [],
    agents: [],
    resolvedSettings: [],
    config: {},
    contextFiles: [],
  }) as unknown as Extension;

interface ManagerOverrides {
  extensions?: Extension[];
  discovered?: DiscoveredPlugin[];
  marketplaces?: MarketplaceSource[];
  favorites?: string[];
  scopes?: Record<string, string>;
}

const createManager = (o: ManagerOverrides = {}) => {
  const extensions = o.extensions ?? [];
  return {
    refreshCache: vi.fn().mockResolvedValue(undefined),
    getLoadedExtensions: vi.fn(() => extensions),
    getFavorites: vi.fn(() => o.favorites ?? []),
    getExtensionScopes: vi.fn(() => o.scopes ?? {}),
    getMarketplaces: vi.fn(() => o.marketplaces ?? []),
    discoverPlugins: vi.fn().mockResolvedValue(o.discovered ?? []),
    toggleFavorite: vi.fn(() => true),
    setExtensionScope: vi.fn(),
    enableExtension: vi.fn().mockResolvedValue(undefined),
    disableExtension: vi.fn().mockResolvedValue(undefined),
    uninstallExtension: vi.fn().mockResolvedValue(undefined),
    checkForAllExtensionUpdates: vi.fn().mockResolvedValue(undefined),
    updateExtension: vi.fn().mockResolvedValue(undefined),
    addMarketplace: vi.fn(),
    removeMarketplace: vi.fn(() => true),
    loadMarketplace: vi.fn().mockResolvedValue(null),
  };
};

const createConfig = (manager: ReturnType<typeof createManager>): Config =>
  ({
    getExtensionManager: () => manager,
    getMcpServers: () => ({}),
    getToolRegistry: () => undefined,
    isMcpServerDisabled: () => false,
    getExcludedMcpServers: () => [],
    setExcludedMcpServers: vi.fn(),
  }) as unknown as Config;

const createUIState = (
  extensionsUpdateState = new Map<string, ExtensionUpdateState>(),
): UIState => ({ extensionsUpdateState }) as unknown as UIState;

const mockSettings = new LoadedSettings(
  { path: '', settings: {}, originalSettings: {} },
  { path: '', settings: {}, originalSettings: {} },
  { path: '', settings: {}, originalSettings: {} },
  { path: '', settings: {}, originalSettings: {} },
  true,
  new Set(),
);

const renderDialog = (
  config: Config,
  opts: {
    onClose?: () => void;
    initialTab?: (typeof EXTENSIONS_TABS)[keyof typeof EXTENSIONS_TABS];
    uiState?: UIState;
  } = {},
) =>
  render(
    <SettingsContext.Provider value={mockSettings}>
      <ShellFocusContext.Provider value={true}>
        <UIStateContext.Provider value={opts.uiState ?? createUIState()}>
          <KeypressProvider kittyProtocolEnabled={false}>
            <ExtensionsManagerDialog
              onClose={opts.onClose ?? vi.fn()}
              config={config}
              initialTab={opts.initialTab}
            />
          </KeypressProvider>
        </UIStateContext.Provider>
      </ShellFocusContext.Provider>
    </SettingsContext.Provider>,
  );

describe('ExtensionsManagerDialog (tabbed)', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('renders the tab bar with all three tabs', () => {
    const { lastFrame } = renderDialog(createConfig(createManager()));
    const frame = lastFrame();
    expect(frame).toContain('Discover');
    expect(frame).toContain('Installed');
    expect(frame).toContain('Marketplaces');
  });

  it('shows discovered plugins on the Discover tab', async () => {
    const discovered: DiscoveredPlugin[] = [
      {
        marketplaceName: 'Skills',
        name: 'pdf',
        description: 'PDF tools',
        installSource: 'anthropics/skills:pdf',
        installed: false,
      },
      {
        marketplaceName: 'Skills',
        name: 'docx',
        installSource: 'anthropics/skills:docx',
        installed: true,
      },
    ];
    const { lastFrame } = renderDialog(
      createConfig(createManager({ discovered })),
    );
    await waitFor(() => {
      expect(lastFrame()).toContain('pdf');
    });
    expect(lastFrame()).toContain('docx');
    expect(lastFrame()).toContain('installed');
  });

  it('opens a CC-style plugin detail with an inline scope selector on Enter', async () => {
    const discovered: DiscoveredPlugin[] = [
      {
        marketplaceName: 'claude-plugins-official',
        name: '42crunch-api-security-testing',
        description: 'Automate API security directly in your workflow.',
        author: '42Crunch',
        homepage: 'https://example.com/42crunch',
        components: { skills: ['42crunch-audit', '42crunch-scan'] },
        installSource: 'owner/repo:42crunch-api-security-testing',
        installed: false,
      },
    ];
    const { stdin, lastFrame } = renderDialog(
      createConfig(createManager({ discovered })),
    );
    await waitFor(() => {
      expect(lastFrame()).toContain('42crunch-api-security-testing');
    });
    stdin.write('\r'); // Enter -> detail
    await waitFor(() => {
      expect(lastFrame()).toContain('Plugin details');
    });
    const frame = lastFrame();
    expect(frame).toContain('from claude-plugins-official');
    expect(frame).toContain('By: 42Crunch');
    expect(frame).toContain('Will install:');
    expect(frame).toContain('42crunch-audit');
    // Inline action selector with the three CC scopes + homepage + back.
    expect(frame).toContain('Install for you (user scope)');
    expect(frame).toContain('project scope');
    expect(frame).toContain('local scope');
    expect(frame).toContain('Open homepage');
    expect(frame).toContain('Back to plugin list');
  });

  it('windows a long Discover list with a scroll hint and count header', async () => {
    const discovered: DiscoveredPlugin[] = Array.from(
      { length: 15 },
      (_, i) => ({
        marketplaceName: 'mkt',
        name: `plugin-${i}`,
        installSource: `owner/repo:plugin-${i}`,
        installed: false,
      }),
    );
    const { lastFrame } = renderDialog(
      createConfig(createManager({ discovered })),
    );
    await waitFor(() => {
      expect(lastFrame()).toContain('plugin-0');
    });
    const frame = lastFrame();
    expect(frame).toContain('Discover plugins');
    expect(frame).toContain('(1/15)');
    expect(frame).toContain('Search'); // search box
    // Not all 15 fit; the more-below indicator is shown.
    expect(frame).toContain('more below');
    // The last item is scrolled out of the initial window.
    expect(frame).not.toContain('plugin-14');
  });

  it('filters the Discover list as you type', async () => {
    const discovered: DiscoveredPlugin[] = [
      {
        marketplaceName: 'm',
        name: 'alpha',
        installSource: 'o/r:alpha',
        installed: false,
      },
      {
        marketplaceName: 'm',
        name: 'beta',
        installSource: 'o/r:beta',
        installed: false,
      },
      {
        marketplaceName: 'm',
        name: 'gamma',
        installSource: 'o/r:gamma',
        installed: false,
      },
    ];
    const { stdin, lastFrame } = renderDialog(
      createConfig(createManager({ discovered })),
    );
    await waitFor(() => {
      expect(lastFrame()).toContain('alpha');
    });
    for (const ch of 'beta') {
      stdin.write(ch); // type-to-search, one printable char at a time
    }
    await waitFor(() => {
      expect(lastFrame()).toContain('beta');
      expect(lastFrame()).not.toContain('alpha');
    });
    expect(lastFrame()).not.toContain('gamma');
    expect(lastFrame()).toContain('(1/1)');
  });

  it('prompts to add a marketplace when none discovered', async () => {
    const { lastFrame } = renderDialog(createConfig(createManager()));
    await waitFor(() => {
      expect(lastFrame()).toContain('No plugins discovered');
    });
  });

  it('groups installed plugins by scope on the Installed tab', async () => {
    const config = createConfig(
      createManager({
        extensions: [
          mockExtension('alpha', true),
          mockExtension('beta', false),
        ],
        scopes: { alpha: 'user' },
      }),
    );
    const { lastFrame } = renderDialog(config, {
      initialTab: EXTENSIONS_TABS.INSTALLED,
    });
    await waitFor(() => {
      expect(lastFrame()).toContain('alpha');
    });
    const frame = lastFrame();
    expect(frame).toContain('User');
    expect(frame).toContain('Disabled');
    expect(frame).toContain('beta');
  });

  it('toggles favorite when pressing f on the Installed tab', async () => {
    const manager = createManager({
      extensions: [mockExtension('alpha', true)],
    });
    const { stdin, lastFrame } = renderDialog(createConfig(manager), {
      initialTab: EXTENSIONS_TABS.INSTALLED,
    });
    await waitFor(() => {
      expect(lastFrame()).toContain('alpha');
    });
    stdin.write('f');
    await waitFor(() => {
      expect(manager.toggleFavorite).toHaveBeenCalledWith('alpha');
    });
  });

  it('moves a plugin into the Favorites group after favoriting (regroup/reload)', async () => {
    const favorites: string[] = [];
    const manager = createManager({
      extensions: [mockExtension('alpha', true), mockExtension('beta', true)],
    });
    manager.getFavorites = vi.fn(() => [...favorites]);
    manager.toggleFavorite = vi.fn((name: string) => {
      const i = favorites.indexOf(name);
      if (i >= 0) {
        favorites.splice(i, 1);
        return false;
      }
      favorites.push(name);
      return true;
    });
    const { stdin, lastFrame } = renderDialog(createConfig(manager), {
      initialTab: EXTENSIONS_TABS.INSTALLED,
    });
    await waitFor(() => {
      expect(lastFrame()).toContain('alpha');
    });
    // Initially there is no Favorites group.
    expect(lastFrame()).not.toContain('Favorites');
    stdin.write('f'); // favorite the selected item (alpha, first in the list)
    await waitFor(() => {
      expect(lastFrame()).toContain('Favorites');
    });
    expect(manager.toggleFavorite).toHaveBeenCalledWith('alpha');
    // The list re-rendered cleanly (no stuck/empty frame) and still shows beta.
    expect(lastFrame()).toContain('beta');
  });

  it('shows the add-marketplace row on the Marketplaces tab', async () => {
    const config = createConfig(
      createManager({
        marketplaces: [
          { name: 'Skills', source: 'anthropics/skills', type: 'github' },
        ],
      }),
    );
    const { lastFrame } = renderDialog(config, {
      initialTab: EXTENSIONS_TABS.MARKETPLACES,
    });
    await waitFor(() => {
      expect(lastFrame()).toContain('Add new marketplace');
    });
    expect(lastFrame()).toContain('Skills');
  });

  it('switches tabs with the Tab key', async () => {
    const config = createConfig(
      createManager({ extensions: [mockExtension('alpha', true)] }),
    );
    const { stdin, lastFrame } = renderDialog(config);
    // Starts on Discover.
    await waitFor(() => {
      expect(lastFrame()).toContain('No plugins discovered');
    });
    stdin.write('\t'); // -> Installed
    await waitFor(() => {
      expect(lastFrame()).toContain('alpha');
    });
  });

  it('closes on Escape from a tab root', async () => {
    const onClose = vi.fn();
    const { stdin } = renderDialog(createConfig(createManager()), { onClose });
    await waitFor(() => {});
    stdin.write('\x1b'); // escape
    await waitFor(() => {
      expect(onClose).toHaveBeenCalled();
    });
  });

  it('does not close on Escape while a tab sub-view is open', async () => {
    const onClose = vi.fn();
    const manager = createManager();
    const { stdin, lastFrame } = renderDialog(createConfig(manager), {
      onClose,
      initialTab: EXTENSIONS_TABS.MARKETPLACES,
    });
    await waitFor(() => {
      expect(lastFrame()).toContain('Add new marketplace');
    });
    stdin.write('\r'); // Enter on the add row -> opens the add sub-view (locks tabs)
    await waitFor(() => {
      expect(lastFrame()).toContain('Enter marketplace source:');
    });
    stdin.write('\x1b'); // Escape should return to the list, not close the dialog
    await waitFor(() => {
      expect(lastFrame()).toContain('Add new marketplace');
    });
    expect(onClose).not.toHaveBeenCalled();
  });

  it('opens the add-marketplace input view on Enter', async () => {
    const { stdin, lastFrame } = renderDialog(createConfig(createManager()), {
      initialTab: EXTENSIONS_TABS.MARKETPLACES,
    });
    await waitFor(() => {
      expect(lastFrame()).toContain('Add new marketplace');
    });
    stdin.write('\r'); // Enter on add row
    await waitFor(() => {
      expect(lastFrame()).toContain('Add Marketplace');
    });
    // CC-style: prompt + examples list to guide the user.
    const frame = lastFrame();
    expect(frame).toContain('Enter marketplace source:');
    expect(frame).toContain('Examples:');
    expect(frame).toContain('owner/repo (GitHub)');
    expect(frame).toContain('git@github.com:owner/repo.git (SSH)');
    expect(frame).toContain('https://example.com/marketplace.json');
    expect(frame).toContain('./path/to/marketplace');
  });
});
