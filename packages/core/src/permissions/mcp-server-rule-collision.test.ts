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
import {
  generateLegacyMcpToolName,
  normalizeToolNameForProvider,
} from '../utils/tool-name-utils.js';

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
    // The raw identity arrives through the tool's advertised
    // `permissionAliases`; with no alias channel a legacy unsafe spelling no
    // longer verifies against the hash, because a hash-shaped suffix alone is
    // forgeable (see the forgery describe below).
    expect(
      matchesMcpPattern(
        'mcp__foo.bar',
        DOTTED_SERVER_TOOL,
        'mcp__foo.bar__evil',
        true,
      ),
    ).toBe(true);
    expect(
      matchesMcpPattern(
        'mcp__foo.bar__*',
        DOTTED_SERVER_TOOL,
        'mcp__foo.bar__evil',
        true,
      ),
    ).toBe(true);
    expect(matchesMcpPattern('mcp__foo_bar', SAFE_SERVER_TOOL)).toBe(true);
  });

  it('keeps a legacy dotted server rule on its own tool when both segments are unsafe', () => {
    // `literature.search_pubmed` sanitizes to `literature_search_pubmed`, so
    // the registered name's hash cannot be rebuilt from it; the raw identity
    // carried by `permissionAliases` is what keeps this rule effective. The
    // alias is built the way production builds it — for this name the legacy
    // reduction is lossless, so it equals the raw spelling.
    const rawName = 'mcp__zybio.db__literature.search_pubmed';
    const registeredName = normalizeToolNameForProvider(rawName);
    const alias = generateLegacyMcpToolName(rawName);
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
        [alias],
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

// The alias channel carries the raw identity the registered name lost.
// Production builds the alias as `generateLegacyMcpToolName(raw)` — a second
// lossy reduction (keeps `.` and `-`, middle-truncates past 63 chars), NOT the
// raw spelling — so these rows construct it exactly that way.
describe('the alias channel (#10199 review follow-ups)', () => {
  const prodAlias = (raw: string) => generateLegacyMcpToolName(raw);

  it('keeps a deny rule effective when the tool segment is lossy', async () => {
    const raw = 'mcp__foo.bar__my+tool';
    const registered = normalizeToolNameForProvider(raw);
    const alias = prodAlias(raw);
    expect(alias).toBe('mcp__foo.bar__my_tool');
    expect(alias).not.toBe(raw);

    // The alias's server segment matches the rule's server verbatim, so the
    // rule reaches its own server's tool even though the alias is not the
    // raw name and no normalization of it equals the registered name.
    expect(
      matchesRule(
        parseRule('mcp__foo.bar'),
        registered,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        [alias],
      ),
    ).toBe(true);

    const pm = new PermissionManager(
      makeConfig({ permissionsDeny: ['mcp__foo.bar'] }),
    );
    pm.initialize();
    expect(
      await pm.evaluate({ toolName: registered, toolAliases: [alias] }),
    ).toBe('deny');
  });

  it('keeps a deny rule effective past the 63-char truncation', async () => {
    const raw = `mcp__foo.bar__${'a'.repeat(60)}`;
    const registered = normalizeToolNameForProvider(raw);
    const alias = prodAlias(raw);
    expect(alias).toContain('___'); // middle-truncated

    const pm = new PermissionManager(
      makeConfig({ permissionsDeny: ['mcp__foo.bar'] }),
    );
    pm.initialize();
    expect(
      await pm.evaluate({ toolName: registered, toolAliases: [alias] }),
    ).toBe('deny');
  });

  it('does not let the relaxed alias gate reach a different server', () => {
    // The alias's server segment is the tool's OWN server name, so a tool of
    // `foo_bar` can never satisfy a rule written for `foo.bar` — the #10199
    // collision stays closed.
    const otherServerAlias = prodAlias('mcp__foo_bar__evil');
    expect(
      matchesRule(
        parseRule('mcp__foo.bar'),
        SAFE_SERVER_TOOL,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        [otherServerAlias],
      ),
    ).toBe(false);
  });

  it('threads aliases through matchesToolPattern (the blocklist predicate)', () => {
    const raw = 'mcp__zybio.db__literature.search_pubmed';
    const registered = normalizeToolNameForProvider(raw);

    expect(
      matchesToolPattern('mcp__zybio.db', registered, [prodAlias(raw)]),
    ).toBe(true);
    // Without the alias channel the registered name alone cannot recover the
    // dotted server segment.
    expect(matchesToolPattern('mcp__zybio.db', registered)).toBe(false);
  });

  it('lets getToolRegistrationStatus disable a legacy-denied tool when the alias is supplied', async () => {
    const raw = 'mcp__zybio.db__literature.search_pubmed';
    const registered = normalizeToolNameForProvider(raw);
    const pm = new PermissionManager(
      makeConfig({ permissionsDeny: ['mcp__zybio.db'] }),
    );
    pm.initialize();

    expect(
      await pm.getToolRegistrationStatus(registered, [prodAlias(raw)]),
    ).toBe('disabled');
  });

  it('denies the hash fallback to a tool that advertised no alias (forged suffix)', async () => {
    // A server registered under the provider-safe key `foo_bar` can name a
    // tool so its verbatim registration is byte-identical to the dotted
    // server's: the tail is just `stableToolNameHash('mcp__foo.bar__evil')`,
    // computable offline in one evaluation. Such a registration advertises
    // no alias — `permissionAliases` is empty when the legacy spelling equals
    // the registered one — which is exactly what the fallback now requires.
    const forged = DOTTED_SERVER_TOOL;
    expect(forged).toMatch(/_[0-9a-z]{7}$/);

    expect(matchesMcpPattern('mcp__foo.bar', forged)).toBe(false);
    expect(matchesMcpPattern('mcp__foo.bar', forged, undefined, false)).toBe(
      false,
    );

    const pm = new PermissionManager(
      makeConfig({ permissionsAllow: ['mcp__foo.bar'] }),
    );
    pm.initialize();
    expect(await pm.evaluate({ toolName: forged, toolAliases: [] })).toBe(
      'default',
    );

    // Control: the genuine dotted server's tool DOES advertise the alias and
    // is still matched.
    expect(
      await pm.evaluate({
        toolName: forged,
        toolAliases: ['mcp__foo.bar__evil'],
      }),
    ).toBe('allow');
  });
});
