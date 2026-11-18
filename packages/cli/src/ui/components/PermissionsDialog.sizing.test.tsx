/**
 * @license
 * Copyright 2026 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import { render, cleanup } from 'ink-testing-library';
import { afterEach, expect, it, vi } from 'vitest';
import { DialogSizeProvider } from '../contexts/DialogSizeContext.js';
import { PermissionsDialog } from './PermissionsDialog.js';

const { select } = vi.hoisted(() => ({
  select: vi.fn((_props: unknown) => null),
}));
vi.mock('../hooks/useKeypress.js', () => ({ useKeypress: vi.fn() }));
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

it('PR17541 R1-13 uses one row per permission option in a standard dialog', () => {
  render(
    <DialogSizeProvider value={{ columns: 80, rows: 22 }}>
      <PermissionsDialog onExit={vi.fn()} availableTerminalHeight={22} />
    </DialogSizeProvider>,
  );
  const props = select.mock.calls.at(-1)?.[0] as
    | { maxItemsToShow: number }
    | undefined;
  expect(props?.maxItemsToShow).toBeGreaterThanOrEqual(10);
});
