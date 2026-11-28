/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Who may use an MCP tool. MCP Apps tools declare `_meta.ui.visibility`; a
 * tool without it is offered to both. For the model an invalid declaration
 * fails closed: a string `"app"` means app-only, so admitting it would let
 * the model call a tool meant for the app only.
 */
export type McpToolAudience = 'model' | 'app';

export function isMcpAppToolVisible(
  tool: unknown,
  audience: McpToolAudience,
): boolean {
  const meta = record(tool)?.['_meta'];
  const ui = record(record(meta)?.['ui']);
  if (!ui || !Object.hasOwn(ui, 'visibility')) return true;
  const visibility = ui['visibility'];
  if (audience === 'model') {
    return Array.isArray(visibility) && visibility.includes('model');
  }
  return (
    Array.isArray(visibility) &&
    visibility.every((value) => value === 'model' || value === 'app') &&
    visibility.includes(audience)
  );
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}
