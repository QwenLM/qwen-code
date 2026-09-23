/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import { matchesMcpPattern, matchesRule, parseRule } from './rule-parser.js';
import { PermissionManager } from './permission-manager.js';
import type { PermissionManagerConfig } from './permission-manager.js';
import { normalizeToolNameForProvider } from '../utils/tool-name-utils.js';

// `foo.bar` and `foo_bar` are two different MCP servers. Registration keeps
// them apart -- the dotted one is not provider-safe, so it gets a hash suffix --
// which means the collision can only be re-introduced in the matching layer.
const DOTTED_SERVER_TOOL = normalizeToolNameForProvider('mcp__foo.bar__evil');
const SAFE_SERVER_TOOL = 'mcp__foo_bar__evil';

function makeConfig(
  opts: Partial<{
    permissionsAllow: string[];
    permissionsAsk: string[];
    permissionsDeny: string[];
  }> = {},
): PermissionManagerConfig {
  return {
    getPermissionsAllow: () => opts.permissionsAllow,
    getPermissionsAsk: () => opts.permissionsAsk,
    getPermissionsDeny: () => opts.permissionsDeny,
    getProjectRoot: () => '/project',
    getCwd: () => '/project',
    getApprovalMode: () => 'default',
  } as PermissionManagerConfig;
}

describe('MCP server rule collision (#10199 variant 1)', () => {
  it('keeps the two servers apart at registration', () => {
    // The dotted server is not provider-safe, so registration appends a hash:
    // the two tools never share a registered name.
    expect(DOTTED_SERVER_TOOL).not.toBe(SAFE_SERVER_TOOL);
    expect(DOTTED_SERVER_TOOL.startsWith(`${SAFE_SERVER_TOOL}_`)).toBe(true);
  });

  it('does not match a foo_bar tool against a server-level foo.bar rule', () => {
    expect(matchesMcpPattern('mcp__foo.bar', SAFE_SERVER_TOOL)).toBe(false);
  });

  it('does not match a foo_bar tool against a wildcard foo.bar rule', () => {
    expect(matchesMcpPattern('mcp__foo.bar__*', SAFE_SERVER_TOOL)).toBe(false);
  });

  it('does not match a foo_bar tool through matchesRule', () => {
    expect(matchesRule(parseRule('mcp__foo.bar'), SAFE_SERVER_TOOL)).toBe(
      false,
    );
    expect(matchesRule(parseRule('mcp__foo.bar__*'), SAFE_SERVER_TOOL)).toBe(
      false,
    );
  });

  it('does not let a foo.bar allow rule skip confirmation for a foo_bar tool', async () => {
    const pm = new PermissionManager(
      makeConfig({ permissionsAllow: ['mcp__foo.bar'] }),
    );
    pm.initialize();

    expect(await pm.evaluate({ toolName: SAFE_SERVER_TOOL })).toBe('default');
  });

  it('still matches the dotted server own tools', () => {
    expect(matchesMcpPattern('mcp__foo.bar', DOTTED_SERVER_TOOL)).toBe(true);
    expect(matchesMcpPattern('mcp__foo.bar__*', DOTTED_SERVER_TOOL)).toBe(true);
    expect(matchesMcpPattern('mcp__foo_bar', SAFE_SERVER_TOOL)).toBe(true);
  });

  it('keeps a legacy dotted server rule on its own tool when both segments are unsafe', () => {
    // `literature.search_pubmed` sanitizes to `literature_search_pubmed`, so
    // the registered name's hash cannot be rebuilt from it; the raw identity
    // carried by `permissionAliases` is what keeps this rule effective.
    const rawName = 'mcp__zybio.db__literature.search_pubmed';
    const registeredName = normalizeToolNameForProvider(rawName);
    const rule = parseRule('mcp__zybio.db');

    expect(registeredName).not.toBe(rawName);
    expect(
      matchesRule(
        rule,
        registeredName,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        [rawName],
      ),
    ).toBe(true);
    // The same rule must not reach a different server that merely sanitizes
    // into the same prefix.
    expect(
      matchesRule(
        rule,
        'mcp__zybio_db__literature_search_pubmed',
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        ['mcp__zybio_db__literature_search_pubmed'],
      ),
    ).toBe(false);
  });
});
