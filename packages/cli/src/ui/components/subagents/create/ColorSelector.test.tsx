/**
 * @license
 * Copyright 2026 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */
import { act } from '@testing-library/react';
import { render } from 'ink-testing-library';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { RadioButtonSelectProps } from '../../shared/RadioButtonSelect.js';
import { ColorSelector } from './ColorSelector.js';

const state = vi.hoisted(() => ({
  props: null as RadioButtonSelectProps<string> | null,
}));
vi.mock('../../shared/RadioButtonSelect.js', () => ({
  RadioButtonSelect: (props: RadioButtonSelectProps<string>) => {
    state.props = props;
    return null;
  },
}));
afterEach(() => {
  state.props = null;
});

describe('persisted agent color choices', () => {
  it.each([
    ['blue', 1],
    ['Green', 2],
    ['auto', 0],
  ] as const)(
    'initializes %s without changing its identity',
    (color, index) => {
      const onSelect = vi.fn();
      let app!: ReturnType<typeof render>;
      act(() => {
        app = render(<ColorSelector color={color} onSelect={onSelect} />);
      });
      expect(state.props?.initialIndex).toBe(index);
      expect(onSelect).not.toHaveBeenCalled();
      app.unmount();
    },
  );
  it.each(['blue', 'green', 'auto'])(
    'emits canonical %s rather than its label or painting value',
    (id) => {
      const onSelect = vi.fn();
      let app!: ReturnType<typeof render>;
      act(() => {
        app = render(<ColorSelector onSelect={onSelect} />);
      });
      act(() => state.props?.onSelect(id));
      expect(onSelect).toHaveBeenCalledExactlyOnceWith(id);
      app.unmount();
    },
  );
});
