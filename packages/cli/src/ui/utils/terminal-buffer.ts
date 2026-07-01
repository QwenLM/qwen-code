/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

export function shouldUseVirtualViewport(
  useTerminalBuffer: boolean | undefined,
  screenReader: boolean,
): boolean {
  // The settings loader does not apply schema defaults, so keep this fallback
  // in sync with settingsSchema.ts's default for ui.useTerminalBuffer.
  return (useTerminalBuffer ?? true) && !screenReader;
}
