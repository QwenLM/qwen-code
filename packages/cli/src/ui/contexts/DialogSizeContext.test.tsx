/**
 * @license
 * Copyright 2026 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it, vi } from 'vitest';
import { render } from 'ink-testing-library';
import { Text } from 'ink';
import { DialogSizeProvider, useDialogSize } from './DialogSizeContext.js';
import { useTerminalSize } from '../hooks/useTerminalSize.js';

vi.mock('../hooks/useTerminalSize.js', () => ({
  useTerminalSize: () => ({ columns: 180, rows: 70 }),
}));

function Probe() {
  const layout = useDialogSize();
  const physical = useTerminalSize();
  return (
    <Text>{`${layout.isDialog ? 'popup' : 'native'} ${layout.columns}x${layout.rows}; physical ${physical.columns}x${physical.rows}`}</Text>
  );
}

describe('dialog layout bounds', () => {
  it('falls back to the physical terminal outside a popup', () => {
    expect(render(<Probe />).lastFrame()).toBe(
      'native 180x70; physical 180x70',
    );
  });

  it('updates popup layout bounds without changing physical pointer coordinates', () => {
    const { lastFrame, rerender } = render(
      <DialogSizeProvider value={{ columns: 100, rows: 32 }}>
        <Probe />
      </DialogSizeProvider>,
    );
    expect(lastFrame()).toBe('popup 100x32; physical 180x70');
    rerender(
      <DialogSizeProvider value={{ columns: 40, rows: 11 }}>
        <Probe />
      </DialogSizeProvider>,
    );
    expect(lastFrame()).toBe('popup 40x11; physical 180x70');
  });
});
