/**
 * @license
 * Copyright 2026 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import { Text } from 'ink';
import { render, cleanup } from 'ink-testing-library';
import { afterEach, expect, it, vi } from 'vitest';
import { DialogSizeProvider } from '../../contexts/DialogSizeContext.js';
import { HooksManagementDialog } from './HooksManagementDialog.js';

vi.mock('../../hooks/useKeypress.js', () => ({ useKeypress: vi.fn() }));
vi.mock('../../contexts/SettingsContext.js', () => ({
  useSettings: () => ({ forScope: () => ({ settings: { hooks: {} } }) }),
}));
vi.mock('../../contexts/ConfigContext.js', () => ({
  useConfig: () => ({
    getExtensions: () => [],
    getDisableAllHooks: () => false,
    getHookSystem: () => ({
      getSessionHooksManager: () => ({ getAllSessionHooks: () => [] }),
    }),
    getSessionId: () => 'sizing',
    isProjectHooksPendingApproval: () => false,
    isProjectHooksRejected: () => false,
  }),
}));
vi.mock('./HooksListStep.js', async () => {
  const { useDialogSize } = await import('../../contexts/DialogSizeContext.js');
  return {
    HooksListStep: () => {
      const bounds = useDialogSize();
      return (
        <Text>
          nested={bounds.columns}x{bounds.rows}
        </Text>
      );
    },
  };
});

afterEach(cleanup);

it('PR17541 R1-5 passes the dialog inner bounds to hook substeps', async () => {
  const view = render(
    <DialogSizeProvider value={{ columns: 60, rows: 20 }}>
      <HooksManagementDialog onClose={vi.fn()} />
    </DialogSizeProvider>,
  );
  await vi.waitFor(() => expect(view.lastFrame()).toContain('nested=52x16'));
});
