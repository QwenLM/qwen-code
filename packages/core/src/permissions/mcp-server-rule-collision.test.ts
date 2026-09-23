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
import { DiscoveredMCPTool } from '../tools/mcp-tool.js';
import type { CallableTool } from '@google/genai';

// `foo.bar` and `foo_bar` are two different MCP servers. Registration keeps
// them apart -- the dotted one is not provider-safe, so it gets a hash suffix --
// which means the collision can only be re-introduced in the matching layer.
const DOTTED_SERVER_TOOL = normalizeToolNameForProvider('mcp__foo.bar__evil');
const SAFE_SERVER_TOOL = 'mcp__foo_bar__evil';

/**
 * Builds the tool exactly as MCP discovery builds it, so the permission
 * aliases under test are the tool's own advertised `permissionAliases` — the
 * exact raw identity first, then the legacy spelling — never a hand-written
 * stand-in that could drift from the producer.
 */
const callableTool = { callTool: async () => [] } as unknown as CallableTool;
function prodTool(
  serverName: string,
  serverToolName: string,
): DiscoveredMCPTool {
  return new DiscoveredMCPTool(
    callableTool,
    serverName,
    serverToolName,
    'test tool',
    {},
  );
}

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
    // `permissionAliases`; with no alias channel a legacy unsafe spelling
    // cannot be distinguished from a different server that merely sanitizes
    // into the same prefix (#10199).
    expect(
      matchesMcpPattern(
        'mcp__foo.bar',
        DOTTED_SERVER_TOOL,
        'mcp__foo.bar__evil',
      ),
    ).toBe(true);
    expect(
      matchesMcpPattern(
        'mcp__foo.bar__*',
        DOTTED_SERVER_TOOL,
        'mcp__foo.bar__evil',
      ),
    ).toBe(true);
    expect(matchesMcpPattern('mcp__foo_bar', SAFE_SERVER_TOOL)).toBe(true);
  });

  it('keeps a legacy dotted server rule on its own tool when both segments are unsafe', () => {
    // `literature.search_pubmed` sanitizes to `literature_search_pubmed`, so
    // the registered name alone cannot recover the dotted spelling; the raw
    // identity carried by `permissionAliases` is what keeps this rule
    // effective. For this name the legacy reduction is lossless, so the raw
    // spelling is the only alias the tool advertises.
    const tool = prodTool('zybio.db', 'literature.search_pubmed');
    const rawName = 'mcp__zybio.db__literature.search_pubmed';
    const rule = parseRule('mcp__zybio.db');

    expect(tool.name).not.toBe(rawName);
    expect(tool.permissionAliases).toEqual([rawName]);
    expect(
      matchesRule(
        rule,
        tool.name,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        tool.permissionAliases,
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

// The alias channel carries the exact raw identity the registered name lost,
// ahead of the legacy spelling. These rows resolve the aliases through the
// producer (`DiscoveredMCPTool.permissionAliases`), the way every production
// caller receives them.
describe('the alias channel (#10199 review follow-ups)', () => {
  it('publishes the exact raw identity ahead of the legacy spelling', () => {
    const colonServerTool = prodTool('foo:bar', 'a'.repeat(45));
    const raw = `mcp__foo:bar__${'a'.repeat(45)}`;
    expect(colonServerTool.permissionAliases[0]).toBe(raw);
    expect(colonServerTool.permissionAliases).toContain(
      generateLegacyMcpToolName(raw),
    );

    // A verbatim provider-safe registration publishes nothing: the registered
    // name IS the raw identity, so no spelling was lost.
    expect(prodTool('foo_bar', 'evil').permissionAliases).toEqual([]);

    // A dot-only raw name survives the legacy reduction losslessly, so the
    // raw spelling is published once, not duplicated.
    expect(prodTool('foo.bar', 'evil').permissionAliases).toEqual([
      'mcp__foo.bar__evil',
    ]);
  });

  it('keeps a deny rule effective when the tool segment is lossy', async () => {
    const tool = prodTool('foo.bar', 'my+tool');
    const raw = 'mcp__foo.bar__my+tool';
    const legacy = generateLegacyMcpToolName(raw);
    expect(legacy).toBe('mcp__foo.bar__my_tool');
    expect(tool.permissionAliases).toEqual([raw, legacy]);

    // The raw identity's server segment matches the rule's server verbatim,
    // so the rule reaches its own server's tool even though the legacy
    // spelling lost the `+`.
    expect(
      matchesRule(
        parseRule('mcp__foo.bar'),
        tool.name,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        tool.permissionAliases,
      ),
    ).toBe(true);

    const pm = new PermissionManager(
      makeConfig({ permissionsDeny: ['mcp__foo.bar'] }),
    );
    pm.initialize();
    expect(
      await pm.evaluate({
        toolName: tool.name,
        toolAliases: tool.permissionAliases,
      }),
    ).toBe('deny');
  });

  it('keeps a deny rule effective past the 63-char truncation', async () => {
    const tool = prodTool('foo.bar', 'a'.repeat(60));
    const legacy = generateLegacyMcpToolName('mcp__foo.bar__' + 'a'.repeat(60));
    expect(legacy).toContain('___'); // middle-truncated

    const pm = new PermissionManager(
      makeConfig({ permissionsDeny: ['mcp__foo.bar'] }),
    );
    pm.initialize();
    expect(
      await pm.evaluate({
        toolName: tool.name,
        toolAliases: tool.permissionAliases,
      }),
    ).toBe('deny');
  });

  it('does not let the alias channel reach a different server', () => {
    // The raw identity's server segment is the tool's OWN server name from
    // the user's config, so a tool of `foo_bar` can never satisfy a rule
    // written for `foo.bar` — the #10199 collision stays closed.
    const otherServer = prodTool('foo_bar', 'evil');
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
        otherServer.permissionAliases,
      ),
    ).toBe(false);
  });

  it('threads aliases through matchesToolPattern (the blocklist predicate)', () => {
    const tool = prodTool('zybio.db', 'literature.search_pubmed');

    expect(
      matchesToolPattern('mcp__zybio.db', tool.name, tool.permissionAliases),
    ).toBe(true);
    // Without the alias channel the registered name alone cannot recover the
    // dotted server segment.
    expect(matchesToolPattern('mcp__zybio.db', tool.name)).toBe(false);
  });

  it('lets getToolRegistrationStatus disable a legacy-denied tool when the alias is supplied', async () => {
    const tool = prodTool('zybio.db', 'literature.search_pubmed');
    const pm = new PermissionManager(
      makeConfig({ permissionsDeny: ['mcp__zybio.db'] }),
    );
    pm.initialize();

    expect(
      await pm.getToolRegistrationStatus(tool.name, tool.permissionAliases),
    ).toBe('disabled');
    // The L1 `isToolEnabled` gate forwards the same channel.
    expect(await pm.isToolEnabled(tool.name, tool.permissionAliases)).toBe(
      false,
    );
  });

  it('denies hash lookalikes to a tool that advertised no alias (forged suffix)', async () => {
    // A server registered under the provider-safe key `foo_bar` can name a
    // tool so its verbatim registration is byte-identical to the dotted
    // server's: the tail is just `stableToolNameHash('mcp__foo.bar__evil')`,
    // computable offline in one evaluation. Such a registration advertises
    // no alias — `permissionAliases` is empty when nothing was lost — so no
    // spelling vouches it into a legacy-unsafe rule.
    const forged = DOTTED_SERVER_TOOL;
    expect(forged).toMatch(/_[0-9a-z]{7}$/);

    expect(matchesMcpPattern('mcp__foo.bar', forged)).toBe(false);
    expect(matchesMcpPattern('mcp__foo.bar__*', forged)).toBe(false);
    expect(matchesMcpPattern('mcp__foo.bar__evil', forged)).toBe(false);

    const pm = new PermissionManager(
      makeConfig({ permissionsAllow: ['mcp__foo.bar'] }),
    );
    pm.initialize();
    expect(await pm.evaluate({ toolName: forged, toolAliases: [] })).toBe(
      'default',
    );

    // The exact 3-part rule shape is denied too: the forged registration is
    // byte-identical to the genuine dotted server's, and with no advertised
    // alias nothing distinguishes it — so it must fall back to a prompt.
    const pmExact = new PermissionManager(
      makeConfig({ permissionsAllow: ['mcp__foo.bar__evil'] }),
    );
    pmExact.initialize();
    expect(await pmExact.evaluate({ toolName: forged, toolAliases: [] })).toBe(
      'default',
    );

    // Control: the genuine dotted server's tool DOES advertise its raw
    // identity and is still matched.
    expect(
      await pm.evaluate({
        toolName: forged,
        toolAliases: prodTool('foo.bar', 'evil').permissionAliases,
      }),
    ).toBe('allow');
  });
});

// Every witness below was measured against the pre-fix matcher: each is a
// rule written for one MCP server that the old reconstruction machinery let
// a *different* server's tool satisfy (or vice versa). The fix publishes the
// tool's exact raw identity through `permissionAliases` and compares
// literally; nothing is hashed and nothing is reconstructed.
describe('cross-server forgery witnesses (round-2 review)', () => {
  it('denies a verbatim registration whose tail imitates the hash of a dotted exact rule', async () => {
    // Victim: `permissions.allow: ['mcp__foo.bar__evil']`, persisted before
    // provider-safe names. Attacker: a server keyed `foo_bar` whose peer
    // names its tool `evil_1oxrpi0`, where the tail is
    // `stableToolNameHash('mcp__foo.bar__evil')` — one offline FNV-1a
    // evaluation. The raw name is provider-safe, so it registers verbatim,
    // byte-identical to the victim server's own registration, and advertises
    // no alias.
    const attacker = prodTool('foo_bar', 'evil_1oxrpi0');
    expect(attacker.name).toBe('mcp__foo_bar__evil_1oxrpi0');
    expect(attacker.name).toBe(DOTTED_SERVER_TOOL);
    expect(attacker.permissionAliases).toEqual([]);

    expect(matchesMcpPattern('mcp__foo.bar__evil', attacker.name)).toBe(false);
    expect(matchesRule(parseRule('mcp__foo.bar__evil'), attacker.name)).toBe(
      false,
    );

    const pm = new PermissionManager(
      makeConfig({ permissionsAllow: ['mcp__foo.bar__evil'] }),
    );
    pm.initialize();
    expect(
      await pm.evaluate({
        toolName: attacker.name,
        toolAliases: attacker.permissionAliases,
      }),
    ).toBe('default');
  });

  it('denies the zybio-shaped exact-rule forgery (second witness)', async () => {
    const attacker = prodTool('zybio_db', 'literature_search_0qeuuzz');
    expect(attacker.name).toBe(
      normalizeToolNameForProvider('mcp__zybio.db__literature.search'),
    );
    expect(attacker.permissionAliases).toEqual([]);

    const rule = 'mcp__zybio.db__literature.search';
    expect(matchesMcpPattern(rule, attacker.name)).toBe(false);

    const pm = new PermissionManager(makeConfig({ permissionsAllow: [rule] }));
    pm.initialize();
    expect(
      await pm.evaluate({
        toolName: attacker.name,
        toolAliases: attacker.permissionAliases,
      }),
    ).toBe('default');
  });

  it('denies a colon-keyed server imitating a dotted server (unkeyed-hash entrance)', async () => {
    // Server key `foo:bar`, peer tool name `evil[a b#c#d"e~f|x`: the rebuilt
    // candidate `mcp__foo.bar__evil_a_b_c_d_e_f_x` hashed to the same suffix,
    // so the old reconstruction verified the forgery.
    const attacker = prodTool('foo:bar', 'evil[a b#c#d"e~f|x');
    expect(attacker.name).toBe('mcp__foo_bar__evil_a_b_c_d_e_f_x_139klae');
    expect(attacker.permissionAliases.length).toBeGreaterThan(0);

    expect(
      matchesRule(
        parseRule('mcp__foo.bar'),
        attacker.name,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        attacker.permissionAliases,
      ),
    ).toBe(false);

    const pm = new PermissionManager(
      makeConfig({ permissionsAllow: ['mcp__foo.bar'] }),
    );
    pm.initialize();
    expect(
      await pm.evaluate({
        toolName: attacker.name,
        toolAliases: attacker.permissionAliases,
      }),
    ).toBe('default');
  });

  it('denies an overlong provider-safe raw imitating a dotted server (second unkeyed-hash entrance)', async () => {
    // Provider normalization hashes on LENGTH, not on safety: this 64-char
    // provider-safe raw registers byte-identical to the dotted victim's
    // registration (the tail was found by a meet-in-the-middle search over
    // FNV-1a's invertible per-byte step).
    const attacker = prodTool(
      'foo_bar',
      'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaalrksaapap',
    );
    expect(attacker.name).toBe(`mcp__foo_bar__${'a'.repeat(41)}_0lt68rp`);
    expect(attacker.permissionAliases.length).toBeGreaterThan(0);

    expect(
      matchesRule(
        parseRule('mcp__foo.bar'),
        attacker.name,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        attacker.permissionAliases,
      ),
    ).toBe(false);

    const pm = new PermissionManager(
      makeConfig({ permissionsAllow: ['mcp__foo.bar'] }),
    );
    pm.initialize();
    expect(
      await pm.evaluate({
        toolName: attacker.name,
        toolAliases: attacker.permissionAliases,
      }),
    ).toBe('default');
  });

  it('does not let a middle-truncated alias reach a shorter server rule', async () => {
    // `generateLegacyMcpToolName` cuts at slice(0, 28), so for any server key
    // of 24+ characters the legacy alias's server segment is the key's first
    // 23 characters and the injected `___` supplies the `__` separator a
    // prefix match needs: a rule for `weather-forecast-server` used to reach
    // this DIFFERENT server's tool through that alias.
    const premium = prodTool(
      'weather-forecast-server-premium',
      'get_extended_forecast_for_next_week',
    );
    const legacyAlias = generateLegacyMcpToolName(
      'mcp__weather-forecast-server-premium__get_extended_forecast_for_next_week',
    );
    expect(legacyAlias.split('__')[1]).toBe('weather-forecast-server');

    const rule = parseRule('mcp__weather-forecast-server');
    expect(
      matchesRule(
        rule,
        premium.name,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        premium.permissionAliases,
      ),
    ).toBe(false);
    expect(
      matchesToolPattern(
        'mcp__weather-forecast-server',
        premium.name,
        premium.permissionAliases,
      ),
    ).toBe(false);

    const pm = new PermissionManager(
      makeConfig({ permissionsAllow: ['mcp__weather-forecast-server'] }),
    );
    pm.initialize();
    expect(
      await pm.evaluate({
        toolName: premium.name,
        toolAliases: premium.permissionAliases,
      }),
    ).toBe('default');

    // The tool's OWN server rule keeps matching.
    expect(
      matchesRule(
        parseRule('mcp__weather-forecast-server-premium'),
        premium.name,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        premium.permissionAliases,
      ),
    ).toBe(true);
  });
});

// Legacy-spelled rules keep covering the tool they name at any raw length and
// any character set, because the channel carries the exact raw identity.
// Each of these was a measured fail-open regression on the pre-fix matcher.
describe('legacy-spelled deny coverage (round-2 review)', () => {
  it('keeps a deny rule on a colon-keyed server effective (out-of-set server character)', async () => {
    const tool = prodTool('foo:bar', 'a.b');
    expect(tool.name).toBe('mcp__foo_bar__a_b_1aofxjh');

    expect(
      matchesToolPattern('mcp__foo:bar', tool.name, tool.permissionAliases),
    ).toBe(true);

    const pm = new PermissionManager(
      makeConfig({ permissionsDeny: ['mcp__foo:bar'] }),
    );
    pm.initialize();
    expect(
      await pm.evaluate({
        toolName: tool.name,
        toolAliases: tool.permissionAliases,
      }),
    ).toBe('deny');
    expect(
      await pm.getToolRegistrationStatus(tool.name, tool.permissionAliases),
    ).toBe('disabled');
    // Pin the unthreaded-caller posture: without the alias channel the
    // registered name alone cannot recover the colon, so the deny is lost —
    // which is exactly why every caller resolves aliases from the registry.
    expect(await pm.evaluate({ toolName: tool.name })).toBe('default');
  });

  it('keeps server-level rules on a long dotted server key effective past the truncation head', () => {
    // A server key of 24+ characters puts the legacy middle-truncation head
    // INSIDE the server segment, so the legacy alias cannot vouch for the
    // server; the raw identity can.
    const tool = prodTool(
      'com.example.enterprise-search',
      'list_all_documents_in_corpus',
    );
    expect(
      matchesRule(
        parseRule('mcp__com.example.enterprise-search'),
        tool.name,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        tool.permissionAliases,
      ),
    ).toBe(true);
    expect(
      matchesRule(
        parseRule('mcp__com.example.enterprise-search__*'),
        tool.name,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        tool.permissionAliases,
      ),
    ).toBe(true);
  });

  it('keeps a tool-prefixed wildcard on a dotted server effective', async () => {
    const tool = prodTool(
      'zybio.db',
      'literature.search_pubmed_advanced_query_with_filters_and_options',
    );
    const rule = 'mcp__zybio.db__literature.search_*';
    expect(
      matchesRule(
        parseRule(rule),
        tool.name,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        tool.permissionAliases,
      ),
    ).toBe(true);

    const pm = new PermissionManager(makeConfig({ permissionsDeny: [rule] }));
    pm.initialize();
    expect(
      await pm.evaluate({
        toolName: tool.name,
        toolAliases: tool.permissionAliases,
      }),
    ).toBe('deny');
  });

  it('pins the coverage boundary: a colon-keyed server is denied at every raw length', async () => {
    // The old hash reconstruction stopped verifying at raw length 56 (the
    // sanitized body is sliced to 63 - 8 = 55) and never recovered; the
    // legacy alias middle-truncates past 63. Literal comparison against the
    // raw identity has no length boundary.
    for (const rawLength of [15, 44, 55, 56, 59, 63, 64, 69, 74, 80]) {
      const toolNameLength = rawLength - 'mcp__foo:bar__'.length;
      const tool = prodTool('foo:bar', 'x'.repeat(toolNameLength));
      const pm = new PermissionManager(
        makeConfig({ permissionsDeny: ['mcp__foo:bar'] }),
      );
      pm.initialize();
      expect(
        await pm.evaluate({
          toolName: tool.name,
          toolAliases: tool.permissionAliases,
        }),
      ).toBe('deny');
      expect(
        await pm.getToolRegistrationStatus(tool.name, tool.permissionAliases),
      ).toBe('disabled');
    }
  });

  it('keeps a dotted server matching at every raw length', async () => {
    for (const rawLength of [15, 44, 55, 56, 59, 63, 64, 69, 74, 80]) {
      const toolNameLength = rawLength - 'mcp__foo.bar__'.length;
      const tool = prodTool('foo.bar', 'x'.repeat(toolNameLength));
      const pm = new PermissionManager(
        makeConfig({ permissionsDeny: ['mcp__foo.bar'] }),
      );
      pm.initialize();
      expect(
        await pm.evaluate({
          toolName: tool.name,
          toolAliases: tool.permissionAliases,
        }),
      ).toBe('deny');
    }
  });

  it('lets matchesToolPattern consume an exact alias-spelled entry (deny/disallowedTools agreement)', () => {
    // `get+data` registers as `mcp__srv__get_data_04b75xd`; the legacy
    // spelling `mcp__srv__get_data` is what a pre-normalization agent file
    // holds. matchesRule already matched it via the legacy-exact arm; the
    // blocklist predicate now shares that arm.
    const tool = prodTool('srv', 'get+data');
    expect(tool.name).toBe('mcp__srv__get_data_04b75xd');
    const entry = 'mcp__srv__get_data';

    expect(matchesToolPattern(entry, tool.name, tool.permissionAliases)).toBe(
      true,
    );
    expect(
      matchesRule(
        parseRule(entry),
        tool.name,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        tool.permissionAliases,
      ),
    ).toBe(true);
    // The raw spelling names it exactly too.
    expect(
      matchesToolPattern(
        'mcp__srv__get+data',
        tool.name,
        tool.permissionAliases,
      ),
    ).toBe(true);
  });
});
