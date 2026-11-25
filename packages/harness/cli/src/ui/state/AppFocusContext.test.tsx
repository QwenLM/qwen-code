/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { act } from 'react';
import type { PropsWithChildren } from 'react';
import { describe, expect, it } from 'vitest';

import { KeyboardContextRegistry } from '../contexts/KeyboardContextRegistry.js';
import { renderHook } from '../../test-utils/render.js';
import {
  AppFocusProvider,
  useAppFocus,
  useAppFocusContextSync,
  useAppFocusMachine,
} from './AppFocusContext.js';
import { AppFocusStateMachine } from './AppFocusStateMachine.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function createWrapper(machine?: AppFocusStateMachine) {
  return function Wrapper({ children }: PropsWithChildren) {
    return <AppFocusProvider machine={machine}>{children}</AppFocusProvider>;
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('AppFocusContext', () => {
  describe('useAppFocusMachine', () => {
    it('returns the state machine instance', async () => {
      const machine = new AppFocusStateMachine();
      const { result } = await renderHook(() => useAppFocusMachine(), {
        wrapper: createWrapper(machine),
      });
      expect(result.current).toBe(machine);
    });

    it('returns null without provider', async () => {
      const { result } = await renderHook(() => useAppFocusMachine());
      expect(result.current).toBeNull();
    });
  });

  describe('useAppFocus', () => {
    it('returns initial snapshot for Chat', async () => {
      const machine = new AppFocusStateMachine();
      const { result } = await renderHook(() => useAppFocus(), {
        wrapper: createWrapper(machine),
      });

      expect(result.current.baseFocus).toBe('Chat');
      expect(result.current.effectiveFocus).toBe('Chat');
      expect(result.current.overlayStack).toEqual([]);
    });

    it('returns correct snapshot when machine has overlay at mount', async () => {
      const machine = new AppFocusStateMachine();
      machine.pushFullscreen(); // set state before hook mounts
      const { result } = await renderHook(() => useAppFocus(), {
        wrapper: createWrapper(machine),
      });

      expect(result.current.effectiveFocus).toBe('Fullscreen');
      expect(result.current.baseFocus).toBe('Chat');
      expect(result.current.overlayStack).toEqual(['Fullscreen']);
    });

    it('returns default snapshot without provider', async () => {
      const { result } = await renderHook(() => useAppFocus());
      expect(result.current.baseFocus).toBe('Chat');
      expect(result.current.effectiveFocus).toBe('Chat');
    });
  });

  describe('useAppFocusContextSync', () => {
    it('syncs managed contexts to KeyboardContextRegistry', async () => {
      const machine = new AppFocusStateMachine();
      const registry = new KeyboardContextRegistry();

      const { KeyboardContextProvider } = await import(
        '../contexts/KeyboardContextRegistry.js'
      );

      function SyncWrapper({ children }: PropsWithChildren) {
        return (
          <AppFocusProvider machine={machine}>
            <KeyboardContextProvider registry={registry}>
              {children}
            </KeyboardContextProvider>
          </AppFocusProvider>
        );
      }

      await renderHook(() => useAppFocusContextSync(), {
        wrapper: SyncWrapper,
      });

      // Initial: Chat mode → Global + Chat active
      expect(registry.isActive('Global')).toBe(true);
      expect(registry.isActive('Chat')).toBe(true);
      expect(registry.isActive('Fullscreen')).toBe(false);
    });

    it('updates registry on overlay push', async () => {
      const machine = new AppFocusStateMachine();
      const registry = new KeyboardContextRegistry();

      const { KeyboardContextProvider } = await import(
        '../contexts/KeyboardContextRegistry.js'
      );

      function SyncWrapper({ children }: PropsWithChildren) {
        return (
          <AppFocusProvider machine={machine}>
            <KeyboardContextProvider registry={registry}>
              {children}
            </KeyboardContextProvider>
          </AppFocusProvider>
        );
      }

      await renderHook(() => useAppFocusContextSync(), {
        wrapper: SyncWrapper,
      });

      act(() => {
        machine.pushDialog();
      });

      // Dialog blocks base → Chat deactivated
      expect(registry.isActive('Chat')).toBe(false);
      expect(registry.isActive('Dialog')).toBe(true);
      expect(registry.isActive('Global')).toBe(true);
    });

    it('restores base context on overlay pop', async () => {
      const machine = new AppFocusStateMachine();
      const registry = new KeyboardContextRegistry();

      const { KeyboardContextProvider } = await import(
        '../contexts/KeyboardContextRegistry.js'
      );

      function SyncWrapper({ children }: PropsWithChildren) {
        return (
          <AppFocusProvider machine={machine}>
            <KeyboardContextProvider registry={registry}>
              {children}
            </KeyboardContextProvider>
          </AppFocusProvider>
        );
      }

      await renderHook(() => useAppFocusContextSync(), {
        wrapper: SyncWrapper,
      });

      act(() => {
        machine.pushDialog();
      });
      expect(registry.isActive('Chat')).toBe(false);
      expect(registry.isActive('Dialog')).toBe(true);

      act(() => {
        machine.popDialog();
      });
      expect(registry.isActive('Chat')).toBe(true);
      expect(registry.isActive('Dialog')).toBe(false);
    });

    it('does not manage non-focus contexts (Autocomplete, etc.)', async () => {
      const machine = new AppFocusStateMachine();
      const registry = new KeyboardContextRegistry();

      // Pre-register Autocomplete externally
      registry.registerContext('Autocomplete');

      const { KeyboardContextProvider } = await import(
        '../contexts/KeyboardContextRegistry.js'
      );

      function SyncWrapper({ children }: PropsWithChildren) {
        return (
          <AppFocusProvider machine={machine}>
            <KeyboardContextProvider registry={registry}>
              {children}
            </KeyboardContextProvider>
          </AppFocusProvider>
        );
      }

      await renderHook(() => useAppFocusContextSync(), {
        wrapper: SyncWrapper,
      });

      // Autocomplete should still be active — not managed by sync
      expect(registry.isActive('Autocomplete')).toBe(true);
    });
  });
});
