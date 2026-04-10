export type ModifierKey = 'shift' | 'command' | 'control' | 'option';

/**
 * Check if a specific modifier key is currently pressed.
 * Only works on macOS; returns false on other platforms.
 */
export function isModifierPressed(modifier: ModifierKey): boolean;

/**
 * Pre-warm the native module by loading it eagerly.
 * Call this early to avoid latency on first use.
 */
export function prewarm(): void;
