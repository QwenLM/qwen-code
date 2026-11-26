/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it, vi } from 'vitest';

import { AppFocusStateMachine } from './AppFocusStateMachine.js';

describe('AppFocusStateMachine', () => {
  // ── Construction ──────────────────────────────────────────────────

  describe('construction', () => {
    it('defaults to Chat base focus with no overlays', () => {
      const sm = new AppFocusStateMachine();
      expect(sm.baseFocus).toBe('Chat');
      expect(sm.overlayStack).toEqual([]);
      expect(sm.effectiveFocus).toBe('Chat');
    });
  });

  // ── Base focus transitions ────────────────────────────────────────

  describe('base focus transitions', () => {
    it('FOCUS_CHAT is idempotent when already Chat', () => {
      const sm = new AppFocusStateMachine();
      const listener = vi.fn();
      sm.subscribe(listener);

      sm.send({ type: 'FOCUS_CHAT' }); // already Chat
      expect(listener).not.toHaveBeenCalled();
    });
  });

  // ── Overlay push/pop ──────────────────────────────────────────────

  describe('overlay stack', () => {
    it('pushes Fullscreen overlay', () => {
      const sm = new AppFocusStateMachine();
      sm.pushFullscreen();
      expect(sm.overlayStack).toEqual(['Fullscreen']);
      expect(sm.effectiveFocus).toBe('Fullscreen');
    });

    it('pushes Dialog overlay', () => {
      const sm = new AppFocusStateMachine();
      sm.pushDialog();
      expect(sm.overlayStack).toEqual(['Dialog']);
      expect(sm.effectiveFocus).toBe('Dialog');
    });

    it('stacks overlays — topmost wins', () => {
      const sm = new AppFocusStateMachine();
      sm.pushFullscreen();
      sm.pushDialog();
      expect(sm.overlayStack).toEqual(['Fullscreen', 'Dialog']);
      expect(sm.effectiveFocus).toBe('Dialog');
    });

    it('pops overlay returns to previous', () => {
      const sm = new AppFocusStateMachine();
      sm.pushFullscreen();
      sm.pushDialog();

      sm.popDialog();
      expect(sm.overlayStack).toEqual(['Fullscreen']);
      expect(sm.effectiveFocus).toBe('Fullscreen');

      sm.popFullscreen();
      expect(sm.overlayStack).toEqual([]);
      expect(sm.effectiveFocus).toBe('Chat'); // back to base
    });

    it('deduplicates overlays', () => {
      const sm = new AppFocusStateMachine();
      sm.pushDialog();
      sm.pushDialog(); // no-op
      expect(sm.overlayStack).toEqual(['Dialog']);
    });

    it('pop on non-existent overlay is no-op', () => {
      const sm = new AppFocusStateMachine();
      const listener = vi.fn();
      sm.subscribe(listener);

      sm.popDialog(); // Dialog not in stack
      expect(listener).not.toHaveBeenCalled();
    });

    it('CLEAR_OVERLAYS removes all overlays', () => {
      const sm = new AppFocusStateMachine();
      sm.pushFullscreen();
      sm.pushDialog();

      sm.send({ type: 'CLEAR_OVERLAYS' });
      expect(sm.overlayStack).toEqual([]);
      expect(sm.effectiveFocus).toBe('Chat');
    });
  });

  // ── Base focus + overlay interaction ──────────────────────────────

  describe('base focus with overlays', () => {
    it('overlay remains when FOCUS_CHAT is sent', () => {
      const sm = new AppFocusStateMachine();
      sm.pushDialog();
      sm.send({ type: 'FOCUS_CHAT' });

      expect(sm.baseFocus).toBe('Chat');
      expect(sm.overlayStack).toEqual(['Dialog']);
      expect(sm.effectiveFocus).toBe('Dialog'); // overlay still on top
    });

    it('popping last overlay reveals base focus', () => {
      const sm = new AppFocusStateMachine();
      sm.pushDialog();
      sm.popDialog();

      expect(sm.effectiveFocus).toBe('Chat');
    });
  });

  // ── getActiveContexts ─────────────────────────────────────────────

  describe('getActiveContexts', () => {
    it('Chat base → Global + Chat', () => {
      const sm = new AppFocusStateMachine();
      const contexts = sm.getActiveContexts();
      expect(contexts).toEqual(new Set(['Global', 'Chat']));
    });

    it('Dialog overlay blocks base context', () => {
      const sm = new AppFocusStateMachine();
      sm.pushDialog();
      const contexts = sm.getActiveContexts();
      expect(contexts).toEqual(new Set(['Global', 'Dialog']));
      expect(contexts.has('Chat')).toBe(false);
    });

    it('Fullscreen overlay does NOT block base context', () => {
      const sm = new AppFocusStateMachine();
      sm.pushFullscreen();
      const contexts = sm.getActiveContexts();
      // Fullscreen is non-blocking — Chat remains active for scroll etc.
      expect(contexts).toEqual(new Set(['Global', 'Chat', 'Fullscreen']));
    });

  });

  // ── Convenience queries ───────────────────────────────────────────

  describe('queries', () => {
    it('isEffective checks topmost focus', () => {
      const sm = new AppFocusStateMachine();
      expect(sm.isEffective('Chat')).toBe(true);

      sm.pushDialog();
      expect(sm.isEffective('Dialog')).toBe(true);
      expect(sm.isEffective('Chat')).toBe(false);
    });

    it('hasOverlayOf checks specific overlay', () => {
      const sm = new AppFocusStateMachine();
      expect(sm.hasOverlayOf('Dialog')).toBe(false);

      sm.pushDialog();
      expect(sm.hasOverlayOf('Dialog')).toBe(true);
      expect(sm.hasOverlayOf('Fullscreen')).toBe(false);
    });
  });

  // ── getSnapshot ───────────────────────────────────────────────────

  describe('getSnapshot', () => {
    it('returns immutable snapshot', () => {
      const sm = new AppFocusStateMachine();
      const s1 = sm.getSnapshot();
      sm.pushDialog();
      const s2 = sm.getSnapshot();

      // s1 is NOT mutated
      expect(s1.baseFocus).toBe('Chat');
      expect(s1.overlayStack).toEqual([]);
      expect(s2.overlayStack).toEqual(['Dialog']);
    });

    it('overlay stack is a copy', () => {
      const sm = new AppFocusStateMachine();
      sm.pushFullscreen();
      const snap = sm.getSnapshot();

      // Mutating the snapshot should not affect the machine
      (snap.overlayStack as string[]).push('Dialog');
      expect(sm.overlayStack).toEqual(['Fullscreen']);
    });
  });

  // ── Subscription ──────────────────────────────────────────────────

  describe('subscription', () => {
    it('notifies on state change', () => {
      const sm = new AppFocusStateMachine();
      const listener = vi.fn();
      sm.subscribe(listener);

      sm.pushDialog();
      expect(listener).toHaveBeenCalledTimes(1);
      expect(listener).toHaveBeenCalledWith(
        expect.objectContaining({ overlayStack: ['Dialog'] }),
        expect.objectContaining({ overlayStack: [] }),
      );
    });

    it('does not notify when state does not change', () => {
      const sm = new AppFocusStateMachine();
      const listener = vi.fn();
      sm.subscribe(listener);

      sm.focusChat(); // already Chat
      expect(listener).not.toHaveBeenCalled();
    });

    it('unsubscribe stops notifications', () => {
      const sm = new AppFocusStateMachine();
      const listener = vi.fn();
      const unsub = sm.subscribe(listener);

      unsub();
      sm.pushDialog();
      expect(listener).not.toHaveBeenCalled();
    });

    it('notifies on overlay changes', () => {
      const sm = new AppFocusStateMachine();
      const listener = vi.fn();
      sm.subscribe(listener);

      sm.pushFullscreen();
      expect(listener).toHaveBeenCalledTimes(1);

      sm.popFullscreen();
      expect(listener).toHaveBeenCalledTimes(2);
    });
  });

  // ── Integration: full focus lifecycle ─────────────────────────────

  describe('full lifecycle', () => {
    it('simulates typical user session', () => {
      const sm = new AppFocusStateMachine();

      // User starts in Chat
      expect(sm.effectiveFocus).toBe('Chat');

      // Dialog opens
      sm.pushDialog();
      expect(sm.effectiveFocus).toBe('Dialog');
      expect(sm.baseFocus).toBe('Chat'); // base preserved

      // Dialog closes
      sm.popDialog();
      expect(sm.effectiveFocus).toBe('Chat'); // returns to chat

    });
  });
});
