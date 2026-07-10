/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { useStdout } from 'ink';
import { renderWithProviders } from '../../../test-utils/render.js';
import { LoadedSettings } from '../../../config/settings.js';
import { UIStateContext, type UIState } from '../../contexts/UIStateContext.js';
import { RadioButtonSelect } from './RadioButtonSelect.js';

// `useMouseEvents` gates SGR mouse escapes on `stdout.isTTY` (so they never leak
// into piped output). Route its stdout through a mock that reports a TTY and
// captures writes, so the mouse-enable escape is assertable independently of
// ink-testing-library's render frames. Other ink exports are preserved so the
// component still renders normally.
vi.mock('ink', async (importOriginal) => {
  const actual = await importOriginal<typeof import('ink')>();
  return { ...actual, useStdout: vi.fn() };
});

const mockedUseStdout = vi.mocked(useStdout);
let mouseWrite: ReturnType<typeof vi.fn>;

// Integration smoke test: with ui.useTerminalBuffer on, BaseSelectionList
// mounts the real RowMouseController (which subscribes via the real
// useMouseEvents/KeypressProvider). This guards the end-to-end gate + mount
// path — that turning mouse input on doesn't throw or break rendering.
// Coordinate accuracy is exercised by RowMouseController.test.tsx (unit) and
// validated in a real terminal.
function settingsWithMouse(enabled: boolean): LoadedSettings {
  // Mouse input is enabled by alternate-screen mode.
  const ui = { ui: { useTerminalBuffer: enabled } };
  return new LoadedSettings(
    { path: '', settings: {}, originalSettings: {} },
    { path: '', settings: {}, originalSettings: {} },
    { path: '', settings: ui, originalSettings: ui },
    { path: '', settings: {}, originalSettings: {} },
    true,
    new Set(),
  );
}

describe('BaseSelectionList with mouse enabled (integration)', () => {
  const items = [
    { label: 'Alpha', value: 'a', key: 'a' },
    { label: 'Beta', value: 'b', key: 'b' },
  ];

  // `?1003h` = any-event tracking; the mouse layer enables it for hover.
  const ENABLE_ANY = '[?1003h';

  const enabledAnyWritten = () =>
    mouseWrite.mock.calls.some(
      (call) => typeof call[0] === 'string' && call[0].includes(ENABLE_ANY),
    );

  beforeEach(() => {
    mouseWrite = vi.fn();
    mockedUseStdout.mockReturnValue({
      stdout: { write: mouseWrite, isTTY: true, columns: 80, rows: 24 },
      writeToStdout: vi.fn(),
    } as unknown as ReturnType<typeof useStdout>);
  });

  it('mounts the mouse layer (enables any-event tracking) and still renders items', () => {
    const { lastFrame } = renderWithProviders(
      <RadioButtonSelect items={items} onSelect={() => {}} />,
      { settings: settingsWithMouse(true) },
    );
    // Items still render through ink's own stdout...
    expect(lastFrame()).toContain('Alpha');
    expect(lastFrame()).toContain('Beta');
    // ...and useMouseEvents wrote the any-event enable escape to its stdout.
    expect(enabledAnyWritten()).toBe(true);
  });

  it('uses UIState VP mode when the raw setting is unset', () => {
    const { frames } = renderWithProviders(
      <UIStateContext.Provider
        value={{ useTerminalBuffer: true } as unknown as UIState}
      >
        <RadioButtonSelect items={items} onSelect={() => {}} />
      </UIStateContext.Provider>,
    );
    const output = frames.join('\n');
    expect(output).toContain('Alpha');
    expect(output).toContain('Beta');
    expect(enabledAnyWritten()).toBe(true);
  });

  it('does not mount the mouse layer when ui.useTerminalBuffer is off', () => {
    const { lastFrame } = renderWithProviders(
      <RadioButtonSelect items={items} onSelect={() => {}} />,
      { settings: settingsWithMouse(false) },
    );
    expect(lastFrame()).toContain('Alpha');
    expect(lastFrame()).toContain('Beta');
    expect(enabledAnyWritten()).toBe(false);
  });
});
