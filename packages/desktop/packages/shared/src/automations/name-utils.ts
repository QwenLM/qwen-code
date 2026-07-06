/**
 * Automation Naming Utilities (browser-safe)
 *
 * Shared helpers for deriving human-readable names from automation matchers.
 * This file is intentionally free of Node.js APIs (process, fs, crypto, shell)
 * so it can be used by both server-side and renderer code.
 */

import type { AutomationMatcher } from './types.ts';

/**
 * Derive a human-readable name from an automation matcher.
 *
 * Priority:
 * 1. Explicit `matcher.name`
 * 2. First prompt action's `@mention` → "<mention> prompt"
 * 3. First prompt action's prompt text (truncated to 40 chars)
 * 4. First webhook action's URL (truncated to 40 chars)
 * 5. Event name fallback (raw event string)
 */
export function deriveAutomationName(event: string, matcher: AutomationMatcher): string {
  if (matcher.name) return matcher.name;

  const firstAction = matcher.actions[0];
  if (!firstAction) return event;

  if (firstAction.type === 'webhook') {
    const label = `Webhook ${firstAction.method ?? 'POST'} ${firstAction.url}`;
    return label.length > 40 ? label.slice(0, 40) + '...' : label;
  }

  // Extract @skill/@source mention
  const mentionMatch = firstAction.prompt.match(/@(\S+)/);
  if (mentionMatch) return `${mentionMatch[1]} prompt`;

  return firstAction.prompt.length > 40
    ? firstAction.prompt.slice(0, 40) + '...'
    : firstAction.prompt;
}
