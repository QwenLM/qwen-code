/** @jsxImportSource @opentui/react */
// @vitest-environment jsdom
/**
 * @license
 * Copyright 2026 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { cleanup, render, screen, waitFor } from '@testing-library/react';
import {
  catalogKey,
  catalogDeferred as deferred,
} from '../../test-utils/opentui-catalog.js';
import type { ExtensionManager } from '@qwen-code/qwen-code-core/extension/extensionManager.js';
import type { DiscoveredPlugin } from '@qwen-code/qwen-code-core/extension/sourceRegistry.js';
import type { ExtensionsStatusMessage } from './dialogs-extensions.js';
import type { OpenTuiExtensionDiscoverTabProps } from './ExtensionDiscoverTab.js';

const mocks = vi.hoisted(() => {
  const state = {
    keyboardHandlers: [] as Array<(event: unknown) => void>,
    pasteHandlers: [] as Array<(event: unknown) => void>,
    width: 100,
    height: 70,
  };
  return { state, open: vi.fn() };
});

vi.mock('open', () => ({ default: mocks.open }));
vi.mock(
  '@opentui/core',
  async () =>
    (await import('../../test-utils/opentui-catalog.js')).catalogNativeCore,
);
vi.mock('@opentui/react', async () =>
  (await import('../../test-utils/opentui-catalog.js')).catalogHooks(
    mocks.state.keyboardHandlers,
    mocks.state.pasteHandlers,
    () => ({ width: mocks.state.width, height: mocks.state.height }),
  ),
);
vi.mock('@opentui/react/jsx-runtime', async () =>
  (await import('../../test-utils/opentui-catalog.js')).catalogRuntime(false),
);
vi.mock('@opentui/react/jsx-dev-runtime', async () =>
  (await import('../../test-utils/opentui-catalog.js')).catalogRuntime(false),
);
vi.mock('./theme.js', () => ({ C: new Proxy({}, { get: () => '#ffffff' }) }));

import { OpenTuiExtensionDiscoverTab } from './ExtensionDiscoverTab.js';

function plugin(overrides: Partial<DiscoveredPlugin> = {}): DiscoveredPlugin {
  return {
    name: 'alpha',
    marketplaceName: 'market-a',
    description: 'Alpha description',
    installSource: `/fixtures/${overrides.marketplaceName ?? 'market-a'}:${overrides.name ?? 'alpha'}`,
    installed: false,
    ...overrides,
  };
}
const row = (name: string, marketplace: string, installed = false) =>
  new RegExp(`^${installed ? '✓' : '○'} ${name} · ${marketplace}`);
function managerFor(catalog: DiscoveredPlugin[]) {
  const discoverPlugins = vi.fn(
    async (_options: { refresh?: boolean; cwd?: string }) => catalog,
  );
  return {
    discoverPlugins,
    manager: { discoverPlugins } as unknown as ExtensionManager,
  };
}
function renderTab(overrides: Partial<OpenTuiExtensionDiscoverTabProps> = {}) {
  const fallback = managerFor([plugin()]);
  let props: OpenTuiExtensionDiscoverTabProps = {
    manager: fallback.manager,
    cwd: '/captured/workspace',
    availableTerminalHeight: 60,
    isActive: true,
    isCurrent: vi.fn(() => true),
    reloadSignal: 0,
    marketplaceFilter: null,
    onLockChange: vi.fn(),
    onStatus: vi.fn(),
    onInstalled: vi.fn(),
    onFooter: vi.fn(),
    install: vi.fn(async () => ({
      type: 'success' as const,
      text: 'Committed alpha.',
    })),
    ...overrides,
  };
  const rendered = render(<OpenTuiExtensionDiscoverTab {...props} />);
  return {
    ...rendered,
    get props() {
      return props;
    },
    update: (next: Partial<OpenTuiExtensionDiscoverTabProps>) => {
      props = { ...props, ...next };
      rendered.rerender(<OpenTuiExtensionDiscoverTab {...props} />);
    },
  };
}
async function press(
  name: string,
  sequence = name,
  extra: Record<string, unknown> = {},
) {
  await act(async () => {
    for (const handler of [...mocks.state.keyboardHandlers])
      handler({ ...catalogKey(name, sequence), ...extra });
  });
}
async function settle<T>(pending: ReturnType<typeof deferred<T>>, value: T) {
  await act(async () => {
    pending.resolve(value);
    await pending.promise;
  });
}
async function waitForRow(name: string, market: string, installed = false) {
  await waitFor(() =>
    expect(screen.getByText(row(name, market, installed))).toBeTruthy(),
  );
}

async function openDetail(name = 'alpha') {
  await waitForRow(name, 'market-a');
  await press('return');
  expect(screen.getByText('Extension details')).toBeTruthy();
  expect(screen.getByText(name)).toBeTruthy();
}

beforeEach(() => {
  mocks.state.keyboardHandlers.length = 0;
  mocks.state.pasteHandlers.length = 0;
  mocks.state.width = 100;
  mocks.state.height = 70;
  mocks.open.mockReset();
  mocks.open.mockResolvedValue(undefined);
});
afterEach(() => {
  cleanup();
  vi.unstubAllEnvs();
});

describe('OpenTuiExtensionDiscoverTab owned component wiring', () => {
  it.each(['manager', 'cwd', 'predicate'] as const)(
    'discards an old discover result after %s replacement',
    async (replacement) => {
      const old = deferred<DiscoveredPlugin[]>();
      const a = managerFor([]);
      a.discoverPlugins.mockImplementationOnce(() => old.promise);
      const b = managerFor([
        plugin({ name: 'successor', description: 'Successor description' }),
      ]);
      let oldCurrent = true;
      const originalPredicate = () => oldCurrent;
      const tab = renderTab({
        manager: a.manager,
        isCurrent: originalPredicate,
      });
      expect(screen.getByText('Discovering extensions...')).toBeTruthy();
      if (replacement === 'manager') tab.update({ manager: b.manager });
      else {
        a.discoverPlugins.mockResolvedValue([plugin({ name: 'successor' })]);
        if (replacement === 'cwd')
          tab.update({ cwd: '/captured/other-workspace' });
        else {
          oldCurrent = false;
          tab.update({ isCurrent: () => true });
        }
      }
      await waitForRow('successor', 'market-a');
      await settle(old, [plugin({ name: 'abandoned' })]);
      expect(screen.queryByText(row('abandoned', 'market-a'))).toBeNull();
      expect(screen.getByText(row('successor', 'market-a'))).toBeTruthy();
      expect(tab.props.onInstalled).not.toHaveBeenCalled();
      if (replacement === 'cwd')
        expect(a.discoverPlugins).toHaveBeenLastCalledWith({
          refresh: false,
          cwd: '/captured/other-workspace',
        });
    },
  );

  it('keeps the newest reload when two requests share the same current owner', async () => {
    const old = deferred<DiscoveredPlugin[]>();
    const service = managerFor([plugin({ name: 'newest' })]);
    service.discoverPlugins.mockImplementationOnce(() => old.promise);
    const tab = renderTab({ manager: service.manager });
    tab.update({ reloadSignal: 1 });
    await waitForRow('newest', 'market-a');
    await settle(old, [plugin({ name: 'superseded' })]);
    expect(screen.queryByText(row('superseded', 'market-a'))).toBeNull();
    expect(screen.getByText(row('newest', 'market-a'))).toBeTruthy();
    expect(service.discoverPlugins.mock.calls).toEqual([
      [{ refresh: false, cwd: '/captured/workspace' }],
      [{ refresh: false, cwd: '/captured/workspace' }],
    ]);
    expect(tab.props.onInstalled).not.toHaveBeenCalled();
  });

  it('does not publish a held install into a same-manager same-cwd replacement owner', async () => {
    const held = deferred<ExtensionsStatusMessage>();
    const service = managerFor([plugin()]);
    const install = vi.fn(() => held.promise);
    let current = true;
    const tab = renderTab({
      manager: service.manager,
      install,
      isCurrent: () => current,
    });
    await openDetail();
    await press('return');
    expect(screen.getByText('Installing...')).toBeTruthy();
    current = false;
    service.discoverPlugins.mockResolvedValue([plugin({ name: 'successor' })]);
    tab.update({ isCurrent: () => true, install: vi.fn() });
    await waitForRow('successor', 'market-a');
    vi.mocked(tab.props.onStatus).mockClear();
    await settle(held, {
      type: 'warning',
      text: 'OLD_OWNER_COMMITTED_WARNING',
    });
    expect(tab.props.onStatus).not.toHaveBeenCalled();
    expect(tab.props.onInstalled).not.toHaveBeenCalled();
    expect(screen.queryByText('OLD_OWNER_COMMITTED_WARNING')).toBeNull();
    expect(screen.getByText(row('successor', 'market-a'))).toBeTruthy();
    expect(screen.queryByText('Installing...')).toBeNull();
    expect(tab.props.onLockChange).toHaveBeenLastCalledWith(false);
  });

  it('keeps query and detail mounted while a permission body owns input', async () => {
    const service = managerFor([
      plugin({ name: 'jk-tool' }),
      plugin({ name: 'other' }),
    ]);
    const tab = renderTab({ manager: service.manager });
    await waitForRow('other', 'market-a');
    await press('j', 'j');
    await press('k', 'k');
    expect(screen.getByText(row('jk-tool', 'market-a'))).toBeTruthy();
    expect(screen.queryByText(row('other', 'market-a'))).toBeNull();
    await press('return');
    expect(screen.getByText('jk-tool')).toBeTruthy();
    tab.update({ isActive: false });
    expect(mocks.state.keyboardHandlers).toHaveLength(0);
    await press('escape');
    await press('return');
    await press('x', 'x');
    expect(tab.props.install).not.toHaveBeenCalled();
    expect(screen.getByText('Extension details')).toBeTruthy();
    tab.update({ isActive: true });
    await press('escape');
    expect(screen.getByText(row('jk-tool', 'market-a'))).toBeTruthy();
    expect(screen.queryByText(row('other', 'market-a'))).toBeNull();
    expect(mocks.state.keyboardHandlers).toHaveLength(1);
    expect(service.discoverPlugins).toHaveBeenCalledTimes(1);
  });

  it('treats j/k as search characters and edits a pasted query through the native field', async () => {
    const service = managerFor([plugin(), plugin({ name: 'jk-tool' })]);
    renderTab({ manager: service.manager });
    await waitForRow('alpha', 'market-a');
    const prevented = vi.fn();
    await act(async () => {
      for (const handler of mocks.state.pasteHandlers)
        handler({
          bytes: new TextEncoder().encode('j'),
          preventDefault: prevented,
        });
    });
    await press('k', 'k');
    expect(prevented).toHaveBeenCalledOnce();
    expect(screen.queryByText(row('alpha', 'market-a'))).toBeNull();
    await press('up');
    await press('down');
    await press('return');
    expect(screen.getByText('jk-tool')).toBeTruthy();
    await press('escape');
    await press('backspace', '\x7f');
    await press('backspace', '\x7f');
    expect(screen.getByText(row('alpha', 'market-a'))).toBeTruthy();
    expect(screen.getByText(row('jk-tool', 'market-a'))).toBeTruthy();
    expect(service.discoverPlugins).toHaveBeenCalledTimes(1);
  });

  it('keeps selections across filters and installs only their exact marketplace identities in project scope', async () => {
    const catalog = [
      plugin({ name: 'shared', installSource: '/fixtures/market-a:shared' }),
      plugin({
        name: 'shared',
        marketplaceName: 'market-b',
        installSource: '/fixtures/market-b:shared',
      }),
      plugin({
        name: 'broken',
        marketplaceName: 'market-c',
        installSource: '/fixtures/market-c:broken',
      }),
    ];
    const service = managerFor(catalog);
    let brokenAttempts = 0;
    const install = vi.fn(
      async (
        source: string,
        scope: 'user' | 'project',
      ): Promise<ExtensionsStatusMessage> => {
        expect(scope).toBe('project');
        const target = catalog.find((entry) => entry.installSource === source)!;
        if (target.name === 'broken' && ++brokenAttempts === 1)
          return { type: 'error', text: 'BROKEN_DOWNLOAD' };
        target.installed = true;
        return source.includes('market-a')
          ? { type: 'warning', text: 'COMMITTED_RELOAD_WARNING' }
          : { type: 'success', text: 'COMMITTED_B' };
      },
    );
    const tab = renderTab({
      manager: service.manager,
      install,
      marketplaceFilter: 'market-a',
    });
    await waitForRow('shared', 'market-a');
    await press('space', ' ');
    tab.update({ marketplaceFilter: 'market-b' });
    await press('space', ' ');
    tab.update({ marketplaceFilter: null });
    await press('down');
    await press('down');
    await press('space', ' ');
    await press('return');
    expect(
      screen.getByText('Install 3 extension(s) to which scope?'),
    ).toBeTruthy();
    await press('down');
    await press('return');
    await waitForRow('shared', 'market-a', true);
    expect(install.mock.calls).toEqual([
      ['/fixtures/market-a:shared', 'project'],
      ['/fixtures/market-b:shared', 'project'],
      ['/fixtures/market-c:broken', 'project'],
    ]);
    expect(screen.getByText(row('shared', 'market-b', true))).toBeTruthy();
    expect(screen.getByText(row('broken', 'market-c'))).toBeTruthy();
    expect(screen.queryByText(/^● /)).toBeNull();
    expect(screen.queryByText('Extension details')).toBeNull();
    expect(tab.props.onStatus).toHaveBeenLastCalledWith({
      type: 'error',
      text: 'Installed 2, failed 1: shared: COMMITTED_RELOAD_WARNING; broken: BROKEN_DOWNLOAD',
    });
    expect(service.discoverPlugins).toHaveBeenLastCalledWith({
      refresh: false,
      cwd: '/captured/workspace',
    });
    await press('return');
    expect(screen.getByText('broken')).toBeTruthy();
    expect(install).toHaveBeenCalledTimes(3);
    await press('down');
    await press('return');
    await waitForRow('broken', 'market-c', true);
    expect(install).toHaveBeenCalledTimes(4);
    expect(install).toHaveBeenLastCalledWith(
      '/fixtures/market-c:broken',
      'project',
    );
    expect(tab.props.onStatus).toHaveBeenLastCalledWith({
      type: 'success',
      text: 'Installed 1 extension(s).',
    });
  });

  it('retains a committed warning and installed UI when the final catalog reload fails', async () => {
    const service = managerFor([plugin()]);
    service.discoverPlugins
      .mockResolvedValueOnce([plugin()])
      .mockRejectedValueOnce(new Error('CATALOG_RELOAD_FAILED'));
    const install = vi.fn(
      async (): Promise<ExtensionsStatusMessage> => ({
        type: 'warning',
        text: 'COMMITTED_ARTIFACT',
      }),
    );
    const tab = renderTab({ manager: service.manager, install });
    await openDetail();
    await press('return');
    await waitForRow('alpha', 'market-a', true);
    expect(tab.props.onStatus).toHaveBeenLastCalledWith({
      type: 'warning',
      text: 'Installed 1 extension(s) with warnings: alpha: COMMITTED_ARTIFACT CATALOG_RELOAD_FAILED',
    });
    expect(tab.props.onInstalled).toHaveBeenCalledOnce();
    expect(install).toHaveBeenCalledWith('/fixtures/market-a:alpha', 'user');
    await press('return');
    expect(screen.queryByText('Install for you (user scope)')).toBeNull();
    expect(
      screen.queryByText('Install for the current workspace (project scope)'),
    ).toBeNull();
    expect(screen.getByText('Back to extension list')).toBeTruthy();
    expect(install).toHaveBeenCalledOnce();
  });

  it('keeps a failed detail on its original identity and requires an explicit retry', async () => {
    const service = managerFor([
      plugin(),
      plugin({ name: 'beta', installSource: '/fixtures/market-a:beta' }),
    ]);
    const install = vi.fn(
      async (): Promise<ExtensionsStatusMessage> => ({
        type: 'error',
        text: 'ALPHA_FAILED',
      }),
    );
    const tab = renderTab({ manager: service.manager, install });
    await openDetail();
    await press('return');
    await waitFor(() =>
      expect(tab.props.onStatus).toHaveBeenLastCalledWith({
        type: 'error',
        text: 'Installed 0, failed 1: alpha: ALPHA_FAILED',
      }),
    );
    expect(screen.getByText('Extension details')).toBeTruthy();
    expect(screen.getByText('alpha')).toBeTruthy();
    expect(screen.queryByText('beta')).toBeNull();
    expect(install).toHaveBeenCalledOnce();
    await press('return');
    await waitFor(() => expect(install).toHaveBeenCalledTimes(2));
    expect(install.mock.calls).toEqual([
      ['/fixtures/market-a:alpha', 'user'],
      ['/fixtures/market-a:alpha', 'user'],
    ]);
  });

  it('does not install after Escape cancels the scope picker', async () => {
    const tab = renderTab();
    await waitForRow('alpha', 'market-a');
    await press('space', ' ');
    await press('return');
    expect(screen.getByText('Project (Workspace)')).toBeTruthy();
    await press('escape');
    expect(screen.queryByText('Project (Workspace)')).toBeNull();
    expect(screen.getByText(/^● alpha · market-a/)).toBeTruthy();
    expect(tab.props.install).not.toHaveBeenCalled();
    expect(tab.props.onLockChange).toHaveBeenLastCalledWith(false);
  });

  it('deduplicates Ctrl+R while refreshing and recovers from a genuine discovery error', async () => {
    const pending = deferred<DiscoveredPlugin[]>();
    const service = managerFor([plugin()]);
    service.discoverPlugins
      .mockRejectedValueOnce(new Error('INITIAL_CATALOG_FAILED'))
      .mockImplementationOnce(() => pending.promise);
    const tab = renderTab({ manager: service.manager });
    await waitFor(() =>
      expect(tab.props.onStatus).toHaveBeenLastCalledWith({
        type: 'error',
        text: 'INITIAL_CATALOG_FAILED',
      }),
    );
    expect(screen.getByText('No extensions discovered.')).toBeTruthy();
    await press('r', '\x12', { ctrl: true });
    await press('r', '\x12', { ctrl: true });
    expect(screen.getByText('Discovering extensions...')).toBeTruthy();
    expect(service.discoverPlugins.mock.calls).toEqual([
      [{ refresh: false, cwd: '/captured/workspace' }],
      [{ refresh: true, cwd: '/captured/workspace' }],
    ]);
    await settle(pending, [plugin({ name: 'fresh' })]);
    expect(screen.getByText(row('fresh', 'market-a'))).toBeTruthy();
    expect(tab.props.onStatus).toHaveBeenLastCalledWith({
      type: 'success',
      text: 'Refreshed 1 extension(s).',
    });
  });

  it.each(['file:///private/secret', 'javascript:alert(1)', 'not-a-url'])(
    'rejects unsafe homepage %s before the test-mode branch',
    async (homepage) => {
      vi.stubEnv('NODE_ENV', 'test');
      const service = managerFor([plugin({ installed: true, homepage })]);
      const tab = renderTab({ manager: service.manager });
      await waitForRow('alpha', 'market-a', true);
      await press('return');
      await press('return');
      expect(mocks.open).not.toHaveBeenCalled();
      expect(tab.props.onStatus).toHaveBeenLastCalledWith({
        type: 'error',
        text: `Failed to open ${homepage}`,
      });
    },
  );

  it('opens an allowed HTTPS homepage through the actual action while retaining detail', async () => {
    vi.stubEnv('NODE_ENV', 'development');
    const service = managerFor([
      plugin({ installed: true, homepage: 'https://example.test/plugin' }),
    ]);
    const tab = renderTab({ manager: service.manager });
    await waitForRow('alpha', 'market-a', true);
    await press('return');
    await press('return');
    expect(mocks.open).toHaveBeenCalledExactlyOnceWith(
      'https://example.test/plugin',
    );
    expect(screen.getByText('Extension details')).toBeTruthy();
    expect(tab.props.install).not.toHaveBeenCalled();
  });

  it('does not commit an unpainted row when the available region has no list capacity', async () => {
    const service = managerFor([plugin()]);
    const tab = renderTab({
      manager: service.manager,
      availableTerminalHeight: 8,
    });
    await waitFor(() =>
      expect(screen.queryByText('Discovering extensions...')).toBeNull(),
    );
    expect(screen.queryByText(row('alpha', 'market-a'))).toBeNull();
    await press('return');
    await press('space', ' ');
    expect(screen.queryByText('Extension details')).toBeNull();
    expect(tab.props.install).not.toHaveBeenCalled();
    tab.update({ availableTerminalHeight: 60 });
    expect(screen.getByText(row('alpha', 'market-a'))).toBeTruthy();
    await press('return');
    expect(screen.getByText('alpha')).toBeTruthy();
    expect(service.discoverPlugins).toHaveBeenCalledOnce();
  });

  it('unmounts a pending catalog without publishing callbacks from its later failure', async () => {
    const pending = deferred<DiscoveredPlugin[]>();
    const service = managerFor([]);
    service.discoverPlugins.mockImplementationOnce(() => pending.promise);
    const tab = renderTab({ manager: service.manager });
    tab.unmount();
    vi.mocked(tab.props.onStatus).mockClear();
    await act(async () => {
      pending.reject(new Error('OLD_UNMOUNTED_FETCH'));
      await pending.promise.catch(() => {});
    });
    expect(tab.props.onStatus).not.toHaveBeenCalled();
    expect(tab.props.onInstalled).not.toHaveBeenCalled();
    expect(mocks.state.keyboardHandlers).toEqual([]);
    expect(mocks.state.pasteHandlers).toEqual([]);
  });
});
