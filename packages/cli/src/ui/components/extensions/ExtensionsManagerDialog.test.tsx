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
  ExtensionSource,
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
  sources?: ExtensionSource[];
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
    isFavorite: vi.fn((name: string) => (o.favorites ?? []).includes(name)),
    getExtensionScope: vi.fn((name: string) => o.scopes?.[name] ?? 'user'),
    getSources: vi.fn(() => o.sources ?? []),
    discoverPlugins: vi.fn().mockResolvedValue(o.discovered ?? []),
    toggleFavorite: vi.fn(() => true),
    setExtensionScope: vi.fn(),
    enableExtension: vi.fn().mockResolvedValue(undefined),
    disableExtension: vi.fn().mockResolvedValue(undefined),
    uninstallExtension: vi.fn().mockResolvedValue(undefined),
    checkForAllExtensionUpdates: vi.fn().mockResolvedValue(undefined),
    updateExtension: vi.fn().mockResolvedValue(undefined),
    addSource: vi.fn(),
    removeSource: vi.fn(() => true),
    loadSource: vi.fn().mockResolvedValue(null),
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
    expect(frame).toContain('Sources');
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
      { initialTab: EXTENSIONS_TABS.DISCOVER },
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
      { initialTab: EXTENSIONS_TABS.DISCOVER },
    );
    await waitFor(() => {
      expect(lastFrame()).toContain('42crunch-api-security-testing');
    });
    stdin.write('\r'); // Enter -> detail
    await waitFor(() => {
      expect(lastFrame()).toContain('Extension details');
    });
    const frame = lastFrame();
    expect(frame).toContain('from claude-plugins-official');
    expect(frame).toContain('By: 42Crunch');
    expect(frame).toContain('Will install:');
    expect(frame).toContain('42crunch-audit');
    // Inline action selector with the two scopes + homepage + back.
    expect(frame).toContain('Install for you (user scope)');
    expect(frame).toContain('project scope');
    expect(frame).toContain('Open homepage');
    expect(frame).toContain('Back to extension list');
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
      { initialTab: EXTENSIONS_TABS.DISCOVER },
    );
    await waitFor(() => {
      expect(lastFrame()).toContain('plugin-0');
    });
    const frame = lastFrame();
    expect(frame).toContain('Discover extensions');
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
      { initialTab: EXTENSIONS_TABS.DISCOVER },
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
    const { lastFrame } = renderDialog(createConfig(createManager()), {
      initialTab: EXTENSIONS_TABS.DISCOVER,
    });
    await waitFor(() => {
      expect(lastFrame()).toContain('No extensions discovered');
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
    expect(frame).toContain('User level');
    expect(frame).toContain('Disabled');
    expect(frame).toContain('beta');
    // Plugins show their type + version (parallel to "MCP"), not a bare version.
    expect(frame).toContain('Extension v1.0.0');
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

  it('shows the install/add actions and grouped sections on the Marketplaces tab', async () => {
    const config = createConfig(
      createManager({
        sources: [
          { name: 'Skills', source: 'anthropics/skills', type: 'github' },
        ],
      }),
    );
    const { lastFrame } = renderDialog(config, {
      initialTab: EXTENSIONS_TABS.SOURCES,
    });
    await waitFor(() => {
      expect(lastFrame()).toContain('Add new marketplace');
    });
    const frame = lastFrame();
    // 'Add new' is the section title for the action rows; it also appears inside
    // '+ Add new marketplace', so assert it renders at least twice (title + row).
    expect((frame?.split('Add new').length ?? 1) - 1).toBeGreaterThanOrEqual(2);
    expect(frame).toContain('Install a new extension');
    expect(frame).toContain('Claude plugin marketplace'); // (Claude) annotation
    expect(frame).toContain('Marketplaces'); // section header
    expect(frame).toContain('Skills');
  });

  it('shows a CC-style marketplace detail with installed plugins and actions', async () => {
    const manager = createManager({
      extensions: [mockExtension('pdf', true)], // installed, belongs to Skills
      sources: [
        { name: 'Skills', source: 'anthropics/skills', type: 'github' },
      ],
    });
    manager.loadSource = vi.fn().mockResolvedValue({
      name: 'Skills',
      owner: { name: 'o', email: 'e' },
      plugins: [
        { name: 'pdf', version: '1', description: 'PDF tools', source: 'a/s' },
        { name: 'docx', version: '1', source: 'a/s' },
      ],
    });
    const { stdin, lastFrame } = renderDialog(createConfig(manager), {
      initialTab: EXTENSIONS_TABS.SOURCES,
    });
    // Wait until the list has loaded (and the keypress handler re-subscribed).
    await waitFor(() => {
      expect(lastFrame()).toContain('Skills');
    });
    // Installed extensions are not listed here; rows are:
    // Install ext (0), Add marketplace (1), Skills (2).
    stdin.write('\x1B[B');
    stdin.write('\x1B[B');
    await waitFor(() => {
      expect(lastFrame()).toContain('● Skills');
    });
    stdin.write('\r'); // Enter -> open detail
    await waitFor(() => {
      expect(lastFrame()).toContain('available extensions');
    });
    const frame = lastFrame();
    expect(frame).toContain('2 available extensions');
    // The detail still reflects which of this marketplace's plugins are
    // installed, even though the tab list no longer shows extensions.
    expect(frame).toContain('Installed extensions (1):');
    expect(frame).toContain('pdf');
    expect(frame).toContain('Browse extensions (2)');
    expect(frame).toContain('Update marketplace');
    expect(frame).toContain('Remove marketplace');
    // The footer advertises the R refresh shortcut once the detail has loaded.
    expect(frame).toContain('R refresh');
  });

  it('collapses a long installed-plugins list in the marketplace detail', async () => {
    const installed = Array.from({ length: 8 }, (_, i) =>
      mockExtension(`ext-${i}`, true),
    );
    const manager = createManager({
      extensions: installed,
      sources: [
        { name: 'Skills', source: 'anthropics/skills', type: 'github' },
      ],
    });
    manager.loadSource = vi.fn().mockResolvedValue({
      name: 'Skills',
      owner: { name: 'o', email: 'e' },
      plugins: installed.map((ext) => ({
        name: ext.name,
        version: '1',
        source: 'a/s',
      })),
    });
    const { stdin, lastFrame } = renderDialog(createConfig(manager), {
      initialTab: EXTENSIONS_TABS.SOURCES,
    });
    await waitFor(() => {
      expect(lastFrame()).toContain('Skills');
    });
    stdin.write('\x1B[B');
    stdin.write('\x1B[B');
    await waitFor(() => {
      expect(lastFrame()).toContain('● Skills');
    });
    stdin.write('\r'); // open detail
    await waitFor(() => {
      expect(lastFrame()).toContain('Installed extensions (8):');
    });
    const frame = lastFrame();
    // First five are shown; the rest collapse into a summary line.
    expect(frame).toContain('ext-0');
    expect(frame).toContain('ext-4');
    expect(frame).not.toContain('ext-5');
    expect(frame).toContain('and 3 more');
  });

  it('retries a failed marketplace load when R is pressed', async () => {
    const manager = createManager({
      sources: [
        { name: 'Skills', source: 'anthropics/skills', type: 'github' },
      ],
    });
    // First load fails (null), retry succeeds.
    manager.loadSource = vi
      .fn()
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({
        name: 'Skills',
        owner: { name: 'o', email: 'e' },
        plugins: [{ name: 'pdf', version: '1', source: 'a/s' }],
      });
    const { stdin, lastFrame } = renderDialog(createConfig(manager), {
      initialTab: EXTENSIONS_TABS.SOURCES,
    });
    await waitFor(() => {
      expect(lastFrame()).toContain('Skills');
    });
    stdin.write('\x1B[B');
    stdin.write('\x1B[B');
    await waitFor(() => {
      expect(lastFrame()).toContain('● Skills');
    });
    stdin.write('\r'); // open detail -> first load fails
    await waitFor(() => {
      expect(lastFrame()).toContain('Could not load this marketplace.');
    });
    // The retry hint shows both inline and in the bottom footer.
    expect((lastFrame()?.split('Press R to retry').length ?? 1) - 1).toBe(2);
    stdin.write('r'); // retry -> second load succeeds
    await waitFor(() => {
      expect(lastFrame()).toContain('1 available extensions');
    });
    expect(manager.loadSource).toHaveBeenCalledTimes(2);
  });

  it('Browse plugins jumps to Discover filtered by the marketplace', async () => {
    const manager = createManager({
      sources: [
        { name: 'Skills', source: 'anthropics/skills', type: 'github' },
      ],
      discovered: [
        {
          marketplaceName: 'Skills',
          name: 'pdf',
          installSource: 'a/s:pdf',
          installed: false,
        },
        {
          marketplaceName: 'Skills',
          name: 'docx',
          installSource: 'a/s:docx',
          installed: false,
        },
        {
          marketplaceName: 'Other',
          name: 'zzz',
          installSource: 'o/o:zzz',
          installed: false,
        },
      ],
    });
    manager.loadSource = vi.fn().mockResolvedValue({
      name: 'Skills',
      owner: { name: 'o', email: 'e' },
      plugins: [
        { name: 'pdf', version: '1', source: 'a/s' },
        { name: 'docx', version: '1', source: 'a/s' },
      ],
    });
    const { stdin, lastFrame } = renderDialog(createConfig(manager), {
      initialTab: EXTENSIONS_TABS.SOURCES,
    });
    await waitFor(() => {
      expect(lastFrame()).toContain('Skills'); // list loaded
    });
    // Rows: Install ext (0), Add marketplace (1), Skills (2).
    stdin.write('\x1B[B');
    stdin.write('\x1B[B');
    await waitFor(() => {
      expect(lastFrame()).toContain('● Skills');
    });
    stdin.write('\r'); // Enter -> detail
    await waitFor(() => {
      expect(lastFrame()).toContain('Browse extensions (2)');
    });
    stdin.write('\r'); // select "Browse extensions" -> Discover filtered
    await waitFor(() => {
      expect(lastFrame()).toContain('Discover extensions');
    });
    const frame = lastFrame();
    // Filtered to the Skills marketplace: its extensions show, the other not.
    expect(frame).toContain('Skills');
    expect(frame).toContain('pdf');
    expect(frame).toContain('docx');
    expect(frame).not.toContain('zzz');
  });

  it('switches tabs with the Tab key', async () => {
    const config = createConfig(
      createManager({ extensions: [mockExtension('alpha', true)] }),
    );
    const { stdin, lastFrame } = renderDialog(config);
    // Starts on Installed (first tab).
    await waitFor(() => {
      expect(lastFrame()).toContain('alpha');
    });
    stdin.write('\t'); // -> Discover
    await waitFor(() => {
      expect(lastFrame()).toContain('No extensions discovered');
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
      initialTab: EXTENSIONS_TABS.SOURCES,
    });
    await waitFor(() => {
      expect(lastFrame()).toContain('Install a new extension');
    });
    stdin.write('\r'); // Enter on row 0 -> install-extension sub-view (locks tabs)
    await waitFor(() => {
      expect(lastFrame()).toContain('Enter extension source:');
    });
    stdin.write('\x1b'); // Escape should return to the list, not close the dialog
    await waitFor(() => {
      expect(lastFrame()).toContain('Install a new extension');
    });
    expect(onClose).not.toHaveBeenCalled();
  });

  it('opens the install-extension input view on Enter', async () => {
    const { stdin, lastFrame } = renderDialog(createConfig(createManager()), {
      initialTab: EXTENSIONS_TABS.SOURCES,
    });
    await waitFor(() => {
      expect(lastFrame()).toContain('Install a new extension');
    });
    stdin.write('\r'); // Enter on the first row (Install a new extension)
    await waitFor(() => {
      expect(lastFrame()).toContain('Install Extension');
    });
    const frame = lastFrame();
    expect(frame).toContain('Enter extension source:');
    expect(frame).toContain('owner/repo (GitHub)');
    expect(frame).toContain('@scope/name (npm)');
  });

  it('renders a pending install consent prompt in place of the tabs', async () => {
    const uiState = {
      extensionsUpdateState: new Map<string, ExtensionUpdateState>(),
      confirmUpdateExtensionRequests: [
        { prompt: 'Do you trust this extension?', onConfirm: vi.fn() },
      ],
      settingInputRequests: [],
      pluginChoiceRequests: [],
    } as unknown as UIState;
    const { lastFrame } = renderDialog(createConfig(createManager()), {
      initialTab: EXTENSIONS_TABS.DISCOVER,
      uiState,
    });
    await waitFor(() => {
      expect(lastFrame()).toContain('Do you trust this extension?');
    });
    // The tab content is hidden while the prompt is shown, but the dialog
    // (and its tab state) stays mounted.
    expect(lastFrame()).not.toContain('Discover extensions');
  });
});
