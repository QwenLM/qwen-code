/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import { matchesAgentToolBlocklist } from '../agents/runtime/subagent-plan-tool-policy.js';
import {
  matchesMcpPattern,
  matchesRule,
  matchesToolPattern,
  parseRule,
} from './rule-parser.js';
import { PermissionManager } from './permission-manager.js';
import { evaluatePermissionRules } from '../core/permission-helpers.js';
import type { PermissionManagerConfig } from './permission-manager.js';
import {
  generateLegacyMcpToolName,
  normalizeMcpToolName,
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

const matchesRuleWith = (rule: string, tool: DiscoveredMCPTool) =>
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
  );

function makePm(
  opts: Partial<{
    permissionsAllow: string[];
    permissionsAsk: string[];
    permissionsDeny: string[];
  }> = {},
): PermissionManager {
  const pm = new PermissionManager({
    getPermissionsAllow: () => opts.permissionsAllow,
    getPermissionsAsk: () => opts.permissionsAsk,
    getPermissionsDeny: () => opts.permissionsDeny,
    getProjectRoot: () => '/project',
    getCwd: () => '/project',
    getApprovalMode: () => 'default',
  } as PermissionManagerConfig);
  pm.initialize();
  return pm;
}

const aliasContext = (tool: DiscoveredMCPTool) => ({
  toolName: tool.name,
  toolAliases: tool.permissionAliases,
});

const producerContext = (tool: DiscoveredMCPTool) => ({
  ...aliasContext(tool),
  mcpIdentity: {
    serverName: tool.serverName,
    serverToolName: tool.serverToolName,
  },
});

describe('MCP server rule collision (#10199 variant 1)', () => {
  it('does not match a foo_bar tool against a server-level foo.bar rule', () => {
    expect(matchesMcpPattern('mcp__foo.bar', SAFE_SERVER_TOOL)).toBe(false);
  });

  it('does not match a foo_bar tool against a wildcard foo.bar rule', () => {
    expect(matchesMcpPattern('mcp__foo.bar__*', SAFE_SERVER_TOOL)).toBe(false);
  });

  it('still matches the dotted server own tools', () => {
    // Dotted rules need the raw alias to distinguish the configured key from
    // its provider-safe sibling.
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
});

// Only `mcp__*` is an MCP match-all; an empty wildcard prefix must not grant.
describe('bare "*" does not become an MCP match-all', () => {
  it('does not match MCP tools at any layer', () => {
    expect(matchesMcpPattern('*', SAFE_SERVER_TOOL)).toBe(false);
    expect(matchesMcpPattern('*', DOTTED_SERVER_TOOL)).toBe(false);
    expect(matchesToolPattern('*', SAFE_SERVER_TOOL)).toBe(false);
    expect(matchesRule(parseRule('*'), SAFE_SERVER_TOOL)).toBe(false);
  });

  it('keeps the documented match-all MCP forms working', () => {
    expect(matchesMcpPattern('mcp__*', SAFE_SERVER_TOOL)).toBe(true);
    expect(matchesMcpPattern('mcp__*', DOTTED_SERVER_TOOL)).toBe(true);
    expect(matchesToolPattern('mcp__foo_bar__*', SAFE_SERVER_TOOL)).toBe(true);
  });
});

// Use the real producer so alias publication is part of the contract.
describe('the alias channel', () => {
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
    expect(matchesRuleWith('mcp__foo.bar', tool)).toBe(true);

    const pm = makePm({ permissionsDeny: ['mcp__foo.bar'] });

    expect(await pm.evaluate(aliasContext(tool))).toBe('deny');
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
    const pm = makePm({ permissionsDeny: ['mcp__zybio.db'] });

    expect(
      await pm.getToolRegistrationStatus(tool.name, tool.permissionAliases),
    ).toBe('disabled');
    // The L1 `isToolEnabled` gate forwards the same channel.
    expect(await pm.isToolEnabled(tool.name, tool.permissionAliases)).toBe(
      false,
    );
  });
});

// Different forgery shapes exercise hash imitation and a truncated server key.
describe('cross-server forgery witnesses', () => {
  it('denies a verbatim registration whose tail imitates the hash of a dotted exact rule', async () => {
    // A safe server can choose a tool suffix equal to another raw name's hash.
    // It then registers as the dotted victim without advertising a raw alias.
    const attacker = prodTool('foo_bar', 'evil_1oxrpi0');
    expect(attacker.name).toBe('mcp__foo_bar__evil_1oxrpi0');
    expect(attacker.name).toBe(DOTTED_SERVER_TOOL);
    expect(attacker.permissionAliases).toEqual([]);

    expect(matchesMcpPattern('mcp__foo.bar__evil', attacker.name)).toBe(false);
    expect(matchesRule(parseRule('mcp__foo.bar__evil'), attacker.name)).toBe(
      false,
    );

    const pm = makePm({ permissionsAllow: ['mcp__foo.bar__evil'] });

    expect(await pm.evaluate(aliasContext(attacker))).toBe('default');
  });

  it('denies a colon-keyed server imitating a dotted server', async () => {
    // Server key `foo:bar`, peer tool name `evil[a b#c#d"e~f|x`: the rebuilt
    // candidate `mcp__foo.bar__evil_a_b_c_d_e_f_x` hashed to the same suffix,
    // so the old reconstruction verified the forgery.
    const attacker = prodTool('foo:bar', 'evil[a b#c#d"e~f|x');
    expect(attacker.name).toBe('mcp__foo_bar__evil_a_b_c_d_e_f_x_139klae');
    expect(attacker.permissionAliases.length).toBeGreaterThan(0);

    // The victim the comment above names, constructed instead of left in
    // prose: the dotted server's body registers byte-identical to it.
    const victim = prodTool('foo.bar', 'evil_a_b_c_d_e_f_x');
    expect(attacker.name).toBe(victim.name);

    expect(matchesRuleWith('mcp__foo.bar', attacker)).toBe(false);

    const pm = makePm({ permissionsAllow: ['mcp__foo.bar'] });

    expect(await pm.evaluate(aliasContext(attacker))).toBe('default');
  });

  it('does not let a middle-truncated alias reach a shorter server rule', async () => {
    // The legacy head window cuts the premium key down to the shorter key and
    // injects a separator. That alias must not establish the shorter identity.
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

    // Legacy-only input reaches the vouching guard rather than the first raw
    // alias. Blindly accepting aliases[0] would admit the shorter server.
    expect(normalizeMcpToolName(legacyAlias)).not.toBe(premium.name);
    expect(legacyAlias.startsWith('mcp__weather-forecast-server__')).toBe(true);
    const legacyOnly = [legacyAlias];
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
        legacyOnly,
      ),
    ).toBe(false);
    expect(
      matchesToolPattern(
        'mcp__weather-forecast-server',
        premium.name,
        legacyOnly,
      ),
    ).toBe(false);

    const pm = makePm({ permissionsAllow: ['mcp__weather-forecast-server'] });

    expect(await pm.evaluate(aliasContext(premium))).toBe('default');

    // The tool's OWN server rule keeps matching.
    expect(
      matchesRuleWith('mcp__weather-forecast-server-premium', premium),
    ).toBe(true);
  });

  // Legacy restrictions cannot identify a forged registration without a raw
  // alias; the registered/raw controls pin the supported restriction path.
  it('pins the deny posture: a legacy-spelled deny does not reach a forged verbatim registration', async () => {
    const attacker = prodTool('foo_bar', 'evil_1oxrpi0');
    expect(attacker.permissionAliases).toEqual([]);

    const pm = makePm({ permissionsDeny: ['mcp__foo.bar__evil'] });

    expect(await pm.evaluate(aliasContext(attacker))).toBe('default');
    expect(
      await pm.getToolRegistrationStatus(
        attacker.name,
        attacker.permissionAliases,
      ),
    ).toBe('registered');

    // Control: the same deny in the registered spelling still blocks it.
    const registeredPm = makePm({ permissionsDeny: [attacker.name] });

    expect(await registeredPm.evaluate(aliasContext(attacker))).toBe('deny');
  });

  it('pins the deny posture: a legacy-spelled server deny does not reach a colon-keyed forgery', async () => {
    const attacker = prodTool('foo:bar', 'evil[a b#c#d"e~f|x');

    const pm = makePm({ permissionsDeny: ['mcp__foo.bar'] });

    expect(await pm.evaluate(aliasContext(attacker))).toBe('default');

    // Control: the deny written against the attacker's own raw identity
    // spelling still blocks it.
    const rawPm = makePm({ permissionsDeny: ['mcp__foo:bar'] });

    expect(await rawPm.evaluate(aliasContext(attacker))).toBe('deny');
  });

  // The pure blocklist predicate retains shared legacy spellings. Grants
  // separately check ambiguity against the live registry.
  it('preserves shared exact legacy spellings for blocklist compatibility', () => {
    const attacker = prodTool('foo:bar', 'evil[a b#c#d"e~f|x');
    const sharedLegacySpelling = 'mcp__foo_bar__evil_a_b_c_d_e_f_x';
    expect(attacker.permissionAliases).toContain(sharedLegacySpelling);
    // The cross-server part: the same string IS the verbatim registration of
    // another server's tool.
    expect(prodTool('foo_bar', 'evil_a_b_c_d_e_f_x').name).toBe(
      sharedLegacySpelling,
    );
    expect(
      matchesToolPattern(
        sharedLegacySpelling,
        attacker.name,
        attacker.permissionAliases,
      ),
    ).toBe(true);
  });
});

// Legacy-spelled rules keep covering the tool they name at any raw length and
// any character set, because the channel carries the exact raw identity.
// Each of these was a measured fail-open regression on the pre-fix matcher.
describe('legacy-spelled deny coverage', () => {
  it('keeps a deny rule on a colon-keyed server effective (out-of-set server character)', async () => {
    const tool = prodTool('foo:bar', 'a.b');
    expect(tool.name).toBe('mcp__foo_bar__a_b_1aofxjh');

    expect(
      matchesToolPattern('mcp__foo:bar', tool.name, tool.permissionAliases),
    ).toBe(true);

    const pm = makePm({ permissionsDeny: ['mcp__foo:bar'] });

    expect(await pm.evaluate(aliasContext(tool))).toBe('deny');
    expect(
      await pm.getToolRegistrationStatus(tool.name, tool.permissionAliases),
    ).toBe('disabled');
    // Pin the unthreaded-caller posture: without the alias channel the
    // registered name alone cannot recover the colon, so the deny is lost —
    // which is exactly why every caller resolves aliases from the registry.
    expect(await pm.evaluate({ toolName: tool.name })).toBe('default');
  });

  it('keeps a tool-prefixed wildcard on a dotted server effective', async () => {
    const tool = prodTool(
      'zybio.db',
      'literature.search_pubmed_advanced_query_with_filters_and_options',
    );
    const rule = 'mcp__zybio.db__literature.search_*';
    expect(matchesRuleWith(rule, tool)).toBe(true);

    const pm = makePm({ permissionsDeny: [rule] });

    expect(await pm.evaluate(aliasContext(tool))).toBe('deny');
  });

  it('pins the coverage boundary: a colon-keyed server is denied at every raw length', async () => {
    // Cross the registered 55-character body cut and legacy 63-character budget
    // while keeping the server boundary intact.
    for (const rawLength of [15, 44, 55, 56, 59, 63, 64, 69, 74, 80]) {
      const toolNameLength = rawLength - 'mcp__foo:bar__'.length;
      const tool = prodTool('foo:bar', 'x'.repeat(toolNameLength));
      const pm = makePm({ permissionsDeny: ['mcp__foo:bar'] });

      expect(await pm.evaluate(aliasContext(tool))).toBe('deny');
      expect(
        await pm.getToolRegistrationStatus(tool.name, tool.permissionAliases),
      ).toBe('disabled');
    }
  });

  it('lets matchesToolPattern consume an exact alias-spelled entry (deny/disallowedTools agreement)', () => {
    // Persisted spellings replace the tool's `+` with `_`; both restriction
    // predicates must keep matching that exact alias.
    const tool = prodTool('srv', 'get+data');
    expect(tool.name).toBe('mcp__srv__get_data_04b75xd');
    const entry = 'mcp__srv__get_data';

    expect(matchesToolPattern(entry, tool.name, tool.permissionAliases)).toBe(
      true,
    );
    expect(matchesRuleWith(entry, tool)).toBe(true);
    // The raw spelling names it exactly too.
    expect(
      matchesToolPattern(
        'mcp__srv__get+data',
        tool.name,
        tool.permissionAliases,
      ),
    ).toBe(true);
  });

  it('refuses a foreign exact entry the tool never advertised', async () => {
    // A foreign exact entry must match the alias itself, not just a tool that
    // happens to advertise an alias.
    const tool = prodTool('srv', 'get+data');
    const foreign = 'mcp__attacker__evil';

    expect(matchesToolPattern(foreign, tool.name, tool.permissionAliases)).toBe(
      false,
    );
    expect(matchesRuleWith(foreign, tool)).toBe(false);

    const pm = makePm({ permissionsAllow: [foreign] });

    expect(await pm.evaluate(aliasContext(tool))).toBe('default');
  });

  // Truncation can remove the registered separator. Both whole-server forms
  // must still agree through the raw alias.
  it.each([
    ['a long provider-safe key', 'k'.repeat(53)],
    ['a long legacy-unsafe key', 'a.b-' + 'k'.repeat(50)],
  ])(
    'keeps both whole-server spellings effective for %s that truncates the separator away',
    async (_label, serverKey) => {
      const tool = prodTool(serverKey, 'tool');
      // The registration really did lose the separator.
      expect(tool.name.split('__')).toHaveLength(2);
      const rule = `mcp__${serverKey}`;

      for (const spelling of [rule, `${rule}__*`]) {
        expect(matchesRuleWith(spelling, tool)).toBe(true);
        expect(
          matchesToolPattern(spelling, tool.name, tool.permissionAliases),
        ).toBe(true);

        const pm = makePm({ permissionsDeny: [spelling] });

        expect(await pm.evaluate(aliasContext(tool))).toBe('deny');
        expect(
          await pm.getToolRegistrationStatus(tool.name, tool.permissionAliases),
        ).toBe('disabled');
      }
    },
  );

  it('keeps a legacy-spelled tool-segment wildcard effective past the 63-character budget', async () => {
    // The truncated alias still preserves this short server key. A persisted
    // tool prefix must retain its restriction past the legacy length budget.
    const tool = prodTool('foo.bar', 'get+data' + 'x'.repeat(50));
    const raw = 'mcp__foo.bar__get+data' + 'x'.repeat(50);
    expect(raw.length).toBeGreaterThan(63);
    expect(tool.permissionAliases[0]).toBe(raw);
    const rule = 'mcp__foo.bar__get_*';

    expect(matchesToolPattern(rule, tool.name, tool.permissionAliases)).toBe(
      true,
    );
    expect(matchesRuleWith(rule, tool)).toBe(true);

    const pm = makePm({ permissionsDeny: [rule] });

    expect(await pm.evaluate(aliasContext(tool))).toBe('deny');
    expect(
      await pm.getToolRegistrationStatus(tool.name, tool.permissionAliases),
    ).toBe('disabled');
  });
});

// Persisted legacy prefixes retain own-tool coverage in all three policies
// (maintainer ruling, 2026-09-25).
describe('legacy-spelled wildcard prefixes keep covering their own server', () => {
  // `get+data` on the dotted server: the raw identity carries the `+`, the
  // legacy reduction turns it into `_`, and the registered name carries a hash
  // suffix. The persisted prefix is the legacy spelling.
  const dotted = prodTool('foo.bar', 'get+data');
  const dottedRaw = 'mcp__foo.bar__get+data';
  const prefixRule = 'mcp__foo.bar__get_*';

  it('matches the persisted legacy prefix on all three matchers', () => {
    // The legacy arm reads the reduction only when the alias channel
    // advertises it — production always threads the tool's own aliases.
    expect(
      matchesMcpPattern(
        prefixRule,
        dotted.name,
        dottedRaw,
        dotted.permissionAliases,
      ),
    ).toBe(true);
    expect(
      matchesToolPattern(prefixRule, dotted.name, dotted.permissionAliases),
    ).toBe(true);
    expect(matchesRuleWith(prefixRule, dotted)).toBe(true);
  });

  // Persisted prefixes must keep covering a server whose legacy spelling
  // rewrites its key, as well as the tool name.
  const rewrittenServerRule = 'mcp__foo.bar_baz__get_*';

  it.each([
    ['deny', { permissionsDeny: [rewrittenServerRule] }, 'deny'],
    ['ask', { permissionsAsk: [rewrittenServerRule] }, 'ask'],
    ['allow', { permissionsAllow: [rewrittenServerRule] }, 'allow'],
  ])(
    'keeps a legacy-spelled %s prefix on a rewritten server segment effective',
    async (_label, lists, expected) => {
      const mixed = prodTool('foo.bar+baz', 'get+data');
      expect(mixed.permissionAliases).toContain('mcp__foo.bar_baz__get_data');
      // The `disallowedTools` blocklist judges a tool through this predicate.
      expect(
        matchesToolPattern(
          rewrittenServerRule,
          mixed.name,
          mixed.permissionAliases,
        ),
      ).toBe(true);
      expect(matchesRuleWith(rewrittenServerRule, mixed)).toBe(true);

      const pm = makePm(lists);

      expect(await pm.evaluate(aliasContext(mixed))).toBe(expected);
    },
  );

  it.each([
    ['deny', { permissionsDeny: [prefixRule] }, 'deny'],
    ['ask', { permissionsAsk: [prefixRule] }, 'ask'],
    ['allow', { permissionsAllow: [prefixRule] }, 'allow'],
  ])(
    'keeps a legacy-spelled %s prefix effective end to end',
    async (_label, lists, expected) => {
      const pm = makePm(lists);

      expect(await pm.evaluate(aliasContext(dotted))).toBe(expected);
    },
  );

  it('does not let the reduction reach a differently-registered server', async () => {
    // The whole reason this PR exists: `foo_bar` is a DIFFERENT server, so the
    // reduction of its own raw identity must not satisfy a rule written for
    // `foo.bar` — in either direction.
    const safe = prodTool('foo_bar', 'get+data');
    expect(safe.name).not.toBe(dotted.name);
    expect(safe.permissionAliases).toEqual([
      'mcp__foo_bar__get+data',
      'mcp__foo_bar__get_data',
    ]);

    expect(matchesMcpPattern(prefixRule, safe.name)).toBe(false);
    expect(
      matchesMcpPattern(prefixRule, safe.name, 'mcp__foo_bar__get+data'),
    ).toBe(false);
    expect(
      matchesToolPattern(prefixRule, safe.name, safe.permissionAliases),
    ).toBe(false);
    expect(matchesRuleWith(prefixRule, safe)).toBe(false);

    for (const lists of [
      { permissionsDeny: [prefixRule] },
      { permissionsAllow: [prefixRule] },
    ]) {
      const pm = makePm(lists);

      expect(await pm.evaluate(aliasContext(safe))).toBe('default');
    }
  });

  it('does not let a middle-truncated reduction supply the separator to a shorter server wildcard', () => {
    // A cut through the server key must not fabricate a shorter server wildcard.
    const premium = prodTool(
      'weather-forecast-server-premium',
      'get_extended_forecast_for_next_week',
    );
    const legacyAlias = generateLegacyMcpToolName(
      'mcp__weather-forecast-server-premium__get_extended_forecast_for_next_week',
    );
    const shorterServerRule = 'mcp__weather-forecast-server__*';
    expect(legacyAlias.split('__')[1]).toBe('weather-forecast-server');
    expect(legacyAlias.startsWith('mcp__weather-forecast-server__')).toBe(true);

    expect(
      matchesToolPattern(
        shorterServerRule,
        premium.name,
        premium.permissionAliases,
      ),
    ).toBe(false);
    expect(
      matchesToolPattern(shorterServerRule, premium.name, [legacyAlias]),
    ).toBe(false);
    expect(matchesRuleWith(shorterServerRule, premium)).toBe(false);

    // The premium server's own wildcard still matches, so the guard did not
    // cost the legitimate direction.
    expect(
      matchesToolPattern(
        'mcp__weather-forecast-server-premium__get_*',
        premium.name,
        premium.permissionAliases,
      ),
    ).toBe(true);
  });

  it('keeps a >28-char legacy prefix effective when the advertised reduction is truncated (R14-2)', async () => {
    // This prefix exceeds the truncated alias's head window. Only the
    // length-preserving legacy spelling can cover it.
    const longDotted = prodTool(
      'foo.bar',
      'get+data_for_a_specific_location_and_date_range_extended',
    );
    const rule = 'mcp__foo.bar__get_data_for_a_specific*';
    expect(
      matchesToolPattern(rule, longDotted.name, longDotted.permissionAliases),
    ).toBe(true);
    expect(matchesRuleWith(rule, longDotted)).toBe(true);

    const pm = makePm({ permissionsDeny: [rule] });

    expect(await pm.evaluate(aliasContext(longDotted))).toBe('deny');

    // Negative control: the same prefix must not reach a different server.
    const other = prodTool(
      'other.server',
      'get+data_for_a_specific_location_and_date_range_extended',
    );
    expect(matchesToolPattern(rule, other.name, other.permissionAliases)).toBe(
      false,
    );
  });
});

// Bare server rules and their `__*` forms must agree even when legacy
// substitution changes the configured server key.
describe('legacy-spelled bare server rules keep covering their own server', () => {
  // `github.com/octocat` reduces to `mcp__github.com_octocat` — the `/` is
  // out of the legacy set, the `.` is not — length-preserving, so the
  // reduction vouches.
  const slashed = prodTool('github.com/octocat', 'search');
  const slashedRule = 'mcp__github.com_octocat';

  // `foo.bar+baz` reduces to `mcp__foo.bar_baz` — the class whose wildcard
  // rows in the describe above pin the rewritten server segment.
  const mixed = prodTool('foo.bar+baz', 'get+data');
  const mixedRule = 'mcp__foo.bar_baz';

  it.each([
    ['slash-keyed server', slashed, slashedRule],
    ['rewritten server segment', mixed, mixedRule],
  ])(
    'keeps a bare legacy deny/ask effective for a %s',
    async (_label, tool, bareRule) => {
      // The bare form is the witness (red without the hoist); the `__*` twin
      // already matched and is the control.
      for (const spelling of [bareRule, `${bareRule}__*`]) {
        expect(
          matchesToolPattern(spelling, tool.name, tool.permissionAliases),
        ).toBe(true);
        expect(matchesRuleWith(spelling, tool)).toBe(true);

        const denyPm = makePm({ permissionsDeny: [spelling] });

        expect(await denyPm.evaluate(aliasContext(tool))).toBe('deny');
        expect(
          await denyPm.getToolRegistrationStatus(
            tool.name,
            tool.permissionAliases,
          ),
        ).toBe('disabled');

        const askPm = makePm({ permissionsAsk: [spelling] });

        expect(await askPm.evaluate(aliasContext(tool))).toBe('ask');
      }
    },
  );

  it('keeps a bare legacy deny effective when truncation cut only the tool segment', async () => {
    // The slash-keyed server survives the head window even when its tool is
    // truncated; legacy server rules must retain coverage.
    const tool = prodTool(
      'github.com/octocat',
      'search_repository_issues_and_pull_requests_by_keyword',
    );
    const raw =
      'mcp__github.com/octocat__search_repository_issues_and_pull_requests_by_keyword';
    expect(raw.length).toBeGreaterThan(63);
    expect(tool.permissionAliases[0]).toBe(raw);
    const bareRule = 'mcp__github.com_octocat';

    for (const spelling of [bareRule, `${bareRule}__*`]) {
      expect(
        matchesToolPattern(spelling, tool.name, tool.permissionAliases),
      ).toBe(true);
      expect(matchesRuleWith(spelling, tool)).toBe(true);

      const pm = makePm({ permissionsDeny: [spelling] });

      expect(await pm.evaluate(aliasContext(tool))).toBe('deny');
      expect(
        await pm.getToolRegistrationStatus(tool.name, tool.permissionAliases),
      ).toBe('disabled');
    }
  });

  it('keeps the provider-safe bare rule matching through the registered name (control)', () => {
    // `foo:bar` registers as `mcp__foo_bar__…`, so the provider-safe bare
    // rule matched before the hoist and after — nothing changed here.
    const colon = prodTool('foo:bar', 'a.b');
    expect(
      matchesToolPattern('mcp__foo_bar', colon.name, colon.permissionAliases),
    ).toBe(true);
  });
});

// These two keys share a truncated legacy spelling, but only the shorter
// key's complete server boundary survives the publication gate.
describe('exact entries in a truncated legacy spelling shared by two servers', () => {
  const sharedTool = 'get_extended_forecast_for_next_week';
  const own = prodTool('weather-forecast-server', sharedTool);
  const sibling = prodTool('weather-forecast-server-premium', sharedTool);
  const sharedLegacy = generateLegacyMcpToolName(
    `mcp__weather-forecast-server__${sharedTool}`,
  );

  it('publishes the shared spelling only for the server whose cut stayed in its tool segment (premise)', () => {
    expect(own.name).not.toBe(sibling.name);
    // Both reductions are still computable and still byte-identical…
    expect(sharedLegacy).toBe(
      generateLegacyMcpToolName(
        `mcp__weather-forecast-server-premium__${sharedTool}`,
      ),
    );
    // Only the short key keeps its boundary inside the head window.
    expect(own.permissionAliases).toContain(sharedLegacy);
    expect(sibling.permissionAliases).toEqual([
      `mcp__weather-forecast-server-premium__${sharedTool}`,
    ]);
  });

  it('still matches the own server, whose cut stayed inside its tool segment', async () => {
    expect(
      matchesToolPattern(sharedLegacy, own.name, own.permissionAliases),
    ).toBe(true);
    expect(matchesRuleWith(sharedLegacy, own)).toBe(true);

    const pm = makePm({ permissionsDeny: [sharedLegacy] });

    expect(await pm.evaluate(aliasContext(own))).toBe('deny');
    expect(
      await pm.getToolRegistrationStatus(own.name, own.permissionAliases),
    ).toBe('disabled');
  });

  it('withholds the shared spelling from the sibling grant aliases', async () => {
    expect(
      matchesToolPattern(sharedLegacy, sibling.name, sibling.permissionAliases),
    ).toBe(false);
    expect(matchesRuleWith(sharedLegacy, sibling)).toBe(false);

    const pm = makePm({ permissionsAllow: [sharedLegacy] });

    expect(await pm.evaluate(producerContext(sibling))).toBe('default');
  });

  it('still matches the exact raw identity and the own-server wildcard (controls)', () => {
    const ownRaw = `mcp__weather-forecast-server__${sharedTool}`;
    expect(own.permissionAliases[0]).toBe(ownRaw);
    expect(matchesToolPattern(ownRaw, own.name, own.permissionAliases)).toBe(
      true,
    );
    expect(
      matchesToolPattern(
        'mcp__weather-forecast-server__*',
        own.name,
        own.permissionAliases,
      ),
    ).toBe(true);
  });

  it('withholds grant aliases shared by two keys that contain the separator', async () => {
    // Both keys lose their divergent suffix beyond the head window. Splitting
    // the common rendering cannot recover either producer's server boundary.
    const alpha = prodTool('a__very_long_server_key_name_alpha', sharedTool);
    const beta = prodTool('a__very_long_server_key_name_beta', sharedTool);
    const sharedSpelling = generateLegacyMcpToolName(
      `mcp__a__very_long_server_key_name_alpha__${sharedTool}`,
    );
    expect(sharedSpelling).toBe(
      generateLegacyMcpToolName(
        `mcp__a__very_long_server_key_name_beta__${sharedTool}`,
      ),
    );

    for (const tool of [alpha, beta]) {
      expect(
        matchesToolPattern(sharedSpelling, tool.name, tool.permissionAliases),
      ).toBe(false);
      expect(matchesRuleWith(sharedSpelling, tool)).toBe(false);

      const allowPm = makePm({ permissionsAllow: [sharedSpelling] });

      expect(await allowPm.evaluate(producerContext(tool))).toBe('default');
    }
  });
});

// Underscores inside keys or at their ends can imitate the separator.
// Only the key with a preserved boundary may publish these reductions.
describe('truncated legacy reductions retain the complete server boundary (R12-1)', () => {
  // Both reductions are still computable and still byte-identical…
  const expectSharedReduction = async (
    own: DiscoveredMCPTool,
    sibling: DiscoveredMCPTool,
  ): Promise<string> => {
    const raw = (tool: DiscoveredMCPTool) =>
      `mcp__${tool.serverName}__${tool.serverToolName}`;
    const shared = generateLegacyMcpToolName(raw(own));
    expect(shared).toBe(generateLegacyMcpToolName(raw(sibling)));
    expect(own.name).not.toBe(sibling.name);
    expect(own.permissionAliases).toContain(shared);
    expect(sibling.permissionAliases).not.toContain(shared);
    expect(
      own.permissionAliases.some((a) => sibling.permissionAliases.includes(a)),
    ).toBe(false);
    expect(
      matchesToolPattern(shared, sibling.name, sibling.permissionAliases),
    ).toBe(false);
    const allow = makePm({ permissionsAllow: [shared] });
    for (const ctx of [aliasContext(sibling), producerContext(sibling)]) {
      expect(await allow.evaluate(ctx)).toBe('default');
    }
    const deny = makePm({ permissionsDeny: [shared] });
    const ctx = producerContext(sibling);
    expect(await deny.evaluate(ctx)).toBe('deny');
    expect(
      await deny.getToolRegistrationStatus(
        sibling.name,
        sibling.permissionAliases,
        ctx.mcpIdentity,
      ),
    ).toBe('disabled');
    return shared;
  };

  it('separates keys one underscore apart (acme-weather-forecast vs acme-weather-forecast_)', async () => {
    // The sibling's key ends where the first server's separator lives: the
    // 28-character window cuts through `___` and cannot say which `_` is the
    // boundary. Pre-fix both tools advertised the shared reduction.
    const sharedTool = 'get_extended_weather_forecast_for_week';
    const own = prodTool('acme-weather-forecast', sharedTool);
    const sibling = prodTool('acme-weather-forecast_', sharedTool);
    const shared = await expectSharedReduction(own, sibling);

    // The own server keeps its persisted legacy coverage (deny stays deny).
    expect(matchesToolPattern(shared, own.name, own.permissionAliases)).toBe(
      true,
    );
    const pm = makePm({ permissionsDeny: [shared] });

    expect(await pm.evaluate(aliasContext(own))).toBe('deny');
  });

  it('separates a short key from a key that contains the separator (github vs github__create_reposito)', async () => {
    // `github__create_reposito` is 23 characters and fits the window, so
    // length alone could not refuse it; its key materializes the boundary
    // the reduction pretends to have.
    const toolA = `create_repositoabcdssue_with_attachments_and_labels`;
    const toolB = `efghijklmnssue_with_attachments_and_labels`;
    const own = prodTool('github', toolA);
    const sibling = prodTool('github__create_reposito', toolB);
    const shared = await expectSharedReduction(own, sibling);
    expect(shared).toBe(
      'mcp__github__create_reposito___ssue_with_attachments_and_labels',
    );

    expect(matchesToolPattern(shared, own.name, own.permissionAliases)).toBe(
      true,
    );
  });

  it('separates a key from its underscore extension (foo vs foo_)', async () => {
    // Same underscore-run ambiguity without any `__` inside a key: the
    // sibling's key ends with the very character the separator is made of.
    const ownTool = `_${'a'.repeat(17)}${'X'.repeat(10)}${'b'.repeat(32)}`;
    const siblingTool = `${'a'.repeat(17)}${'Y'.repeat(11)}${'b'.repeat(32)}`;
    const own = prodTool('foo', ownTool);
    const sibling = prodTool('foo_', siblingTool);
    const shared = await expectSharedReduction(own, sibling);

    expect(matchesToolPattern(shared, own.name, own.permissionAliases)).toBe(
      true,
    );
  });
});

// Injected `___` cannot establish a server boundary. Keep both the
// withheld-alias and published-alias prefix controls.
describe('a truncated legacy reduction cannot fabricate a server boundary (R12-2)', () => {
  const toolName = 't'.repeat(40);

  it('publishes no reduction when the window cuts through the separator, and foreign rules refuse', async () => {
    const tool = prodTool('weather-forecast-serve', toolName);
    // The window ends one character into this key's `__` separator, so the
    // tool advertises only its exact raw identity.
    expect(tool.permissionAliases).toEqual([
      `mcp__weather-forecast-serve__${toolName}`,
    ]);

    for (const foreign of [
      'mcp__weather-forecast-serve_',
      'mcp__weather-forecast-serve___*',
    ]) {
      expect(
        matchesToolPattern(foreign, tool.name, tool.permissionAliases),
      ).toBe(false);
      for (const lists of [
        { permissionsAllow: [foreign] },
        { permissionsDeny: [foreign] },
      ]) {
        const pm = makePm(lists);

        expect(await pm.evaluate(aliasContext(tool))).toBe('default');
      }
    }

    // Positive control: the tool's OWN whole-server rules still match.
    for (const own of [
      'mcp__weather-forecast-serve',
      'mcp__weather-forecast-serve__*',
    ]) {
      expect(matchesToolPattern(own, tool.name, tool.permissionAliases)).toBe(
        true,
      );
    }
  });

  it('refuses prefixes supplied by an injected separator in a published reduction', async () => {
    // An alias is published at the window edge, but its injected separator
    // must not supply a foreign prefix.
    const tool = prodTool('weather-forecast-server', toolName);
    const legacy = generateLegacyMcpToolName(
      `mcp__weather-forecast-server__${toolName}`,
    );
    expect(tool.permissionAliases).toContain(legacy);

    for (const foreign of [
      'mcp__weather-forecast-server_',
      'mcp__weather-forecast-server___*',
    ]) {
      expect(
        matchesToolPattern(foreign, tool.name, tool.permissionAliases),
      ).toBe(false);
      for (const lists of [
        { permissionsAllow: [foreign] },
        { permissionsDeny: [foreign] },
      ]) {
        const pm = makePm(lists);

        expect(await pm.evaluate(aliasContext(tool))).toBe('default');
      }
    }

    // Positive controls: the own whole-server rule matches through the
    // registered name, and the exact legacy entry still matches whole.
    expect(
      matchesToolPattern(
        'mcp__weather-forecast-server',
        tool.name,
        tool.permissionAliases,
      ),
    ).toBe(true);
    expect(matchesToolPattern(legacy, tool.name, tool.permissionAliases)).toBe(
      true,
    );
  });
});

// A leading tool underscore must not extend the key into a different
// whole-server rule. Server segments are compared as whole segments.
describe('a leading-underscore tool cannot borrow another key boundary (R4-2)', () => {
  it('refuses a whole-server rule whose key is the server plus a leading underscore', async () => {
    const tool = prodTool('foo', '_internal');
    // Premises: verbatim registration, and no alias channel is involved.
    expect(tool.name).toBe('mcp__foo___internal');
    expect(tool.permissionAliases).toEqual([]);

    expect(
      matchesToolPattern('mcp__foo_', tool.name, tool.permissionAliases),
    ).toBe(false);
    expect(matchesRuleWith('mcp__foo_', tool)).toBe(false);
    for (const lists of [
      { permissionsAllow: ['mcp__foo_'] },
      { permissionsDeny: ['mcp__foo_'] },
    ]) {
      const pm = makePm(lists);

      expect(await pm.evaluate(aliasContext(tool))).toBe('default');
    }

    // Positive control: the tool's OWN whole-server rule still matches.
    expect(
      matchesToolPattern('mcp__foo', tool.name, tool.permissionAliases),
    ).toBe(true);
  });

  it('refuses a bare server rule against a non-MCP tool named X__<server>__Y (R14-1)', async () => {
    // The rule can enter MCP matching while the tool is non-MCP; constrain
    // both sides rather than trusting the rule's prefix alone.
    const toolName = 'x__github__deploy';
    expect(matchesRule(parseRule('mcp__github'), toolName)).toBe(false);
    for (const lists of [
      { permissionsAllow: ['mcp__github'] },
      { permissionsDeny: ['mcp__github'] },
    ]) {
      const pm = makePm(lists);

      expect(await pm.evaluate({ toolName })).toBe('default');
    }

    // Positive control: a real MCP tool of that server still matches.
    const real = prodTool('github', 'deploy');
    expect(real.name).toBe('mcp__github__deploy');
    expect(matchesRuleWith('mcp__github', real)).toBe(true);
  });

  it('keeps bare-server own-key coverage at key lengths whose legacy reduction is withheld', () => {
    // Regression guard: the segment-compare arm must not withdraw own-server
    // coverage — the registered name and raw identity keep the boundary even
    // where the R12-1 gate withholds the legacy reduction (22 and >=24).
    for (const keyLength of [21, 22, 23, 24, 30]) {
      const server = 's'.repeat(keyLength);
      const tool = prodTool(server, 't'.repeat(40));
      expect(
        matchesToolPattern(`mcp__${server}`, tool.name, tool.permissionAliases),
      ).toBe(true);
      expect(
        matchesToolPattern(
          `mcp__${server}__*`,
          tool.name,
          tool.permissionAliases,
        ),
      ).toBe(true);
    }
  });
});

// Flattening `foo_` plus `_internal` loses the boundary. These cases check
// the producer identity channel separately from alias-only compatibility.
describe('the producer-carried identity channel (R4-2)', () => {
  const FOO_UNDERSCORE_TOOL = 'mcp__foo____internal';
  const fooUnderscoreIdentity = {
    serverName: 'foo_',
    serverToolName: '_internal',
  };

  it.each<[string, string, string, boolean]>([
    ['foo_', '_internal', 'mcp__foo', false],
    ['foo_', '_internal', 'mcp__foo_', true],
    ['foo_', '_internal', 'mcp__foo__*', false],
    ['foo_', '_internal', 'mcp__foo___*', true],
    ['foo_', '_internal', 'mcp__foo____*', true],
    ['foo_', '_internal', 'mcp__foo____in*', true],
    ['foo_bar', 'baz', 'mcp__foo', false],
    ['foo_bar', 'baz', 'mcp__foo_bar', true],
    ['foo_bar', 'evil', 'mcp__*', true],
    ['foo_bar', 'evil', 'mcp__foo*', true],
    ['foo_bar', 'evil', 'mcp__foo__*', false],
  ])(
    'matches %s / %s against %s: %s',
    (serverName, serverToolName, rule, expected) => {
      expect(
        matchesMcpPattern(
          rule,
          `mcp__${serverName}__${serverToolName}`,
          undefined,
          undefined,
          { serverName, serverToolName },
        ),
      ).toBe(expected);
    },
  );

  it('keeps restrictive whole-server and match-all wrapper behavior', () => {
    expect(
      matchesToolPattern(
        'mcp__foo',
        FOO_UNDERSCORE_TOOL,
        undefined,
        fooUnderscoreIdentity,
      ),
    ).toBe(false);
    expect(
      matchesToolPattern('mcp__*', SAFE_SERVER_TOOL, undefined, {
        serverName: 'foo_bar',
        serverToolName: 'evil',
      }),
    ).toBe(true);
  });

  it('keeps the spelling-derived fallback unchanged when identity is absent', () => {
    // Without the channel the boundary is re-derived from the flattened
    // spelling and the collision is the accepted residual — exactly why every
    // production caller threads the identity from the registry/invocation.
    expect(matchesMcpPattern('mcp__foo', FOO_UNDERSCORE_TOOL)).toBe(true);
    expect(matchesMcpPattern('mcp__foo__*', FOO_UNDERSCORE_TOOL)).toBe(true);
  });

  it('a whole-server allow for foo no longer auto-approves foo_ tools end-to-end', async () => {
    const tool = prodTool('foo_', '_internal');
    expect(tool.name).toBe(FOO_UNDERSCORE_TOOL);
    const ctx = producerContext(tool);
    const identity = ctx.mcpIdentity;

    const pm = makePm({ permissionsAllow: ['mcp__foo'] });

    expect(await pm.evaluate(ctx)).toBe('default');
    // Registration-level check agrees: the foo_ tool is not disabled by a
    // deny written for foo either.
    const pmDeny = makePm({ permissionsDeny: ['mcp__foo'] });

    expect(
      await pmDeny.getToolRegistrationStatus(
        tool.name,
        tool.permissionAliases,
        identity,
      ),
    ).toBe('registered');

    // Positive control: server foo's own tool is still covered by the rule.
    const ownTool = prodTool('foo', 'deploy');
    expect(await pm.evaluate(producerContext(ownTool))).toBe('allow');
    expect(
      await pmDeny.getToolRegistrationStatus(
        ownTool.name,
        ownTool.permissionAliases,
        producerContext(ownTool).mcpIdentity,
      ),
    ).toBe('disabled');
  });

  it('matches a rule written in the registered spelling of an unsafe key (R13-1)', async () => {
    const tool = prodTool('foo:bar', 'a.b');
    const ctx = producerContext(tool);
    const identity = ctx.mcpIdentity;
    for (const rule of [
      'mcp__foo_bar',
      'mcp__foo_bar__*',
      'mcp__foo_bar__a_b*',
      'mcp__foo:bar',
    ]) {
      expect(
        matchesMcpPattern(
          rule,
          tool.name,
          undefined,
          tool.permissionAliases,
          identity,
        ),
      ).toBe(true);
    }

    const pm = makePm({ permissionsDeny: ['mcp__foo_bar'] });

    expect(await pm.evaluate(ctx)).toBe('deny');
  });

  it('reads an all-underscore tool prefix as this server own tool (R13-1)', async () => {
    const tool = prodTool('github', '__debug');
    expect(tool.name).toBe('mcp__github____debug');
    const ctx = producerContext(tool);
    const identity = ctx.mcpIdentity;
    expect(
      matchesMcpPattern(
        'mcp__github____*',
        tool.name,
        undefined,
        tool.permissionAliases,
        identity,
      ),
    ).toBe(true);
  });
});

// Keep registered tool suffixes, real leading underscores and coarse
// prefixes distinct when matching against the producer boundary.
describe('wildcard arms read the producer identity, not a re-split (R13-1/R17-1/R17-2)', () => {
  it.each([
    ['github', 'search.repositories', 'mcp__github__search_repositories_*'],
    ['foo.bar', 'get+data', 'mcp__foo.bar__get_data_*'],
    ['foo.bar', 'x'.repeat(60), `mcp__foo.bar__${'x'.repeat(41)}_*`],
  ])(
    'matches the registered tool suffix for %s / %s',
    async (server, name, rule) => {
      const tool = prodTool(server, name);
      const ctx = producerContext(tool);
      expect(
        matchesToolPattern(
          rule,
          tool.name,
          tool.permissionAliases,
          ctx.mcpIdentity,
        ),
      ).toBe(true);
      for (const expected of ['deny', 'ask'] as const) {
        const pm = makePm(
          expected === 'deny'
            ? { permissionsDeny: [rule] }
            : { permissionsAsk: [rule] },
        );

        expect(await pm.evaluate(ctx)).toBe(expected);
        expect(await evaluatePermissionRules(pm, 'allow', ctx)).toMatchObject({
          finalPermission: expected,
          pmForcedAsk: expected === 'ask',
        });
      }
    },
  );

  it('refuses a sibling-key whole-server spelling that lands as separator continuation (R17-1)', async () => {
    // A sibling's separator continuation must not match `foo`'s `deploy` tool.
    const tool = prodTool('foo', 'deploy');
    expect(tool.name).toBe('mcp__foo__deploy');
    expect(
      matchesMcpPattern('mcp__foo___*', tool.name, undefined, undefined, {
        serverName: 'foo',
        serverToolName: 'deploy',
      }),
    ).toBe(false);

    const pm = makePm({ permissionsAllow: ['mcp__foo___*'] });

    expect(await pm.evaluate(producerContext(tool))).toBe('default');
  });

  it('decides coarse-vs-foreign from the producer renderings, not a segment count (R17-2)', async () => {
    // `mcp__foo_*` overruns key `foo`'s boundary: it reads as server `foo_`'s
    // prefix, so it must not reach server `foo`'s own tools (the separator's
    // first underscore would otherwise supply the rule's trailing one).
    const fooOwnsUnderscoreTool = prodTool('foo', '_internal');
    expect(fooOwnsUnderscoreTool.name).toBe('mcp__foo___internal');
    expect(
      matchesMcpPattern(
        'mcp__foo_*',
        fooOwnsUnderscoreTool.name,
        undefined,
        [],
        { serverName: 'foo', serverToolName: '_internal' },
      ),
    ).toBe(false);
    // The refusal this branch exists for stays: server `foo_`'s tool must
    // not answer server `foo`'s whole-server rule.
    const fooUnderscoreTool = prodTool('foo_', '_internal');
    expect(
      matchesMcpPattern('mcp__foo__*', fooUnderscoreTool.name, undefined, [], {
        serverName: 'foo_',
        serverToolName: '_internal',
      }),
    ).toBe(false);
    // A key containing `__` is named by a prefix that stops short of its own
    // closing separator — that is not an overrun.
    const doubleUnderscoreKey = prodTool('my__svc', 'deploy');
    expect(
      matchesMcpPattern(
        'mcp__my__svc*',
        doubleUnderscoreKey.name,
        undefined,
        [],
        { serverName: 'my__svc', serverToolName: 'deploy' },
      ),
    ).toBe(true);

    const pm = makePm({ permissionsDeny: ['mcp__my__svc*'] });

    expect(await pm.evaluate(producerContext(doubleUnderscoreKey))).toBe(
      'deny',
    );
  });
});

describe('restrictive rules retain withheld legacy exact and prefix spellings', () => {
  it.each([
    ['s'.repeat(22), 't'.repeat(40)],
    [
      'https://mcp.services.example/internal/sse?team=abc.def',
      'deploy_service',
      'mcp__https___mcp.services.ex*',
    ],
    ['https://mcp.' + 'a'.repeat(10), 't'.repeat(40), 'mcp__https___mcp.*'],
    ['https://mcp.' + 'a'.repeat(12), 't'.repeat(40), 'mcp__https___mcp.*'],
    ['s'.repeat(24), 't'.repeat(40)],
    ['weather-forecast-server-premium', 'get_extended_forecast_for_next_week'],
    ['a__very_long_server_key_name_alpha', 't'.repeat(40)],
    ['a__very_long_server_key_name_beta', 't'.repeat(40)],
  ])(
    'keeps deny/ask without widening allow for %s',
    async (server, name, savedRule?: string) => {
      const tool = prodTool(server, name);
      const legacy = generateLegacyMcpToolName(`mcp__${server}__${name}`);
      expect(tool.permissionAliases).not.toContain(legacy);
      const rule = savedRule ?? legacy;
      const ctx = producerContext(tool);
      const deny = makePm({
        permissionsDeny: [rule],
        permissionsAllow: [tool.name],
      });

      expect(await deny.evaluate(ctx)).toBe('deny');
      expect(deny.findMatchingDenyRule(ctx)).toBe(rule);
      expect(deny.hasRelevantRules(ctx)).toBe(true);
      expect(
        await deny.isToolEnabled(
          tool.name,
          tool.permissionAliases,
          ctx.mcpIdentity,
        ),
      ).toBe(false);
      expect(
        matchesAgentToolBlocklist(
          [rule],
          tool.name,
          tool.permissionAliases,
          ctx.mcpIdentity,
        ),
      ).toBe(true);

      const ask = makePm({
        permissionsAsk: [rule],
        permissionsAllow: [tool.name],
      });

      expect(await ask.evaluate(ctx)).toBe('ask');
      expect(ask.hasMatchingAskRule(ctx)).toBe(true);

      const allow = makePm({ permissionsAllow: [rule] });

      expect(await allow.evaluate(ctx)).toBe('default');
      expect(allow.hasRelevantRules(ctx)).toBe(false);
      const unrelated = prodTool('unrelated', name);
      expect(await deny.evaluate(producerContext(unrelated))).toBe('default');
    },
  );
});

describe('a restrictive wildcard that is a literal prefix of the registered name keeps covering its own key (R17-1)', () => {
  const shapes: Array<[string, string, string, 'allow' | 'default']> = [
    ['a__b', '_hidden', 'mcp__a__b___*', 'allow'],
    ['my__svc', '_internal', 'mcp__my__svc___*', 'allow'],
    ['foo_', '_internal', 'mcp__foo____*', 'allow'],
    ['foo', 'bar', 'mcp__foo_*', 'default'],
    ['github', 'deploy', 'mcp__github_*', 'default'],
  ];

  it.each(shapes)(
    'retains restrictive coverage for %s / %s under %s (allow=%s)',
    async (serverName, serverToolName, rule, grant) => {
      const tool = prodTool(serverName, serverToolName);
      const ctx = producerContext(tool);
      const identity = ctx.mcpIdentity;
      // The rule is a literal prefix of the tool's own registered name.
      expect(tool.name.startsWith(rule.slice(0, -1))).toBe(true);
      expect(matchesToolPattern(rule, tool.name, undefined, identity)).toBe(
        true,
      );

      const deny = makePm({ permissionsDeny: [rule] });

      expect(await deny.evaluate(ctx)).toBe('deny');
      expect(deny.findMatchingDenyRule(ctx)).toBe(rule);
      expect(deny.hasRelevantRules(ctx)).toBe(true);
      expect(
        matchesAgentToolBlocklist(
          [rule],
          tool.name,
          tool.permissionAliases,
          identity,
        ),
      ).toBe(true);
      const ask = makePm({ permissionsAsk: [rule] });
      expect(await ask.evaluate(ctx)).toBe('ask');
      expect(
        await deny.isToolEnabled(tool.name, tool.permissionAliases, identity),
      ).toBe(false);

      const allow = makePm({ permissionsAllow: [rule] });

      expect(await allow.evaluate(ctx)).toBe(grant);
    },
  );

  it('does not let the fallback reach a foreign tool prefix at the key boundary', () => {
    const tool = prodTool('foo_', '_internal');
    const ctx = producerContext(tool);
    const identity = ctx.mcpIdentity;
    // `mcp__foo___zz*` starts at this key's boundary but is not a literal
    // prefix of `mcp__foo____internal`, so it stays unmatched.
    expect(
      matchesToolPattern('mcp__foo___zz*', tool.name, undefined, identity),
    ).toBe(false);
  });

  it('keeps a genuine tool prefix with real characters matching (control)', async () => {
    const tool = prodTool('a__b', '_hidden');
    const ctx = producerContext(tool);
    const deny = makePm({ permissionsDeny: ['mcp__a__b___hid*'] });

    expect(await deny.evaluate(ctx)).toBe('deny');
  });
});

const URL52 = 'https://mcp.services.example.internal/sse?team=infra';

describe('wildcards copied from a budget-cut registration (R18-1)', () => {
  it.each([
    [URL52, 'deploy'],
    // Raw name is 60 characters (<= 63) but unsafe, so it is still cut at 55.
    ['https://mcp.services.example.internal/sse?team=inf', 'run'],
    ['k'.repeat(53), 'tool'],
    ['a.b-' + 'k'.repeat(50), 'tool'],
  ])('deny/ask keep covering %s / %s', async (server, name) => {
    const tool = prodTool(server, name);
    expect(tool.name).toHaveLength(63);
    const ctx = producerContext(tool);
    for (const rule of [tool.name + '*', tool.name.slice(0, 56) + '*']) {
      expect(
        matchesToolPattern(
          rule,
          tool.name,
          tool.permissionAliases,
          ctx.mcpIdentity,
        ),
      ).toBe(true);
      const deny = makePm({ permissionsDeny: [rule] });

      expect(await deny.evaluate(ctx)).toBe('deny');
      expect(
        await deny.isToolEnabled(
          tool.name,
          tool.permissionAliases,
          ctx.mcpIdentity,
        ),
      ).toBe(false);
      const ask = makePm({ permissionsAsk: [rule] });

      expect(await ask.evaluate(ctx)).toBe('ask');
    }
  });

  it.each([
    // A prefix that stops inside this key's own separator: main restricts
    // every tool of the key, whatever the tool segment starts with (R26-2).
    ['foo', '_internal', 'mcp__foo_*'],
    ['foo', '_in.ternal', 'mcp__foo_*'],
    ['foo.bar', '_in.ternal', 'mcp__foo_bar_*'],
    ['github', '_admin_reset', 'mcp__github_*'],
    // The same stop written in the raw key spelling (`.`/`:` keys).
    ['zybio.db', 'search_pubmed', 'mcp__zybio.db_*'],
    ['foo:bar', 'a.b', 'mcp__foo:bar_*'],
    ['foo.bar', '_in.ternal', 'mcp__foo.bar_*'],
    // A whole-server rule for `foo` keeps main's over-block of key `foo_`,
    // as it already does for `foo_`'s ordinary tools.
    ['foo_', '_internal', 'mcp__foo__*'],
  ])(
    'a prefix stopping inside the own separator restricts: %s / %s',
    async (server, name, rule) => {
      const tool = prodTool(server, name);
      const ctx = producerContext(tool);
      expect(
        matchesToolPattern(
          rule,
          tool.name,
          tool.permissionAliases,
          ctx.mcpIdentity,
        ),
      ).toBe(true);
      expect(await makePm({ permissionsDeny: [rule] }).evaluate(ctx)).toBe(
        'deny',
      );
      expect(
        await makePm({ permissionsDeny: [rule] }).isToolEnabled(
          tool.name,
          tool.permissionAliases,
          ctx.mcpIdentity,
        ),
      ).toBe(false);
      expect(await makePm({ permissionsAsk: [rule] }).evaluate(ctx)).toBe(
        'ask',
      );
      expect(
        matchesAgentToolBlocklist(
          [rule],
          tool.name,
          tool.permissionAliases,
          ctx.mcpIdentity,
        ),
      ).toBe(true);
      // Restrictive-only: the same spelling still never grants (R17-2).
      expect(await makePm({ permissionsAllow: [rule] }).evaluate(ctx)).toBe(
        'default',
      );
    },
  );

  it('a foreign key sharing the stop is not restricted through it', async () => {
    // `mcp__foo_*` stops inside `foo`'s separator; `foobar` never spells it.
    const tool = prodTool('foobar', '_internal');
    const ctx = producerContext(tool);
    expect(
      await makePm({ permissionsDeny: ['mcp__foo_*'] }).evaluate(ctx),
    ).toBe('default');
  });

  it.each([
    ['a bare `*`', () => '*'],
    // An exact entry for a different hash suffix is not a prefix rule.
    ['an exact foreign suffix', (name: string) => name.slice(0, -1) + 'Z'],
  ])('%s does not enter the fallback for a cut registration', (_, rule) => {
    const tool = prodTool(URL52, 'deploy');
    expect(
      matchesToolPattern(
        rule(tool.name),
        tool.name,
        tool.permissionAliases,
        producerContext(tool).mcpIdentity,
      ),
    ).toBe(false);
  });
});
