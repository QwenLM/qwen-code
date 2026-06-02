/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import * as crypto from 'node:crypto';
import type { MCPServerConfig } from '../config/config.js';

/**
 * Top-level fields excluded from the approval hash: pure provenance / cosmetic
 * metadata that does not change what the server executes or connects to.
 * Editing these must NOT send an approved project-scoped server back to
 * `pending` — only behavioral changes (command/args/env/url/headers/...) do.
 */
const NON_BEHAVIORAL_FIELDS = new Set<string>([
  'scope', // where the config came from (settings / .mcp.json / extension)
  'extensionName', // owning extension — provenance only
  'description', // cosmetic label shown in listings
]);

/**
 * Stable, canonical hash of an MCP server config used to bind a user's approval
 * decision to the exact configuration they reviewed. If a project-scoped
 * `.mcp.json` server is later edited, its hash changes and the server returns to
 * `pending` approval (see issue #4615).
 *
 * Object keys are sorted recursively so `{a:1,b:2}` and `{b:2,a:1}` hash the
 * same; array order is preserved (e.g. `args` order is behavioral). Provenance
 * and cosmetic fields are stripped at the TOP level only — a user-defined nested
 * key that happens to be named e.g. `description` inside `env`/`headers` is
 * still hashed.
 *
 * Claude Code truncates similar hashes for reload detection, where collisions
 * are harmless. Approval binding is security-sensitive, so keep the full digest.
 */
export function hashMcpServerConfig(config: MCPServerConfig): string {
  const behavioral: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(config)) {
    if (!NON_BEHAVIORAL_FIELDS.has(key)) {
      behavioral[key] = value;
    }
  }

  const stable = JSON.stringify(behavioral, (_key, value) => {
    if (value && typeof value === 'object' && !Array.isArray(value)) {
      const obj = value as Record<string, unknown>;
      const sorted: Record<string, unknown> = {};
      for (const k of Object.keys(obj).sort()) {
        sorted[k] = obj[k];
      }
      return sorted;
    }
    return value;
  });

  return crypto.createHash('sha256').update(stable).digest('hex');
}
