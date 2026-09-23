/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import {
  matchesMcpPattern,
  matchesRule,
  matchesToolPattern,
  parseRule,
} from './rule-parser.js';
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

// A bare `*` is not an MCP pattern. Dropping the `sanitizeToolNameForProvider`
// reduction also dropped its letter-guard, which turned the empty prefix into
// `tool_` -- a prefix no `mcp__` name starts with -- so `*` used to match no
// MCP tool. Without the empty-prefix guard it matches every one of them, while
// built-ins keep prompting, i.e. `permissions.allow: ['*']` silently
// auto-approves exactly the tool class whose own default is `ask`.
describe('bare "*" does not become an MCP match-all', () => {
  it('does not match MCP tools at any layer', () => {
    expect(matchesMcpPattern('*', SAFE_SERVER_TOOL)).toBe(false);
    expect(matchesMcpPattern('*', DOTTED_SERVER_TOOL)).toBe(false);
    expect(matchesToolPattern('*', SAFE_SERVER_TOOL)).toBe(false);
    expect(matchesRule(parseRule('*'), SAFE_SERVER_TOOL)).toBe(false);
  });

  it('does not let a bare star allow rule skip confirmation', async () => {
    const pm = new PermissionManager(makeConfig({ permissionsAllow: ['*'] }));
    pm.initialize();

    expect(await pm.evaluate({ toolName: SAFE_SERVER_TOOL })).toBe('default');
    expect(await pm.evaluate({ toolName: DOTTED_SERVER_TOOL })).toBe('default');
  });

  it('keeps the documented match-all MCP forms working', () => {
    expect(matchesMcpPattern('mcp__*', SAFE_SERVER_TOOL)).toBe(true);
    expect(matchesMcpPattern('mcp__*', DOTTED_SERVER_TOOL)).toBe(true);
    expect(matchesToolPattern('mcp__foo_bar__*', SAFE_SERVER_TOOL)).toBe(true);
  });
});
