/**
 * Native macOS modifier key detection.
 *
 * Wraps the @qwen-code/modifiers-napi native addon to synchronously check
 * whether modifier keys (Shift, Cmd, Ctrl, Option) are physically held down.
 * This is used as a fallback for terminals (like Apple Terminal) that don't
 * encode modifier keys in their escape sequences for Enter.
 *
 * On non-macOS platforms, all checks return false.
 */

export type ModifierKey = 'shift' | 'command' | 'control' | 'option';

let prewarmed = false;

/**
 * Pre-warm the native module by loading it in advance.
 * Call this early to avoid delay on first use.
 */
export function prewarmModifiers(): void {
  if (prewarmed || process.platform !== 'darwin') {
    return;
  }
  prewarmed = true;
  try {
    // Dynamic require is intentional — native addon cannot be statically imported
    // eslint-disable-next-line @typescript-eslint/no-require-imports, no-restricted-syntax
    const { prewarm } = require('@qwen-code/modifiers-napi') as {
      prewarm: () => void;
    };
    prewarm();
  } catch {
    // Ignore errors during prewarm - native module may not be available
  }
}

/**
 * Check if a specific modifier key is currently pressed (synchronous).
 * Only works on macOS; returns false on other platforms or if native module unavailable.
 */
export function isModifierPressed(modifier: ModifierKey): boolean {
  if (process.platform !== 'darwin') {
    return false;
  }
  try {
    const { isModifierPressed: nativeIsModifierPressed } =
      // eslint-disable-next-line @typescript-eslint/no-require-imports, no-restricted-syntax
      require('@qwen-code/modifiers-napi') as {
        isModifierPressed: (m: string) => boolean;
      };
    return nativeIsModifierPressed(modifier);
  } catch {
    return false;
  }
}
