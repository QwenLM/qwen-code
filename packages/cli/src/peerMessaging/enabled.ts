/**
 * @license
 * Copyright 2026 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Whether this session takes part in cross-session messaging.
 *
 * On unless the user turned it off. The schema defaults the setting to
 * `true`, but merged settings carry only what some scope actually wrote,
 * so an unset key reaches every reader as `undefined` and has to be read
 * as the default here rather than as "off". Anything that is not a
 * boolean fails closed: a value the reader does not recognize must not
 * open a socket, which is also the rank `WORKSPACE_TIGHTEN_ONLY_SETTINGS`
 * gives it.
 *
 * The one place this question is answered, so the interactive UI, the
 * ACP agent and `/peers` cannot drift on what "on" means.
 */
export function isCrossSessionMessagingEnabled(
  settings: { agents?: { crossSessionMessaging?: unknown } } | undefined,
): boolean {
  const value = settings?.agents?.crossSessionMessaging;
  return value === undefined || value === true;
}
