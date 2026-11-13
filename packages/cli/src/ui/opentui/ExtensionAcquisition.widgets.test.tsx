/** @jsxImportSource @opentui/react */
// @vitest-environment jsdom
/**
 * @license
 * Copyright 2026 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { act, type ComponentProps } from 'react';
import { cleanup, render, renderHook } from '@testing-library/react';
import { catalogKey } from '../../test-utils/opentui-catalog.js';
import type { ExtensionManager } from '@qwen-code/qwen-code-core/extension/extensionManager.js';

const native = vi.hoisted(() => ({
  keys: [] as Array<(e: unknown) => void>,
  pastes: [] as Array<(e: unknown) => void>,
  scroll: vi.fn(),
}));
async function jsxRuntime() {
  return (await import('../../test-utils/opentui-catalog.js')).catalogRuntime(
    true,
    native.scroll,
  );
}
vi.mock('@opentui/react/jsx-runtime', jsxRuntime);
vi.mock('@opentui/react/jsx-dev-runtime', jsxRuntime);
vi.mock(
  '@opentui/core',
  async () =>
    (await import('../../test-utils/opentui-catalog.js')).catalogNativeCore,
);
vi.mock('./theme.js', () => ({
  C: new Proxy({}, { get: () => '#fff' }),
  SYNTAX: {},
}));
vi.mock('@opentui/react', async () =>
  (await import('../../test-utils/opentui-catalog.js')).catalogHooks(
    native.keys,
    native.pastes,
    () => ({ width: 100, height: 40 }),
  ),
);
import {
  OpenTuiExtensionPermission,
  useExtensionAcquisition,
} from './ExtensionAcquisition.js';
type Permission = ComponentProps<
  typeof OpenTuiExtensionPermission
>['permission'];
function setting(sensitive = false): Extract<Permission, { kind: 'setting' }> {
  return {
    kind: 'setting',
    id: 1,
    setting: {
      name: 'Owned setting',
      description: 'Owned description',
      envVar: 'OWNED_VALUE',
      sensitive,
    },
    resolve: vi.fn(),
    cancel: vi.fn(),
  };
}
function choice(): Extract<Permission, { kind: 'choice' }> {
  return {
    kind: 'choice',
    id: 2,
    marketplace: {
      name: 'Owned',
      owner: { name: 'Owned', email: 'owned@example.invalid' },
      plugins: [
        { name: 'first', version: '1', source: './first' },
        { name: 'chosen', version: '1', source: './chosen' },
      ],
    },
    resolve: vi.fn(),
    cancel: vi.fn(),
  };
}
function widget(permission: Permission, width = 60, height = 30) {
  return (
    <OpenTuiExtensionPermission
      permission={permission}
      width={width}
      availableTerminalHeight={height}
    />
  );
}
async function key(
  name: string,
  sequence = name.length === 1 ? name : '',
  eventType = 'press',
) {
  await act(async () => {
    for (const fn of [...native.keys])
      fn(catalogKey(name, sequence, eventType));
  });
}
async function keys(...names: string[]) {
  for (const name of names) await key(name);
}
async function paste(text: string) {
  await act(async () => {
    for (const fn of [...native.pastes])
      fn({ bytes: new TextEncoder().encode(text), preventDefault() {} });
  });
}
beforeEach(() => {
  native.keys.length = 0;
  native.pastes.length = 0;
  native.scroll.mockClear();
});
afterEach(cleanup);

it('edits pasted setting text in the middle and submits its exact bytes once', async () => {
  const p = setting();
  const ui = render(widget(p));
  await paste('abcd');
  await keys('left', 'left', 'X');
  expect(ui.container.textContent).toContain('abXcd');
  expect(ui.container.querySelector('[data-caret]')?.textContent).toBe('c');
  await keys('return', 'return', 'escape');
  expect(p.resolve).toHaveBeenCalledExactlyOnceWith('abXcd');
  expect(p.cancel).not.toHaveBeenCalled();
});

it('masks sensitive pasted and typed input while retaining the actual edited value', async () => {
  const p = setting(true);
  const ui = render(widget(p));
  await paste('secret-value');
  await keys('left', 'X');
  expect(ui.container.textContent).not.toContain('secret');
  expect(ui.container.textContent).not.toContain('valu');
  expect(ui.container.textContent).not.toContain('X');
  expect(ui.container.textContent).toContain('*************');
  await key('return');
  expect(p.resolve).toHaveBeenCalledExactlyOnceWith('secret-valuXe');
});

it.each([
  { width: 7, height: 30 },
  { width: 60, height: 9 },
])(
  'does not submit a setting hidden by $width x $height, and recovers after resize',
  async ({ width, height }) => {
    const p = setting();
    const ui = render(widget(p, width, height));
    await paste('retained');
    await key('return');
    expect(p.resolve).not.toHaveBeenCalled();
    ui.rerender(widget(p));
    await key('return');
    expect(p.resolve).toHaveBeenCalledExactlyOnceWith('retained');
  },
);

it('cancels setting on Escape once and ignores later input/Enter', async () => {
  const p = setting();
  render(widget(p));
  await paste('not-accepted');
  await keys('escape', 'escape');
  await paste('later');
  await key('return');
  expect(p.cancel).toHaveBeenCalledTimes(1);
  expect(p.resolve).not.toHaveBeenCalled();
});

it('scrolls permission prose on presses only, without resolving or editing', async () => {
  const p = setting();
  render(widget(p));
  await key('pageup');
  await key('pageup', '', 'release');
  await key('pagedown');
  await key('pagedown', '', 'release');
  expect(native.scroll).toHaveBeenCalledTimes(2);
  expect(native.scroll.mock.calls[0][0]).toBeLessThan(0);
  expect(native.scroll.mock.calls[1][0]).toBe(-native.scroll.mock.calls[0][0]);
  expect(p.resolve).not.toHaveBeenCalled();
  expect(p.cancel).not.toHaveBeenCalled();
});

it('cannot select an invisible choice, then selects the visible nondefault plugin once', async () => {
  const p = choice();
  const ui = render(widget(p, 60, 8));
  await key('return');
  expect(p.resolve).not.toHaveBeenCalled();
  ui.rerender(widget(p));
  await keys('down', 'return', 'return');
  expect(p.resolve).toHaveBeenCalledExactlyOnceWith('chosen');
  expect(p.cancel).not.toHaveBeenCalled();
});

it('Escape cancels a plugin choice once, without selecting a fallback plugin', async () => {
  const p = choice();
  render(widget(p));
  await key('escape', '', 'release');
  expect(p.cancel).not.toHaveBeenCalled();
  await keys('escape', 'escape', 'return');
  expect(p.cancel).toHaveBeenCalledTimes(1);
  expect(p.resolve).not.toHaveBeenCalled();
});

it('matches Ink immediate digit selection even when the marketplace has more than nine plugins', async () => {
  const p = choice();
  p.marketplace.plugins = Array.from({ length: 12 }, (_, index) => ({
    name: `plugin-${index + 1}`,
    version: '1',
    source: `./plugin-${index + 1}`,
  }));
  const ui = render(widget(p, 60, 8));
  await key('9');
  expect(p.resolve).not.toHaveBeenCalled();
  ui.rerender(widget(p));
  await key('0');
  expect(p.resolve).not.toHaveBeenCalled();
  await key('9');
  expect(p.resolve).toHaveBeenCalledExactlyOnceWith('plugin-9');
  await key('1');
  expect(p.resolve).toHaveBeenCalledTimes(1);
});

it.each(['no', 'escape'] as const)(
  'real consent widget %s rejects the hook operation once without completing install',
  async (action) => {
    const committed = vi.fn();
    const rejected = vi.fn<(error: unknown) => void>();
    const reload = vi.fn(async () => {});
    const install = vi
      .fn<ExtensionManager['installExtension']>()
      .mockImplementation(async (_metadata, consent) => {
        await consent!({
          originSource: 'QwenCode',
          extensionConfig: { name: 'owned', version: '1' },
        });
        committed();
        return { name: 'owned' } as Awaited<
          ReturnType<ExtensionManager['installExtension']>
        >;
      });
    const context = {
      manager: {
        parseInstallSource: vi.fn(async () => ({
          source: './owned',
          type: 'local',
        })),
        installExtension: install,
      } as unknown as ExtensionManager,
      cwd: '/owned',
      isCurrent: () => true,
      reload,
      onChanged: vi.fn(),
      onStatus: vi.fn(),
    };
    const hook = renderHook(() => useExtensionAcquisition(context));
    let outcome!: Promise<void>;
    await act(async () => {
      outcome = hook.result.current
        .install('./owned', 'user', false)
        .then(() => {
          throw new Error('Unexpected acceptance');
        }, rejected);
    });
    const p = hook.result.current.permission;
    if (!p) throw new Error('Missing actual permission');
    render(widget(p));
    if (action === 'no') await key('down');
    await key(action === 'no' ? 'return' : 'escape');
    await key('escape');
    await act(async () => {
      await outcome;
    });
    expect(rejected).toHaveBeenCalledTimes(1);
    expect(committed).not.toHaveBeenCalled();
    expect(reload).not.toHaveBeenCalled();
    expect(hook.result.current.pending).toBe(false);
  },
);

it.each([
  { width: 7, height: 30 },
  { width: 60, height: 11 },
])(
  'does not approve consent outside its visible size boundary $width x $height',
  async ({ width, height }) => {
    const p = {
      kind: 'consent' as const,
      id: 3,
      text: 'Owned capability',
      resolve: vi.fn(),
    };
    const ui = render(widget(p, width, height));
    await key('return');
    expect(p.resolve).not.toHaveBeenCalled();
    ui.rerender(widget(p));
    await key('return');
    expect(p.resolve).toHaveBeenCalledWith(true);
  },
);
