/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import { act } from 'react';
import { renderHook } from '../../test-utils/render.js';
import { useTabbedNavigation } from './useTabbedNavigation.js';

// Mock context registration hooks (called by the hook but not exercised in unit tests)
vi.mock('../contexts/KeyboardContextRegistry.js', async (importOriginal) => {
  const actual =
    await importOriginal<
      typeof import('../contexts/KeyboardContextRegistry.js')
    >();
  return {
    ...actual,
    useRegisterKeyboardContext: vi.fn(),
  };
});
vi.mock('../contexts/ActionHandlerRegistry.js', async (importOriginal) => {
  const actual =
    await importOriginal<
      typeof import('../contexts/ActionHandlerRegistry.js')
    >();
  return {
    ...actual,
    useRegisterActionHandlers: vi.fn(),
  };
});

describe('useTabbedNavigation', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('keyboard navigation (via action handlers)', () => {
    // Tab navigation is now handled by context-routing action handlers
    // (tabs:next, tabs:previous) which call goToNextTab/goToPrevTab.
    // We test the underlying navigation functions directly.

    it('moves to next tab via goToNextTab', async () => {
      const { result } = await renderHook(() =>
        useTabbedNavigation({ tabCount: 3 }),
      );

      act(() => {
        result.current.goToNextTab();
      });

      expect(result.current.currentIndex).toBe(1);
    });

    it('moves to previous tab via goToPrevTab', async () => {
      const { result } = await renderHook(() =>
        useTabbedNavigation({
          tabCount: 3,
          initialIndex: 1,
        }),
      );

      act(() => {
        result.current.goToPrevTab();
      });

      expect(result.current.currentIndex).toBe(0);
    });

    it('does not navigate when isNavigationBlocked returns true', async () => {
      const isNavigationBlocked = vi.fn(() => true);
      const { result } = await renderHook(() =>
        useTabbedNavigation({
          tabCount: 3,
          enableArrowNavigation: true,
          isNavigationBlocked,
        }),
      );

      act(() => {
        result.current.goToNextTab();
      });

      expect(result.current.currentIndex).toBe(0);
      expect(isNavigationBlocked).toHaveBeenCalled();
    });
  });

  describe('initialization', () => {
    it('returns initial index of 0 by default', async () => {
      const { result } = await renderHook(() =>
        useTabbedNavigation({ tabCount: 3 }),
      );
      expect(result.current.currentIndex).toBe(0);
    });

    it('returns specified initial index', async () => {
      const { result } = await renderHook(() =>
        useTabbedNavigation({ tabCount: 3, initialIndex: 2 }),
      );
      expect(result.current.currentIndex).toBe(2);
    });

    it('clamps initial index to valid range', async () => {
      const { result: high } = await renderHook(() =>
        useTabbedNavigation({ tabCount: 3, initialIndex: 10 }),
      );
      expect(high.current.currentIndex).toBe(2);

      const { result: negative } = await renderHook(() =>
        useTabbedNavigation({ tabCount: 3, initialIndex: -1 }),
      );
      expect(negative.current.currentIndex).toBe(0);
    });
  });

  describe('goToNextTab', () => {
    it('advances to next tab', async () => {
      const { result } = await renderHook(() =>
        useTabbedNavigation({ tabCount: 3 }),
      );

      act(() => {
        result.current.goToNextTab();
      });

      expect(result.current.currentIndex).toBe(1);
    });

    it('stops at last tab when wrapAround is false', async () => {
      const { result } = await renderHook(() =>
        useTabbedNavigation({
          tabCount: 3,
          initialIndex: 2,
          wrapAround: false,
        }),
      );

      act(() => {
        result.current.goToNextTab();
      });

      expect(result.current.currentIndex).toBe(2);
    });

    it('wraps to first tab when wrapAround is true', async () => {
      const { result } = await renderHook(() =>
        useTabbedNavigation({ tabCount: 3, initialIndex: 2, wrapAround: true }),
      );

      act(() => {
        result.current.goToNextTab();
      });

      expect(result.current.currentIndex).toBe(0);
    });
  });

  describe('goToPrevTab', () => {
    it('moves to previous tab', async () => {
      const { result } = await renderHook(() =>
        useTabbedNavigation({ tabCount: 3, initialIndex: 2 }),
      );

      act(() => {
        result.current.goToPrevTab();
      });

      expect(result.current.currentIndex).toBe(1);
    });

    it('stops at first tab when wrapAround is false', async () => {
      const { result } = await renderHook(() =>
        useTabbedNavigation({
          tabCount: 3,
          initialIndex: 0,
          wrapAround: false,
        }),
      );

      act(() => {
        result.current.goToPrevTab();
      });

      expect(result.current.currentIndex).toBe(0);
    });

    it('wraps to last tab when wrapAround is true', async () => {
      const { result } = await renderHook(() =>
        useTabbedNavigation({ tabCount: 3, initialIndex: 0, wrapAround: true }),
      );

      act(() => {
        result.current.goToPrevTab();
      });

      expect(result.current.currentIndex).toBe(2);
    });
  });

  describe('setCurrentIndex', () => {
    it('sets index directly', async () => {
      const { result } = await renderHook(() =>
        useTabbedNavigation({ tabCount: 3 }),
      );

      act(() => {
        result.current.setCurrentIndex(2);
      });

      expect(result.current.currentIndex).toBe(2);
    });

    it('ignores out-of-bounds index', async () => {
      const { result } = await renderHook(() =>
        useTabbedNavigation({ tabCount: 3, initialIndex: 1 }),
      );

      act(() => {
        result.current.setCurrentIndex(10);
      });
      expect(result.current.currentIndex).toBe(1);

      act(() => {
        result.current.setCurrentIndex(-1);
      });
      expect(result.current.currentIndex).toBe(1);
    });
  });

  describe('isNavigationBlocked', () => {
    it('blocks navigation when callback returns true', async () => {
      const isNavigationBlocked = vi.fn(() => true);
      const { result } = await renderHook(() =>
        useTabbedNavigation({ tabCount: 3, isNavigationBlocked }),
      );

      act(() => {
        result.current.goToNextTab();
      });

      expect(result.current.currentIndex).toBe(0);
      expect(isNavigationBlocked).toHaveBeenCalled();
    });

    it('allows navigation when callback returns false', async () => {
      const isNavigationBlocked = vi.fn(() => false);
      const { result } = await renderHook(() =>
        useTabbedNavigation({ tabCount: 3, isNavigationBlocked }),
      );

      act(() => {
        result.current.goToNextTab();
      });

      expect(result.current.currentIndex).toBe(1);
    });
  });

  describe('onTabChange callback', () => {
    it('calls onTabChange when tab changes via goToNextTab', async () => {
      const onTabChange = vi.fn();
      const { result } = await renderHook(() =>
        useTabbedNavigation({ tabCount: 3, onTabChange }),
      );

      act(() => {
        result.current.goToNextTab();
      });

      expect(onTabChange).toHaveBeenCalledWith(1);
    });

    it('calls onTabChange when tab changes via setCurrentIndex', async () => {
      const onTabChange = vi.fn();
      const { result } = await renderHook(() =>
        useTabbedNavigation({ tabCount: 3, onTabChange }),
      );

      act(() => {
        result.current.setCurrentIndex(2);
      });

      expect(onTabChange).toHaveBeenCalledWith(2);
    });

    it('does not call onTabChange when tab does not change', async () => {
      const onTabChange = vi.fn();
      const { result } = await renderHook(() =>
        useTabbedNavigation({ tabCount: 3, onTabChange }),
      );

      act(() => {
        result.current.setCurrentIndex(0);
      });

      expect(onTabChange).not.toHaveBeenCalled();
    });
  });

  describe('isFirstTab and isLastTab', () => {
    it('returns correct boundary flags based on position', async () => {
      const { result: first } = await renderHook(() =>
        useTabbedNavigation({ tabCount: 3, initialIndex: 0 }),
      );
      expect(first.current.isFirstTab).toBe(true);
      expect(first.current.isLastTab).toBe(false);

      const { result: last } = await renderHook(() =>
        useTabbedNavigation({ tabCount: 3, initialIndex: 2 }),
      );
      expect(last.current.isFirstTab).toBe(false);
      expect(last.current.isLastTab).toBe(true);

      const { result: middle } = await renderHook(() =>
        useTabbedNavigation({ tabCount: 3, initialIndex: 1 }),
      );
      expect(middle.current.isFirstTab).toBe(false);
      expect(middle.current.isLastTab).toBe(false);
    });
  });

  describe('tabCount changes', () => {
    it('reinitializes when tabCount changes', async () => {
      let tabCount = 5;
      const { result, rerender } = await renderHook(() =>
        useTabbedNavigation({ tabCount, initialIndex: 4 }),
      );

      expect(result.current.currentIndex).toBe(4);

      tabCount = 3;
      rerender();

      // Should clamp to valid range
      expect(result.current.currentIndex).toBe(2);
    });
  });
});
