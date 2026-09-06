/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import { act } from 'react';
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { renderWithProviders } from '../../../test-utils/render.js';
import { LoadedSettings } from '../../../config/settings.js';
import { VirtualViewportContext } from '../../contexts/VirtualViewportContext.js';
import { RadioButtonSelect } from './RadioButtonSelect.js';

// Track whether BaseSelectionList mounts RowMouseController. The component's
// own gate (`mouseEnabled`) decides this — asserting on the mount directly
// pins BaseSelectionList's logic, not the downstream useMouseEvents gate.
const rowMouseRendered = vi.hoisted(() => ({
  count: 0,
  props: [] as Array<{
    onSelectIndex: (index: number) => void;
    onHoverIndex: (index: number) => void;
  }>,
}));

vi.mock('./RowMouseController.js', () => ({
  RowMouseController: (props: {
    onSelectIndex: (index: number) => void;
    onHoverIndex: (index: number) => void;
  }) => {
    rowMouseRendered.count++;
    rowMouseRendered.props.push(props);
    return null;
  },
}));

function settingsWithMouse(enabled: boolean): LoadedSettings {
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

describe('BaseSelectionList mouse gate', () => {
  const items = [
    { label: 'Alpha', value: 'a', key: 'a' },
    { label: 'Beta', value: 'b', key: 'b' },
  ];

  beforeEach(() => {
    rowMouseRendered.count = 0;
    rowMouseRendered.props.length = 0;
  });

  it('mounts RowMouseController when VP and mouseTracking are both on', () => {
    const { lastFrame } = renderWithProviders(
      <RadioButtonSelect items={items} onSelect={() => {}} />,
      { settings: settingsWithMouse(true) },
    );
    expect(lastFrame()).toContain('Alpha');
    expect(lastFrame()).toContain('Beta');
    expect(rowMouseRendered.count).toBeGreaterThan(0);
  });

  it('uses the startup VP decision when the raw setting is unset', () => {
    const { lastFrame } = renderWithProviders(
      <VirtualViewportContext.Provider value={true}>
        <RadioButtonSelect items={items} onSelect={() => {}} />
      </VirtualViewportContext.Provider>,
    );
    expect(lastFrame()).toContain('Alpha');
    expect(rowMouseRendered.count).toBeGreaterThan(0);
  });

  it('does not mount RowMouseController when startup VP overrides an enabled setting', () => {
    const { lastFrame } = renderWithProviders(
      <VirtualViewportContext.Provider value={false}>
        <RadioButtonSelect items={items} onSelect={() => {}} />
      </VirtualViewportContext.Provider>,
      { settings: settingsWithMouse(true) },
    );
    expect(lastFrame()).toContain('Alpha');
    expect(rowMouseRendered.count).toBe(0);
  });

  it('does not mount RowMouseController when ui.useTerminalBuffer is off', () => {
    const { lastFrame } = renderWithProviders(
      <RadioButtonSelect items={items} onSelect={() => {}} />,
      { settings: settingsWithMouse(false) },
    );
    expect(lastFrame()).toContain('Alpha');
    expect(rowMouseRendered.count).toBe(0);
  });

  it('reports the select intent before a click selection, never for hover', () => {
    // The intent signal is what lets an owner tell a deliberate click apart
    // from passive pointer motion.
    const onSelect = vi.fn();
    const onSelectIntent = vi.fn();
    renderWithProviders(
      <RadioButtonSelect
        items={items}
        onSelect={onSelect}
        onSelectIntent={onSelectIntent}
      />,
      { settings: settingsWithMouse(true) },
    );
    const props = rowMouseRendered.props.at(-1);
    expect(props).toBeDefined();

    act(() => props!.onHoverIndex(1));
    expect(onSelectIntent).not.toHaveBeenCalled();

    act(() => props!.onSelectIndex(1));
    expect(onSelectIntent).toHaveBeenCalledTimes(1);
    expect(onSelect).toHaveBeenCalledWith('b');
    expect(onSelectIntent.mock.invocationCallOrder[0]).toBeLessThan(
      onSelect.mock.invocationCallOrder[0]!,
    );
  });

  it('does not mount RowMouseController when ui.mouseTracking is false despite VP being on', () => {
    const ui = { ui: { useTerminalBuffer: true, mouseTracking: false } };
    const settingsNoMouse = new LoadedSettings(
      { path: '', settings: {}, originalSettings: {} },
      { path: '', settings: {}, originalSettings: {} },
      { path: '', settings: ui, originalSettings: ui },
      { path: '', settings: {}, originalSettings: {} },
      true,
      new Set(),
    );
    const { lastFrame } = renderWithProviders(
      <RadioButtonSelect items={items} onSelect={() => {}} />,
      { settings: settingsNoMouse },
    );
    expect(lastFrame()).toContain('Alpha');
    expect(lastFrame()).toContain('Beta');
    expect(rowMouseRendered.count).toBe(0);
  });
});
