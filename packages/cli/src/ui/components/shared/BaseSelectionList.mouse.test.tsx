/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect } from 'vitest';
import { renderWithProviders } from '../../../test-utils/render.js';
import { LoadedSettings } from '../../../config/settings.js';
import { UIStateContext, type UIState } from '../../contexts/UIStateContext.js';
import { RadioButtonSelect } from './RadioButtonSelect.js';

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
  const ENABLE_ANY = '[?1003h';

  it('mounts the mouse layer (enables any-event tracking) and still renders items', () => {
    const { frames } = renderWithProviders(
      <RadioButtonSelect items={items} onSelect={() => {}} />,
      { settings: settingsWithMouse(true) },
    );
    // `frames` captures both rendered frames and the raw enable escape that
    // useMouseEvents writes to the same stdout — assert across all of them.
    const output = frames.join('\n');
    expect(output).toContain('Alpha');
    expect(output).toContain('Beta');
    expect(output).toContain(ENABLE_ANY);
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
    expect(output).toContain(ENABLE_ANY);
  });

  it('does not mount the mouse layer when ui.useTerminalBuffer is off', () => {
    const { lastFrame, frames } = renderWithProviders(
      <RadioButtonSelect items={items} onSelect={() => {}} />,
      { settings: settingsWithMouse(false) },
    );
    expect(lastFrame()).toContain('Alpha');
    expect(lastFrame()).toContain('Beta');
    expect(frames.join('\n')).not.toContain(ENABLE_ANY);
  });
});
