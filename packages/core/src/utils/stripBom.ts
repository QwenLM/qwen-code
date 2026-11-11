/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Strip UTF-8 BOM (U+FEFF) from the start of a string.
 *
 * PowerShell 5.x writes UTF-8 with BOM by default (Out-File, Set-Content).
 * Users editing settings.json or other config files on Windows may
 * inadvertently introduce a BOM, causing JSON.parse to fail with
 * "Unexpected token".
 */

const UTF8_BOM = '\uFEFF';

export function stripBOM(content: string): string {
  return content.startsWith(UTF8_BOM) ? content.slice(1) : content;
}
