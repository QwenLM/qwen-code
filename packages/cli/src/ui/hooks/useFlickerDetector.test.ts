/**
 * @license
 * Copyright 2025 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { renderHook } from '../../test-utils/render.js';
import { vi, type Mock } from 'vitest';
import { useFlickerDetector } from './useFlickerDetector.js';
import { type DOMElement, measureElement } from 'ink';
import { useUIState } from '../contexts/UIStateContext.js';
import { appEvents, AppEvent } from '../../utils/events.js';

// Mock dependencies
vi.mock('../contexts/UIStateContext.js');
vi.mock('ink', async (importOriginal) => {
  const original = await importOriginal<typeof import('ink')>();
  return {
    ...original,
    measureElement: vi.fn(),
  };
});
vi.mock('../../utils/events.js', () => ({
  appEvents: {
    emit: vi.fn(),
  },
  AppEvent: {
    Flicker: 'flicker',
  },
}));

const mockUseUIState = useUIState as Mock;
const mockMeasureElement = measureElement as Mock;
const mockAppEventsEmit = appEvents.emit as Mock;

describe('useFlickerDetector', () => {
  let mockRef: React.RefObject<DOMElement | null>;

  beforeEach(() => {
    mockRef = { current: { yogaNode: {} } as DOMElement };
    // Default UI state
    mockUseUIState.mockReturnValue({ constrainHeight: true });
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('should not emit a flicker event when height is less than terminal height', async () => {
    mockMeasureElement.mockReturnValue({ width: 80, height: 20 });
    await renderHook(() => useFlickerDetector(mockRef, 25));
    expect(mockAppEventsEmit).not.toHaveBeenCalled();
  });

  it('should not emit a flicker event when height is equal to terminal height', async () => {
    mockMeasureElement.mockReturnValue({ width: 80, height: 25 });
    await renderHook(() => useFlickerDetector(mockRef, 25));
    expect(mockAppEventsEmit).not.toHaveBeenCalled();
  });

  it('should emit a flicker event when height is greater than terminal height and height is constrained', async () => {
    mockMeasureElement.mockReturnValue({ width: 80, height: 30 });
    await renderHook(() => useFlickerDetector(mockRef, 25));
    expect(mockAppEventsEmit).toHaveBeenCalledTimes(1);
    expect(mockAppEventsEmit).toHaveBeenCalledWith(AppEvent.Flicker);
  });

  it('should NOT emit a flicker event when height is greater than terminal height but height is NOT constrained', async () => {
    // Override default UI state for this test
    mockUseUIState.mockReturnValue({ constrainHeight: false });
    mockMeasureElement.mockReturnValue({ width: 80, height: 30 });
    await renderHook(() => useFlickerDetector(mockRef, 25));
    expect(mockAppEventsEmit).not.toHaveBeenCalled();
  });

  it('should not check for flicker if the ref is not set', async () => {
    mockRef.current = null;
    mockMeasureElement.mockReturnValue({ width: 80, height: 30 });
    await renderHook(() => useFlickerDetector(mockRef, 25));
    expect(mockMeasureElement).not.toHaveBeenCalled();
    expect(mockAppEventsEmit).not.toHaveBeenCalled();
  });

  it('should re-evaluate on re-render', async () => {
    // Start with a valid height
    mockMeasureElement.mockReturnValue({ width: 80, height: 20 });
    const { rerender } = await renderHook(() =>
      useFlickerDetector(mockRef, 25),
    );
    expect(mockAppEventsEmit).not.toHaveBeenCalled();

    // Now, simulate a re-render where the height is too great
    mockMeasureElement.mockReturnValue({ width: 80, height: 30 });
    rerender();

    expect(mockAppEventsEmit).toHaveBeenCalledTimes(1);
  });
});
