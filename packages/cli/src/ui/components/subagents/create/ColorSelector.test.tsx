/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { act } from '@testing-library/react';
import { render } from 'ink-testing-library';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { ColorSelector } from './ColorSelector.js';
import type { RadioButtonSelectProps } from '../../shared/RadioButtonSelect.js';

const radio = vi.hoisted(() => ({
  props: null as RadioButtonSelectProps<string> | null,
}));

vi.mock('../../shared/RadioButtonSelect.js', () => ({
  RadioButtonSelect: (props: RadioButtonSelectProps<string>) => {
    radio.props = props;
    return null;
  },
}));

let app: ReturnType<typeof render> | undefined;
afterEach(() => {
  act(() => app?.unmount());
  app = undefined;
  radio.props = null;
});

function mount(color = 'auto', onSelect = vi.fn()) {
  act(() => {
    app = render(
      <ColorSelector
        color={color}
        agentName="owned-agent"
        onSelect={onSelect}
      />,
    );
  });
  return onSelect;
}

describe('ColorSelector persisted color contract', () => {
  it('emits the canonical blue id accepted by the agent parser', () => {
    const onSelect = mount();
    act(() => radio.props!.onSelect('blue'));
    expect(onSelect).toHaveBeenCalledExactlyOnceWith('blue');
  });

  it.each(['blue', 'Blue'])(
    'restores %s to the Blue option and preview',
    (color) => {
      mount(color);
      expect(radio.props!.initialIndex).toBe(1);
      expect(radio.props!.items[1]).toMatchObject({
        label: 'Blue',
        value: 'blue',
      });
      expect(app!.lastFrame()).toContain('Preview:');
      expect(app!.lastFrame()).toContain('owned-agent');
    },
  );

  it('highlights Blue from automatic selection without committing a value', () => {
    const onSelect = mount();
    act(() => radio.props!.onHighlight?.('blue'));
    expect(radio.props!.initialIndex).toBe(1);
    expect(app!.lastFrame()).toContain('owned-agent');
    expect(onSelect).not.toHaveBeenCalled();
  });

  it('preserves the auto sentinel rather than its display label', () => {
    const onSelect = mount('auto');
    expect(radio.props!.initialIndex).toBe(0);
    act(() => radio.props!.onSelect('auto'));
    expect(onSelect).toHaveBeenCalledExactlyOnceWith('auto');
  });
});
