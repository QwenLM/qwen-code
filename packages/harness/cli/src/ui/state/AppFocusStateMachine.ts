/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * AppFocusStateMachine — Centralized focus state management.
 *
 * Centralized state machine for base-view routing and overlay stacking.
 *
 * ## Design Principles
 *
 * 1. **Single source of truth**: All view-routing state lives here, not in scattered booleans.
 * 2. **Declarative transitions**: State changes via named events, not ad-hoc setState calls.
 * 3. **Derived context activation**: `getActiveContexts()` deterministically drives
 *    which keyboard contexts are active — no per-component guard expressions.
 * 4. **Overlay stack**: Modals and dialogs stack on top of a base view,
 *    and popping returns to the previous base.
 *
 * ## Architecture
 *
 * ```
 * ┌─────────────────────────────────────────────────┐
 * │  AppFocusStateMachine                            │
 * │                                                  │
 * │  baseFocus: Chat                                 │
 * │  overlayStack: [Fullscreen | Dialog]             │
 * │                                                  │
 * │  effectiveFocus = stack.top ?? baseFocus          │
 * │                                                  │
 * │  → drives KeyboardContextRegistry activations    │
 * │  → drives UI rendering (cursor, borders, etc.)   │
 * └─────────────────────────────────────────────────┘
 * ```
 */

// ---------------------------------------------------------------------------
// Focus states
// ---------------------------------------------------------------------------

/**
 * Base focus — the app always stays in Chat focus.
 */
export type BaseFocus = 'Chat';

/**
 * Overlay focus — stacks on top of base focus.
 * Can be layered (e.g. Dialog on top of Chat, Fullscreen on top of Dialog).
 */
export type OverlayFocus = 'Fullscreen' | 'Dialog';

/**
 * The effective focus is either the top overlay or the base focus.
 */
export type EffectiveFocus = BaseFocus | OverlayFocus;

// ---------------------------------------------------------------------------
// Events (state transitions)
// ---------------------------------------------------------------------------

export type AppFocusEvent =
  // Base focus transitions
  | { type: 'FOCUS_CHAT' }
  // Overlay push/pop
  | { type: 'PUSH_OVERLAY'; overlay: OverlayFocus }
  | { type: 'POP_OVERLAY'; overlay: OverlayFocus }
  // Convenience: replace top or clear all overlays
  | { type: 'CLEAR_OVERLAYS' };

// ---------------------------------------------------------------------------
// State shape
// ---------------------------------------------------------------------------

export interface AppFocusSnapshot {
  /** Current base focus (main view). */
  readonly baseFocus: BaseFocus;
  /** Overlay stack — bottom to top. Empty means no overlay. */
  readonly overlayStack: readonly OverlayFocus[];
  /** Computed: the topmost focus (overlay or base). */
  readonly effectiveFocus: EffectiveFocus;
}

// ---------------------------------------------------------------------------
// Listener
// ---------------------------------------------------------------------------

export type FocusChangeListener = (
  snapshot: AppFocusSnapshot,
  prevSnapshot: AppFocusSnapshot,
) => void;

// ---------------------------------------------------------------------------
// State machine class
// ---------------------------------------------------------------------------

export class AppFocusStateMachine {
  private _baseFocus: BaseFocus;
  private _overlayStack: OverlayFocus[];
  private _listeners = new Set<FocusChangeListener>();
  /**
   * Cached snapshot — must be referentially stable for useSyncExternalStore.
   * React calls getSnapshot() during AND after render; if the reference changes
   * between those calls (even with identical content), React assumes the store
   * changed and re-renders, causing an infinite loop.
   */
  private _cachedSnapshot: AppFocusSnapshot;

  constructor(initialBase: BaseFocus = 'Chat') {
    this._baseFocus = initialBase;
    this._overlayStack = [];
    this._cachedSnapshot = {
      baseFocus: this._baseFocus,
      overlayStack: [],
      effectiveFocus: this._baseFocus,
    };
  }

  // ── Queries ──────────────────────────────────────────────────────────

  get baseFocus(): BaseFocus {
    return this._baseFocus;
  }

  get overlayStack(): readonly OverlayFocus[] {
    return this._overlayStack;
  }

  get effectiveFocus(): EffectiveFocus {
    return this._overlayStack.length > 0
      ? this._overlayStack[this._overlayStack.length - 1]
      : this._baseFocus;
  }

  /** Snapshot for immutable reads (React state sync). */
  getSnapshot(): AppFocusSnapshot {
    return this._cachedSnapshot;
  }

  /** Build a fresh snapshot from current state (internal use). */
  private _buildSnapshot(): AppFocusSnapshot {
    return {
      baseFocus: this._baseFocus,
      overlayStack: [...this._overlayStack],
      effectiveFocus: this.effectiveFocus,
    };
  }

  /**
   * Derive which keyboard contexts should be active from current focus.
   *
   * Deterministically derives active keyboard contexts from current state.
   * Replaces all per-component guard expressions.
   */
  getActiveContexts(): Set<string> {
    const contexts = new Set<string>();

    // Global is ALWAYS active
    contexts.add('Global');

    // Chat context is active when no blocking overlay is present
    const hasBlockingOverlay = this._overlayStack.includes('Dialog');

    if (!hasBlockingOverlay) {
      contexts.add('Chat');
    }

    // Each overlay adds its context
    for (const overlay of this._overlayStack) {
      contexts.add(overlay);
    }

    return contexts;
  }

  /** Check if a specific focus is the effective (topmost) focus. */
  isEffective(focus: EffectiveFocus): boolean {
    return this.effectiveFocus === focus;
  }


  /** Check if a specific overlay is in the stack. */
  hasOverlayOf(overlay: OverlayFocus): boolean {
    return this._overlayStack.includes(overlay);
  }

  // ── Transitions ──────────────────────────────────────────────────────

  /**
   * Send an event to the state machine.
   * Returns the new snapshot.
   */
  send(event: AppFocusEvent): AppFocusSnapshot {
    const prev = this._cachedSnapshot;

    switch (event.type) {
      case 'FOCUS_CHAT':
        this._baseFocus = 'Chat';
        break;

      case 'PUSH_OVERLAY': {
        // Deduplicate: don't push the same overlay twice
        if (!this._overlayStack.includes(event.overlay)) {
          this._overlayStack.push(event.overlay);
        }
        break;
      }

      case 'POP_OVERLAY': {
        const idx = this._overlayStack.indexOf(event.overlay);
        if (idx !== -1) {
          this._overlayStack.splice(idx, 1);
        }
        break;
      }

      case 'CLEAR_OVERLAYS':
        this._overlayStack = [];
        break;

      default:
        break;
    }

    const next = this._buildSnapshot();

    // Only notify and update cache if state actually changed
    if (
      prev.baseFocus !== next.baseFocus ||
      prev.effectiveFocus !== next.effectiveFocus ||
      prev.overlayStack.length !== next.overlayStack.length ||
      prev.overlayStack.some((o, i) => o !== next.overlayStack[i])
    ) {
      this._cachedSnapshot = next;
      this._notify(next, prev);
    }

    return this._cachedSnapshot;
  }

  // ── Convenience methods (typed wrappers around send) ──────────────

  focusChat(): void {
    this.send({ type: 'FOCUS_CHAT' });
  }

  pushFullscreen(): void {
    this.send({ type: 'PUSH_OVERLAY', overlay: 'Fullscreen' });
  }

  popFullscreen(): void {
    this.send({ type: 'POP_OVERLAY', overlay: 'Fullscreen' });
  }

  pushDialog(): void {
    this.send({ type: 'PUSH_OVERLAY', overlay: 'Dialog' });
  }

  popDialog(): void {
    this.send({ type: 'POP_OVERLAY', overlay: 'Dialog' });
  }

  // ── Subscription ──────────────────────────────────────────────────

  subscribe(listener: FocusChangeListener): () => void {
    this._listeners.add(listener);
    return () => {
      this._listeners.delete(listener);
    };
  }

  private _notify(
    snapshot: AppFocusSnapshot,
    prevSnapshot: AppFocusSnapshot,
  ): void {
    for (const listener of this._listeners) {
      listener(snapshot, prevSnapshot);
    }
  }
}
