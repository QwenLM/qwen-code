/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

export function hasRootlessMarker(info: string): boolean {
  try {
    const parsed = JSON.parse(info) as {
      SecurityOptions?: unknown;
      Host?: { Security?: { Rootless?: unknown } };
      host?: { security?: { rootless?: unknown } };
    } | null;
    // Unknown runtime shapes retain the host UID/GID mapping.
    return (
      (Array.isArray(parsed?.SecurityOptions) &&
        parsed.SecurityOptions.includes('name=rootless')) ||
      parsed?.Host?.Security?.Rootless === true ||
      parsed?.host?.security?.rootless === true
    );
  } catch {
    return false;
  }
}
