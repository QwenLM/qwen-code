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
  it('does not match a foo_bar tool against a server-level foo.bar rule', () => {
    expect(matchesMcpPattern('mcp__foo.bar', SAFE_SERVER_TOOL)).toBe(false);
  });

  it('does not match a foo_bar tool against a wildcard foo.bar rule', () => {
    expect(matchesMcpPattern('mcp__foo.bar__*', SAFE_SERVER_TOOL)).toBe(false);
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
});

// Every witness below was measured against the pre-fix matcher: each is a
// rule written for one MCP server that the old reconstruction machinery let
// a *different* server's tool satisfy (or vice versa). The fix publishes the
// tool's exact raw identity through `permissionAliases` and compares
// literally; nothing is hashed and nothing is reconstructed.
describe('cross-server forgery witnesses', () => {
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

    // The rows above pass the production array, whose first element IS the exact
    // raw identity, so `resolveRawMcpIdentity`'s `.find` answers with it and the
    // lossy legacy alias is never considered — they cannot tell the vouching
    // guard apart from taking the first alias blindly. Hand over a legacy-only
    // array, which is what a caller publishing no exact raw identity would
    // produce, and the guard becomes the only thing that can reject it: the
    // alias does not vouch, and its injected `___` is exactly the `__` separator
    // a prefix match needs. Under `return toolAliases?.[0]` both flip to true.
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
describe('legacy-spelled deny coverage', () => {
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
    // legacy alias middle-truncates past 63. This sweep varies the raw length
    // through the TOOL segment under a short server key, so the registered
    // name always keeps its `__` separator; the long-server-key case, where
    // truncation cuts the separator out of the registration, is pinned
    // separately below.
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

  // A server key long enough to push the registered name past the 63-character
  // budget loses its `__` separator to truncation, so the registration has only
  // two parts. Judging "does this tool name have a tool segment" by the
  // registered name alone then failed the bare `mcp__<server>` spelling of a
  // whole-server rule while the `mcp__<server>__*` spelling of the same rule
  // still matched through the raw identity — two forms the docs present as
  // equivalent, disagreeing, with the bare one a silent fail-open on deny.
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
        expect(
          matchesRule(
            parseRule(spelling),
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
          matchesToolPattern(spelling, tool.name, tool.permissionAliases),
        ).toBe(true);

        const pm = new PermissionManager(
          makeConfig({ permissionsDeny: [spelling] }),
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
    },
  );
});

// A persisted legacy prefix whose characters the reduction rewrote still has to
// cover its own tool, or a `deny` silently stops denying — for deny/ask as well
// as allow (maintainer ruling on this PR, 2026-09-25). The wildcard arm reads
// `generateLegacyMcpToolName`'s reduction of the tool's own vouched raw
// identity; every positive row here was `false` / `default` before that.
describe('legacy-spelled wildcard prefixes keep covering their own server', () => {
  // `get+data` on the dotted server: the raw identity carries the `+`, the
  // legacy reduction turns it into `_`, and the registered name carries a hash
  // suffix. The persisted prefix is the legacy spelling.
  const dotted = prodTool('foo.bar', 'get+data');
  const dottedRaw = 'mcp__foo.bar__get+data';
  const prefixRule = 'mcp__foo.bar__get_*';

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

  it('matches the persisted legacy prefix on all three matchers', () => {
    expect(matchesMcpPattern(prefixRule, dotted.name, dottedRaw)).toBe(true);
    expect(
      matchesToolPattern(prefixRule, dotted.name, dotted.permissionAliases),
    ).toBe(true);
    expect(matchesRuleWith(prefixRule, dotted)).toBe(true);
  });

  // The reduction can rewrite the server segment itself — `+` is out of the
  // legacy set, `.` is not — and the persisted prefix carries that rewrite.
  // Provenance by server-chunk equality rejected this spelling and left the
  // deny uncovered; only a reduction that *cut* the name vouches for nothing.
  it('keeps the prefix effective when the reduction rewrote the server segment', () => {
    const mixed = prodTool('foo.bar+baz', 'get+data');
    expect(mixed.permissionAliases).toContain('mcp__foo.bar_baz__get_data');
    expect(
      matchesToolPattern(
        'mcp__foo.bar_baz__get_*',
        mixed.name,
        mixed.permissionAliases,
      ),
    ).toBe(true);
  });

  // The row above is the fixture whose coverage the provenance test decides:
  // the reduction rewrote the SERVER segment, so demanding that the first
  // `__` chunk survive byte-identically rejects the reduction and a persisted
  // restriction silently stops covering its own tool — fail-open on
  // `deny`/`ask`/`disallowedTools`, fail-closed only on `allow`. A reduction
  // that kept the length vouches for the tool it came from, because only the
  // 63-character middle truncation shortens a name. Every row here answers
  // `default`/`false` under the chunk-equality gate.
  const rewrittenServerRule = 'mcp__foo.bar_baz__get_*';

  it.each([
    ['deny', { permissionsDeny: [rewrittenServerRule] }, 'deny'],
    ['ask', { permissionsAsk: [rewrittenServerRule] }, 'ask'],
    ['allow', { permissionsAllow: [rewrittenServerRule] }, 'allow'],
  ])(
    'keeps a legacy-spelled %s prefix on a rewritten server segment effective',
    async (_label, lists, expected) => {
      const mixed = prodTool('foo.bar+baz', 'get+data');
      // The `disallowedTools` blocklist judges a tool through this predicate.
      expect(
        matchesToolPattern(
          rewrittenServerRule,
          mixed.name,
          mixed.permissionAliases,
        ),
      ).toBe(true);
      expect(matchesRuleWith(rewrittenServerRule, mixed)).toBe(true);

      const pm = new PermissionManager(makeConfig(lists));
      pm.initialize();
      expect(
        await pm.evaluate({
          toolName: mixed.name,
          toolAliases: mixed.permissionAliases,
        }),
      ).toBe(expected);
    },
  );

  it.each([
    ['deny', { permissionsDeny: [prefixRule] }, 'deny'],
    ['ask', { permissionsAsk: [prefixRule] }, 'ask'],
    ['allow', { permissionsAllow: [prefixRule] }, 'allow'],
  ])(
    'keeps a legacy-spelled %s prefix effective end to end',
    async (_label, lists, expected) => {
      const pm = new PermissionManager(makeConfig(lists));
      pm.initialize();
      expect(
        await pm.evaluate({
          toolName: dotted.name,
          toolAliases: dotted.permissionAliases,
        }),
      ).toBe(expected);
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
      const pm = new PermissionManager(makeConfig(lists));
      pm.initialize();
      expect(
        await pm.evaluate({
          toolName: safe.name,
          toolAliases: safe.permissionAliases,
        }),
      ).toBe('default');
    }
  });

  it('does not let a middle-truncated reduction supply the separator to a shorter server wildcard', () => {
    // `generateLegacyMcpToolName` cuts at slice(0, 28), so for a server key of
    // 24+ characters the reduction shortens the key and injects the `__` a
    // prefix match needs. The server-provenance guard is what rejects it; this
    // is the wildcard sibling of the server-level row pinned above.
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
});
