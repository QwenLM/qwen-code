/**
 * @license
 * Copyright 2026 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import { render, cleanup } from 'ink-testing-library';
import { afterEach, expect, it, vi } from 'vitest';
import { act } from 'react';
import type { Key } from '../hooks/useKeypress.js';
import { DialogSizeProvider } from '../contexts/DialogSizeContext.js';
import { PermissionsDialog } from './PermissionsDialog.js';

const { select, keys } = vi.hoisted(() => ({
  select: vi.fn((_props: unknown) => null),
  keys: vi.fn(),
}));
vi.mock('../hooks/useKeypress.js', () => ({ useKeypress: keys }));
vi.mock('./shared/RadioButtonSelect.js', () => ({ RadioButtonSelect: select }));
vi.mock('../contexts/ConfigContext.js', () => ({
  useConfig: () => ({
    getPermissionManager: () => null,
    getWorkspaceContext: () => ({
      getDirectories: () => [],
      getInitialDirectories: () => [],
    }),
  }),
}));
vi.mock('../contexts/SettingsContext.js', () => ({ useSettings: () => ({}) }));

afterEach(cleanup);

it('R3-8 keeps the append and backspace end of a long search visible', async () => {
  const view = render(
    <DialogSizeProvider value={{ columns: 60, rows: 22 }}>
      <PermissionsDialog onExit={vi.fn()} availableTerminalHeight={22} />
    </DialogSizeProvider>,
  );
  const input = async (sequence: string, name?: string) => {
    await act(async () => {
      const handle = keys.mock.calls.at(-1)?.[0] as (key: Key) => void;
      handle({ sequence, name } as Key);
    });
  };
  for (const character of 'A'.repeat(70) + 'Z') await input(character);
  expect(view.lastFrame()).toContain('Z');
  await input('', 'backspace');
  expect(view.lastFrame()).not.toContain('Z');
  view.unmount();
});

it('PR17541 R1-13 uses one row per permission option in a standard dialog', () => {
  render(
    <DialogSizeProvider value={{ columns: 80, rows: 22 }}>
      <PermissionsDialog onExit={vi.fn()} availableTerminalHeight={22} />
    </DialogSizeProvider>,
  );
  const props = select.mock.calls.at(-1)?.[0] as
    | { maxItemsToShow: number }
    | undefined;
  expect(props?.maxItemsToShow).toBe(10);
});

it.each([60, 80])(
  'uses the narrow permission tabs only below eighty columns (%i)',
  (columns) => {
    const { lastFrame } = render(
      <DialogSizeProvider value={{ columns, rows: 22 }}>
        <PermissionsDialog onExit={vi.fn()} availableTerminalHeight={22} />
      </DialogSizeProvider>,
    );
    expect(lastFrame()?.includes('Permissions:')).toBe(columns >= 80);
    expect(lastFrame()).toContain('Allow');
  },
);
