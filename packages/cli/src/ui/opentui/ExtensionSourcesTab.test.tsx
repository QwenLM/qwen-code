/** @jsxImportSource @opentui/react */
// @vitest-environment jsdom
/**
 * @license
 * Copyright 2026 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act } from 'react';
import { cleanup, render, screen } from '@testing-library/react';
import {
  catalogKey,
  catalogDeferred as deferred,
} from '../../test-utils/opentui-catalog.js';
import type { ExtensionManager } from '@qwen-code/qwen-code-core/extension/extensionManager.js';

const mocks = vi.hoisted(() => {
  const state = {
    keyboard: [] as Array<(event: unknown) => void>,
    paste: [] as Array<(event: unknown) => void>,
    width: 100,
  };
  return { state };
});

vi.mock(
  '@opentui/core',
  async () =>
    (await import('../../test-utils/opentui-catalog.js')).catalogNativeCore,
);
vi.mock('@opentui/react', async () =>
  (await import('../../test-utils/opentui-catalog.js')).catalogHooks(
    mocks.state.keyboard,
    mocks.state.paste,
    () => ({ width: mocks.state.width, height: 40 }),
  ),
);
vi.mock('@opentui/react/jsx-runtime', async () =>
  (await import('../../test-utils/opentui-catalog.js')).catalogRuntime(true),
);
vi.mock('@opentui/react/jsx-dev-runtime', async () =>
  (await import('../../test-utils/opentui-catalog.js')).catalogRuntime(true),
);
vi.mock('./theme.js', () => ({ C: new Proxy({}, { get: () => '#ffffff' }) }));

import {
  OpenTuiExtensionSourcesTab,
  type OpenTuiExtensionSourcesTabProps,
} from './ExtensionSourcesTab.js';

type Source = ReturnType<ExtensionManager['getSources']>[number];
const source = (name: string): Source => ({
  name,
  source: `/owned/${name}`,
  type: 'local',
  addedAt: '2026-10-24T00:00:00Z',
});
const marketplace = {
  name: 'alpha',
  owner: { name: 'Owned', email: 'owned@example.invalid' },
  plugins: [],
};

async function press(...names: string[]) {
  for (const name of names)
    await act(async () => {
      const event = catalogKey(name, name.length === 1 ? name : '');
      for (const handler of [...mocks.state.keyboard]) handler(event);
    });
}
async function paste(text: string) {
  await act(async () => {
    const event = {
      bytes: new TextEncoder().encode(text),
      preventDefault() {},
    };
    for (const handler of [...mocks.state.paste]) handler(event);
  });
}
async function submitSource(value: string, direction?: 'up' | 'down') {
  if (direction) await press(direction);
  await press('return');
  await paste(value);
  await press('return');
}

function fixture(initial: Source[] = []) {
  let sources = initial;
  const methods = {
    refreshCache: vi.fn(async () => {}),
    getSources: vi.fn(() => sources),
    getLoadedExtensions: vi.fn(() => []),
    addSource: vi.fn(async (_value: string, _options: { cwd: string }) => {
      const added = source('added');
      sources = [...sources, added];
      return added;
    }),
    loadSource: vi.fn(
      async (_value: string, _options: { cwd: string }) =>
        marketplace as typeof marketplace | null,
    ),
    markSourceUpdated: vi.fn((name: string) => {
      const updated = {
        ...source(name),
        lastUpdatedAt: '2026-10-24T01:00:00Z',
      };
      sources = sources.map((entry) => (entry.name === name ? updated : entry));
      return updated;
    }),
    removeSource: vi.fn((_name: string) => true),
  };
  const props: OpenTuiExtensionSourcesTabProps = {
    manager: methods as unknown as ExtensionManager,
    cwd: '/owned/workspace',
    isActive: true,
    isCurrent: () => true,
    reloadSignal: 0,
    availableTerminalHeight: 30,
    onLockChange: vi.fn(),
    onStatus: vi.fn(),
    onChanged: vi.fn(),
    onBrowse: vi.fn(),
    onFooter: vi.fn(),
    install: vi.fn(async () => ({
      type: 'success' as const,
      text: 'Installed',
    })),
  };
  return {
    methods,
    props,
    replaceSources(next: Source[]) {
      sources = next;
    },
  };
}
async function mount(props: OpenTuiExtensionSourcesTabProps) {
  const rendered = render(<OpenTuiExtensionSourcesTab {...props} />);
  await act(async () => {});
  return rendered;
}
async function openSource(index = 0) {
  // Disabled headings are skipped: Install -> Add -> first source.
  for (let n = 0; n < index + 2; n++) await press('down');
  await press('return');
}

beforeEach(() => {
  mocks.state.keyboard.length = 0;
  mocks.state.paste.length = 0;
  mocks.state.width = 100;
});
afterEach(cleanup);

describe('OpenTuiExtensionSourcesTab', () => {
  it('adds with the explicit cwd and keeps Add selected after refresh', async () => {
    const f = fixture();
    await mount(f.props);
    await submitSource('  ./marketplace  ', 'down');
    expect(f.methods.addSource).toHaveBeenCalledExactlyOnceWith(
      './marketplace',
      { cwd: '/owned/workspace' },
    );
    expect(f.props.install).not.toHaveBeenCalled();
    // Reload must not silently reset selection to Install or skip the new row.
    await press('down', 'return');
    expect(f.methods.loadSource).toHaveBeenCalledExactlyOnceWith(
      '/owned/added',
      { cwd: '/owned/workspace' },
    );
    await press('return');
    expect(f.props.onBrowse).toHaveBeenCalledExactlyOnceWith('added');
  });

  it('delegates direct installation only to the parent with user scope', async () => {
    const f = fixture();
    await mount(f.props);
    await submitSource('./owned-extension');
    expect(f.props.install).toHaveBeenCalledExactlyOnceWith(
      './owned-extension',
      'user',
    );
    expect(f.methods.addSource).not.toHaveBeenCalled();
    expect(f.props.onChanged).toHaveBeenCalledTimes(1);
  });

  it('re-arms the same input after a rejected installation promise', async () => {
    const f = fixture();
    const install = vi
      .fn()
      .mockRejectedValueOnce(new Error('Permission denied'))
      .mockResolvedValueOnce({ type: 'success', text: 'Installed' });
    await mount({ ...f.props, install });
    await submitSource('./retained');
    expect(f.props.onStatus).toHaveBeenLastCalledWith({
      type: 'error',
      text: 'Permission denied',
    });
    expect(f.props.onChanged).not.toHaveBeenCalled();
    await press('return');
    expect(install.mock.calls).toEqual([
      ['./retained', 'user'],
      ['./retained', 'user'],
    ]);
    expect(f.props.onChanged).toHaveBeenCalledTimes(1);
  });

  it('R retries loading without stamping an update, including a null result', async () => {
    const sourcePath =
      '/owned/' + 'long-marketplace-directory/'.repeat(8) + 'alpha';
    const f = fixture([{ ...source('alpha'), source: sourcePath }]);
    f.methods.loadSource
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(null);
    await mount(f.props);
    expect.soft(screen.queryByText(/\(local\)/)).not.toBeNull();
    await openSource();
    expect.soft(screen.queryByText(sourcePath)).not.toBeNull();
    expect(screen.getByText('Could not load this marketplace.')).toBeTruthy();
    await press('r');
    expect(screen.getByText('Could not load this marketplace.')).toBeTruthy();
    expect(f.methods.markSourceUpdated).not.toHaveBeenCalled();
    await press('r');
    expect(screen.getByText('0 available extensions')).toBeTruthy();
    expect(f.methods.loadSource).toHaveBeenCalledTimes(3);
    expect(f.methods.markSourceUpdated).not.toHaveBeenCalled();
    expect(f.props.onChanged).not.toHaveBeenCalled();
  });

  it('does not timestamp a failed Update and timestamps only a successful Update', async () => {
    const f = fixture([source('alpha')]);
    f.methods.loadSource
      .mockResolvedValueOnce(marketplace)
      .mockResolvedValueOnce(null);
    await mount(f.props);
    await openSource();
    await press('down', 'return');
    expect(f.methods.markSourceUpdated).not.toHaveBeenCalled();
    expect(f.props.onStatus).toHaveBeenLastCalledWith({
      type: 'error',
      text: 'Could not update marketplace "alpha".',
    });
    await press('r', 'escape', 'return');
    // Detail re-entry selects Browse, rather than retaining the old Update row.
    await press('return');
    expect(f.props.onBrowse).toHaveBeenCalledExactlyOnceWith('alpha');
    expect(f.methods.markSourceUpdated).not.toHaveBeenCalled();
    await press('return', 'down', 'return');
    expect(f.methods.markSourceUpdated).toHaveBeenCalledExactlyOnceWith(
      'alpha',
    );
    expect(f.props.onChanged).toHaveBeenCalledTimes(1);
  });

  it('contains a thrown remove failure and leaves the list usable', async () => {
    const f = fixture([source('alpha')]);
    f.methods.removeSource.mockImplementationOnce(() => {
      throw new Error('Read-only registry');
    });
    await mount(f.props);
    await press('down', 'down', 'd', 'y');
    expect(f.methods.removeSource).toHaveBeenCalledExactlyOnceWith('alpha');
    expect(f.props.onStatus).toHaveBeenLastCalledWith({
      type: 'error',
      text: 'Read-only registry',
    });
    expect(f.props.onChanged).not.toHaveBeenCalled();
    await press('return');
    expect(f.methods.loadSource).toHaveBeenCalledTimes(1);
  });

  it('retains a pending operation while the permission overlay deactivates the tab', async () => {
    const f = fixture();
    const pending = deferred<{ type: 'success'; text: string }>();
    const install = vi.fn(() => pending.promise);
    const props = { ...f.props, install };
    const ui = await mount(props);
    await submitSource('./permission-owned');
    expect(mocks.state.keyboard).toHaveLength(1);
    ui.rerender(<OpenTuiExtensionSourcesTab {...props} isActive={false} />);
    expect(mocks.state.keyboard).toHaveLength(0);
    await press('escape');
    await paste('not-owned');
    await act(async () => {
      pending.resolve({ type: 'success', text: 'Installed after consent' });
    });
    expect(install).toHaveBeenCalledExactlyOnceWith(
      './permission-owned',
      'user',
    );
    expect(f.props.onChanged).toHaveBeenCalledTimes(1);
    expect(f.props.onStatus).toHaveBeenLastCalledWith({
      type: 'success',
      text: 'Installed after consent',
    });
    ui.rerender(<OpenTuiExtensionSourcesTab {...props} />);
    expect(mocks.state.keyboard).toHaveLength(2);
    expect(screen.getByText('+ Install a new extension')).toBeTruthy();
  });

  it('does not let a replaced owner settle or unlock the successor operation', async () => {
    const f = fixture();
    const old = deferred<Source>();
    const next = deferred<{ type: 'success'; text: string }>();
    f.methods.addSource.mockImplementationOnce(() => old.promise);
    const install = vi.fn(() => next.promise);
    const props = { ...f.props, install };
    const ui = await mount(props);
    await submitSource('./old', 'down');
    const successor = { ...props, isCurrent: () => true };
    ui.rerender(<OpenTuiExtensionSourcesTab {...successor} />);
    await submitSource('./new', 'up');
    await act(async () => {
      old.resolve(source('old'));
    });
    expect(f.props.onChanged).not.toHaveBeenCalled();
    expect(screen.getByText('Installing...')).toBeTruthy();
    await press('return');
    expect(install).toHaveBeenCalledExactlyOnceWith('./new', 'user');
    await act(async () => {
      next.resolve({ type: 'success', text: 'Current installed' });
    });
    expect(f.props.onChanged).toHaveBeenCalledTimes(1);
    expect(f.props.onStatus).toHaveBeenLastCalledWith({
      type: 'success',
      text: 'Current installed',
    });
  });

  it('follows the source key across a reordered reload', async () => {
    const f = fixture([source('alpha'), source('beta')]);
    const ui = await mount(f.props);
    await press('down', 'down', 'down');
    f.replaceSources([source('beta'), source('alpha')]);
    ui.rerender(<OpenTuiExtensionSourcesTab {...f.props} reloadSignal={1} />);
    await act(async () => {});
    await press('return');
    expect(f.methods.loadSource).toHaveBeenCalledExactlyOnceWith(
      '/owned/beta',
      { cwd: '/owned/workspace' },
    );
  });

  it('does not submit a hidden input or confirm a hidden removal', async () => {
    const f = fixture([source('alpha')]);
    const ui = await mount(f.props);
    await press('down', 'return');
    await paste('./visible');
    ui.rerender(
      <OpenTuiExtensionSourcesTab {...f.props} availableTerminalHeight={10} />,
    );
    await paste('/hidden');
    await press('return');
    expect(f.methods.addSource).not.toHaveBeenCalled();
    ui.rerender(<OpenTuiExtensionSourcesTab {...f.props} />);
    await press('return');
    expect(f.methods.addSource).toHaveBeenCalledExactlyOnceWith('./visible', {
      cwd: '/owned/workspace',
    });
    await press('down', 'd');
    ui.rerender(
      <OpenTuiExtensionSourcesTab {...f.props} availableTerminalHeight={9} />,
    );
    await press('y');
    expect(f.methods.removeSource).not.toHaveBeenCalled();
    ui.rerender(<OpenTuiExtensionSourcesTab {...f.props} />);
    await press('y');
    expect(f.methods.removeSource).toHaveBeenCalledExactlyOnceWith('alpha');
  });

  it('shows the long-input tail and caret, and submits an actual middle edit', async () => {
    mocks.state.width = 42;
    const f = fixture();
    const ui = await mount(f.props);
    await press('down', 'return');
    const value =
      '/owned/very-long-marketplace-directory/child/TAIL-9876543210';
    await paste(value);
    const caret = () => ui.container.querySelector('[data-caret="true"]');
    expect(caret()?.textContent).toBe(' ');
    expect(caret()?.parentElement?.textContent).toContain('TAIL-9876543210');
    for (let n = 0; n < 5; n++) await press('left');
    expect(caret()?.textContent).toBe('4');
    await press('X');
    expect(caret()?.parentElement?.textContent).toContain('TAIL-98765X43210');
    await press('return');
    expect(f.methods.addSource).toHaveBeenCalledExactlyOnceWith(
      '/owned/very-long-marketplace-directory/child/TAIL-98765X43210',
      { cwd: '/owned/workspace' },
    );
  });
});
