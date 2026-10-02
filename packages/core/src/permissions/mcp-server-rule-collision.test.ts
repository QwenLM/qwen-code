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

  // Deny mirrors of the two witnesses above, pinning the cost side of the
  // #10199 fix (R3-3): a forged registration that advertises no alias is out
  // of reach of a legacy-spelled `permissions.deny` — the match is fail-open
  // on the restrictive side. The mitigation is to write the deny in the
  // registered spelling, which the control rows assert still bites.
  it('pins the deny posture: a legacy-spelled deny does not reach a forged verbatim registration', async () => {
    const attacker = prodTool('foo_bar', 'evil_1oxrpi0');
    expect(attacker.permissionAliases).toEqual([]);

    const pm = new PermissionManager(
      makeConfig({ permissionsDeny: ['mcp__foo.bar__evil'] }),
    );
    pm.initialize();
    expect(
      await pm.evaluate({
        toolName: attacker.name,
        toolAliases: attacker.permissionAliases,
      }),
    ).toBe('default');
    expect(
      await pm.getToolRegistrationStatus(
        attacker.name,
        attacker.permissionAliases,
      ),
    ).toBe('registered');

    // Control: the same deny in the registered spelling still blocks it.
    const registeredPm = new PermissionManager(
      makeConfig({ permissionsDeny: [attacker.name] }),
    );
    registeredPm.initialize();
    expect(
      await registeredPm.evaluate({
        toolName: attacker.name,
        toolAliases: attacker.permissionAliases,
      }),
    ).toBe('deny');
  });

  it('pins the deny posture: a legacy-spelled server deny does not reach a colon-keyed forgery', async () => {
    const attacker = prodTool('foo:bar', 'evil[a b#c#d"e~f|x');

    const pm = new PermissionManager(
      makeConfig({ permissionsDeny: ['mcp__foo.bar'] }),
    );
    pm.initialize();
    expect(
      await pm.evaluate({
        toolName: attacker.name,
        toolAliases: attacker.permissionAliases,
      }),
    ).toBe('default');

    // Control: the deny written against the attacker's own raw identity
    // spelling still blocks it.
    const rawPm = new PermissionManager(
      makeConfig({ permissionsDeny: ['mcp__foo:bar'] }),
    );
    rawPm.initialize();
    expect(
      await rawPm.evaluate({
        toolName: attacker.name,
        toolAliases: attacker.permissionAliases,
      }),
    ).toBe('deny');
  });

  // Known residual (variant 2, R2-6): a length-preserving legacy alias that
  // reduces onto a DIFFERENT server's spelling still satisfies an exact
  // 3-part entry. `foo:bar`'s tool registers with a hash suffix, but its
  // advertised legacy spelling `mcp__foo_bar__evil_a_b_c_d_e_f_x` is the
  // verbatim registered name of server `foo_bar`'s same-named tool — an
  // entry naming that spelling matches both. The exact arm accepts any
  // advertised alias; only the truncation gate (R12-1) restricts
  // publication, and this reduction is lossless. Documented as accepted in
  // the design doc's Rule-matching section; this row must go red if the arm
  // is ever removed.
  it('pins the lossy exact-alias cross-server match as a known residual (variant 2)', () => {
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

  it('refuses a foreign exact entry the tool never advertised', async () => {
    // The exact arm must compare the entry against the gated legacy
    // reduction itself: while the comparison was missing, every 3-part
    // entry matched every tool that publishes a lossless legacy alias, so
    // `permissionsAllow: ['mcp__attacker__evil']` auto-approved this tool
    // (R8-1).
    const tool = prodTool('srv', 'get+data');
    const foreign = 'mcp__attacker__evil';

    expect(matchesToolPattern(foreign, tool.name, tool.permissionAliases)).toBe(
      false,
    );
    expect(
      matchesRule(
        parseRule(foreign),
        tool.name,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        tool.permissionAliases,
      ),
    ).toBe(false);

    const pm = new PermissionManager(
      makeConfig({ permissionsAllow: [foreign] }),
    );
    pm.initialize();
    expect(
      await pm.evaluate({
        toolName: tool.name,
        toolAliases: tool.permissionAliases,
      }),
    ).toBe('default');
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

  it('keeps a legacy-spelled tool-segment wildcard effective past the 63-character budget', async () => {
    // The reduction middle-truncates past 63 characters; under a short
    // legacy-safe server key the cut lands entirely in the TOOL segment, so
    // the server segment survives byte-identically and the reduction still
    // vouches for its server. Refusing it silently retired this persisted
    // deny the day the tool's name grew past the budget (R6-1).
    const tool = prodTool('foo.bar', 'get+data' + 'x'.repeat(50));
    const raw = 'mcp__foo.bar__get+data' + 'x'.repeat(50);
    expect(raw.length).toBeGreaterThan(63);
    expect(tool.permissionAliases[0]).toBe(raw);
    const rule = 'mcp__foo.bar__get_*';

    expect(matchesToolPattern(rule, tool.name, tool.permissionAliases)).toBe(
      true,
    );
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
    expect(
      await pm.getToolRegistrationStatus(tool.name, tool.permissionAliases),
    ).toBe('disabled');
  });
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

  // The reduction can rewrite the server segment itself — `+` is out of the
  // legacy set, `.` is not — and the persisted prefix carries that rewrite.
  // A gate that re-derived the server chunk from the flattened spelling
  // rejected this spelling and left the deny uncovered; only a reduction
  // that *cut* the name vouches for nothing.
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
  // 63-character middle truncation shortens a name. Every row here answered
  // `default`/`false` under the flattened-spelling gate this file replaced.
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

  it('keeps a >28-char legacy prefix effective when the advertised reduction is truncated (R14-2)', async () => {
    // Raw identity is 71 chars, so the published legacy reduction is the
    // middle-truncated one; the persisted prefix is 37 chars — past the
    // 28-char head window the prefix arms may read of it. The registered
    // name diverges at the `.` and the raw identity at the `+`, so only the
    // length-preserving legacy rendering can vouch for this entry.
    const longDotted = prodTool(
      'foo.bar',
      'get+data_for_a_specific_location_and_date_range_extended',
    );
    const rule = 'mcp__foo.bar__get_data_for_a_specific*';
    expect(
      matchesToolPattern(rule, longDotted.name, longDotted.permissionAliases),
    ).toBe(true);
    expect(matchesRuleWith(rule, longDotted)).toBe(true);

    const pm = new PermissionManager(makeConfig({ permissionsDeny: [rule] }));
    pm.initialize();
    expect(
      await pm.evaluate({
        toolName: longDotted.name,
        toolAliases: longDotted.permissionAliases,
      }),
    ).toBe('deny');

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

// A bare `mcp__<server>` rule is the `__*` prefix without the glob, so it
// lives in the server-level arm — which used to compare only the registered
// name and the raw identity, never the legacy reduction the entry was
// persisted in. For a server key the reduction rewrote (`/`, `:`, `+` …) the
// bare form failed open while its `__*` twin still denied: `evaluate`
// answered `default` where the pre-normalization matcher answered `deny`.
// The reduction now joins `spellings`, so both prefix arms see it — this is
// the server-level half of the maintainer ruling this file's wildcard
// describe already covers (R4-1).
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

        const denyPm = new PermissionManager(
          makeConfig({ permissionsDeny: [spelling] }),
        );
        denyPm.initialize();
        expect(
          await denyPm.evaluate({
            toolName: tool.name,
            toolAliases: tool.permissionAliases,
          }),
        ).toBe('deny');
        expect(
          await denyPm.getToolRegistrationStatus(
            tool.name,
            tool.permissionAliases,
          ),
        ).toBe('disabled');

        const askPm = new PermissionManager(
          makeConfig({ permissionsAsk: [spelling] }),
        );
        askPm.initialize();
        expect(
          await askPm.evaluate({
            toolName: tool.name,
            toolAliases: tool.permissionAliases,
          }),
        ).toBe('ask');
      }
    },
  );

  it('keeps a bare legacy deny effective when truncation cut only the tool segment', async () => {
    // The reduction rewrote the server segment's `/` AND middle-truncated:
    // the raw name is 78 characters, but the 28-character head window kept
    // the whole 18-character key, so the cut landed entirely in the tool
    // segment and the reduction still vouches for its server. Deriving the
    // boundary from the flattened spelling instead compared the substituted
    // legacy chunk `github.com_octocat` against the raw `github.com/octocat`
    // and dropped the reduction — this server's own persisted legacy deny
    // stopped denying the day the tool name grew past the budget, a
    // regression against main (R6-1).
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

// Past 63 characters `generateLegacyMcpToolName` middle-truncates at
// slice(0, 28) + '___' + slice(-32), which keeps only the first 23 characters
// of the server key — so two different long keys publish one byte-identical
// legacy alias. Whether that shared spelling may match a tool is decided per
// server by the same provenance the prefix arms require: the own server's
// 23-character key survives slice(0, 28) byte-identically, so its cut stayed
// inside its TOOL segment and its copy of the reduction still vouches for its
// server; the sibling's key is cut down to that same window, so its copy
// vouches for nothing. Pre-fix the ungated arm matched BOTH servers, and a
// deny entry written for one stripped the other's tool (R8-1).
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
    // …but only the own server advertises it: its 23-character key fits the
    // 28-character head window, while the sibling's 31-character key was cut
    // by it — a reduction that lost server characters vouches for no server,
    // so the sibling publishes no legacy alias at all. That absence is what
    // denies the sibling every arm below.
    expect(own.permissionAliases).toContain(sharedLegacy);
    expect(sibling.permissionAliases).toEqual([
      `mcp__weather-forecast-server-premium__${sharedTool}`,
    ]);
  });

  it('still matches the own server, whose cut stayed inside its tool segment', async () => {
    expect(
      matchesToolPattern(sharedLegacy, own.name, own.permissionAliases),
    ).toBe(true);
    expect(
      matchesRule(
        parseRule(sharedLegacy),
        own.name,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        own.permissionAliases,
      ),
    ).toBe(true);

    const pm = new PermissionManager(
      makeConfig({ permissionsDeny: [sharedLegacy] }),
    );
    pm.initialize();
    expect(
      await pm.evaluate({
        toolName: own.name,
        toolAliases: own.permissionAliases,
      }),
    ).toBe('deny');
    expect(
      await pm.getToolRegistrationStatus(own.name, own.permissionAliases),
    ).toBe('disabled');
  });

  it('matches no exact entry in the shared spelling against the sibling server', async () => {
    expect(
      matchesToolPattern(sharedLegacy, sibling.name, sibling.permissionAliases),
    ).toBe(false);
    expect(
      matchesRule(
        parseRule(sharedLegacy),
        sibling.name,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        sibling.permissionAliases,
      ),
    ).toBe(false);

    const pm = new PermissionManager(
      makeConfig({ permissionsDeny: [sharedLegacy] }),
    );
    pm.initialize();
    expect(
      await pm.evaluate({
        toolName: sibling.name,
        toolAliases: sibling.permissionAliases,
      }),
    ).toBe('default');
    expect(
      await pm.getToolRegistrationStatus(
        sibling.name,
        sibling.permissionAliases,
      ),
    ).toBe('registered');
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

  it('matches no entry in a spelling shared by two keys that both contain the separator', async () => {
    // Both keys contain `__` and both push the raw name past the
    // 63-character budget, so the reductions are byte-identical AND the
    // 28-character head window cut both keys at the same character — the
    // divergence is past the window, so no predicate over the flattened
    // spelling can tell the two tools apart, and "matches its own server
    // but not the sibling" is not a distinction this reduction can carry:
    // it vouches for no server and both refuse. The gate this replaces
    // derived the boundary with `split('__', 2)[1]`, which answered `a` on
    // both sides of the comparison, so it vouched for BOTH servers — a deny
    // written for one stripped the other's tool (R6-1).
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
      expect(
        matchesRule(
          parseRule(sharedSpelling),
          tool.name,
          undefined,
          undefined,
          undefined,
          undefined,
          undefined,
          undefined,
          tool.permissionAliases,
        ),
      ).toBe(false);

      const denyPm = new PermissionManager(
        makeConfig({ permissionsDeny: [sharedSpelling] }),
      );
      denyPm.initialize();
      expect(
        await denyPm.evaluate({
          toolName: tool.name,
          toolAliases: tool.permissionAliases,
        }),
      ).toBe('default');
      expect(
        await denyPm.getToolRegistrationStatus(
          tool.name,
          tool.permissionAliases,
        ),
      ).toBe('registered');

      const allowPm = new PermissionManager(
        makeConfig({ permissionsAllow: [sharedSpelling] }),
      );
      allowPm.initialize();
      expect(
        await allowPm.evaluate({
          toolName: tool.name,
          toolAliases: tool.permissionAliases,
        }),
      ).toBe('default');
    }
  });
});

// The truncation gate in `permissionAliases` is what stands between two
// SHORT provider-safe keys and one shared reduction: `slice(0, 28)` keeps
// `mcp__` + the first 23 key characters, and `_` is legal in both segments,
// so keys that differ only around the separator — `x` vs `x_`, `foo` vs
// `foo__bar` — used to publish one byte-identical legacy alias that
// `matchesAdvertisedExactName` then accepted for BOTH tools: one allow/deny
// entry decided two servers (R12-1). Each construction below is pinned at
// the producer: at most one side may advertise the shared spelling.
describe('a truncated legacy reduction is attributable to exactly one server (R12-1)', () => {
  // Both reductions are still computable and still byte-identical…
  const expectSharedReduction = (
    own: DiscoveredMCPTool,
    sibling: DiscoveredMCPTool,
    ownRaw: string,
    siblingRaw: string,
  ): string => {
    const shared = generateLegacyMcpToolName(ownRaw);
    expect(shared).toBe(generateLegacyMcpToolName(siblingRaw));
    expect(own.name).not.toBe(sibling.name);
    // …but only the own server may advertise it.
    expect(own.permissionAliases).toContain(shared);
    expect(sibling.permissionAliases).not.toContain(shared);
    // The arrays share no element at all.
    expect(
      own.permissionAliases.some((a) => sibling.permissionAliases.includes(a)),
    ).toBe(false);
    return shared;
  };

  const expectSiblingImmune = async (
    shared: string,
    sibling: DiscoveredMCPTool,
  ) => {
    expect(
      matchesToolPattern(shared, sibling.name, sibling.permissionAliases),
    ).toBe(false);
    for (const lists of [
      { permissionsAllow: [shared] },
      { permissionsDeny: [shared] },
    ]) {
      const pm = new PermissionManager(makeConfig(lists));
      pm.initialize();
      expect(
        await pm.evaluate({
          toolName: sibling.name,
          toolAliases: sibling.permissionAliases,
        }),
      ).toBe('default');
    }
  };

  it('separates keys one underscore apart (acme-weather-forecast vs acme-weather-forecast_)', async () => {
    // The sibling's key ends where the first server's separator lives: the
    // 28-character window cuts through `___` and cannot say which `_` is the
    // boundary. Pre-fix both tools advertised the shared reduction.
    const sharedTool = 'get_extended_weather_forecast_for_week';
    const own = prodTool('acme-weather-forecast', sharedTool);
    const sibling = prodTool('acme-weather-forecast_', sharedTool);
    const shared = expectSharedReduction(
      own,
      sibling,
      `mcp__acme-weather-forecast__${sharedTool}`,
      `mcp__acme-weather-forecast___${sharedTool}`,
    );

    await expectSiblingImmune(shared, sibling);
    // The own server keeps its persisted legacy coverage (deny stays deny).
    expect(matchesToolPattern(shared, own.name, own.permissionAliases)).toBe(
      true,
    );
    const pm = new PermissionManager(makeConfig({ permissionsDeny: [shared] }));
    pm.initialize();
    expect(
      await pm.evaluate({
        toolName: own.name,
        toolAliases: own.permissionAliases,
      }),
    ).toBe('deny');
  });

  it('separates a short key from a key that contains the separator (github vs github__create_reposito)', async () => {
    // `github__create_reposito` is 23 characters and fits the window, so
    // length alone could not refuse it; its key materializes the boundary
    // the reduction pretends to have.
    const toolA = `create_repositoabcdssue_with_attachments_and_labels`;
    const toolB = `efghijklmnssue_with_attachments_and_labels`;
    const own = prodTool('github', toolA);
    const sibling = prodTool('github__create_reposito', toolB);
    const shared = expectSharedReduction(
      own,
      sibling,
      `mcp__github__${toolA}`,
      `mcp__github__create_reposito__${toolB}`,
    );
    expect(shared).toBe(
      'mcp__github__create_reposito___ssue_with_attachments_and_labels',
    );

    await expectSiblingImmune(shared, sibling);
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
    const shared = expectSharedReduction(
      own,
      sibling,
      `mcp__foo__${ownTool}`,
      `mcp__foo___${siblingTool}`,
    );

    await expectSiblingImmune(shared, sibling);
    expect(matchesToolPattern(shared, own.name, own.permissionAliases)).toBe(
      true,
    );
  });
});

// A middle-truncated reduction is `slice(0, 28) + '___' + slice(-32)`: the
// injected `___` sits where a prefix comparison cannot tell it apart from a
// real `__` separator. Before the boundary was enforced, a whole-server rule
// written for one key (`mcp__weather-forecast-serve_`,
// `mcp__weather-forecast-serve___*`) matched a DIFFERENT server's tool
// through that fabricated boundary (R12-2). Two postures are pinned:
// a key the window cuts mid-separator publishes no reduction at all, and a
// published reduction vouches for prefix matching only inside its head
// window — the exact arm still reads the whole spelling.
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
        const pm = new PermissionManager(makeConfig(lists));
        pm.initialize();
        expect(
          await pm.evaluate({
            toolName: tool.name,
            toolAliases: tool.permissionAliases,
          }),
        ).toBe('default');
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

  it('bounds prefix matching to the head window of a published reduction', async () => {
    // This key ends exactly at the window edge, so the reduction IS
    // published — and must still refuse any prefix whose match rests on the
    // injected `___`. Dropping the head-window bound in the matcher reds
    // this row.
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
        const pm = new PermissionManager(makeConfig(lists));
        pm.initialize();
        expect(
          await pm.evaluate({
            toolName: tool.name,
            toolAliases: tool.permissionAliases,
          }),
        ).toBe('default');
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

// A tool whose name starts with a sanitized underscore (server `foo`, tool
// `_internal`, registered verbatim `mcp__foo___internal`, no alias channel)
// reads as `mcp__foo_` + `_internal` under a `${pattern}__` prefix compare:
// a whole-server rule written for the DIFFERENT key `foo_` matched it, so
// `permissions.allow: ['mcp__foo_']` auto-approved a tool of a server the
// entry does not name — the #10199 defect class re-opened through the
// registered name (R4-2 e1). The server-level arm therefore compares the
// server SEGMENT of each spelling, never a flattened prefix.
describe('a leading-underscore tool cannot borrow another key boundary (R4-2)', () => {
  it('refuses a whole-server rule whose key is the server plus a leading underscore', async () => {
    const tool = prodTool('foo', '_internal');
    // Premises: verbatim registration, and no alias channel is involved.
    expect(tool.name).toBe('mcp__foo___internal');
    expect(tool.permissionAliases).toEqual([]);

    expect(
      matchesToolPattern('mcp__foo_', tool.name, tool.permissionAliases),
    ).toBe(false);
    expect(
      matchesRule(
        parseRule('mcp__foo_'),
        tool.name,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        tool.permissionAliases,
      ),
    ).toBe(false);
    for (const lists of [
      { permissionsAllow: ['mcp__foo_'] },
      { permissionsDeny: ['mcp__foo_'] },
    ]) {
      const pm = new PermissionManager(makeConfig(lists));
      pm.initialize();
      expect(
        await pm.evaluate({
          toolName: tool.name,
          toolAliases: tool.permissionAliases,
        }),
      ).toBe('default');
    }

    // Positive control: the tool's OWN whole-server rule still matches.
    expect(
      matchesToolPattern('mcp__foo', tool.name, tool.permissionAliases),
    ).toBe(true);
  });

  it('refuses a bare server rule against a non-MCP tool named X__<server>__Y (R14-1)', async () => {
    // `matchesRule` enters the MCP arm when the RULE starts with `mcp__`, so
    // a discovered non-MCP tool named `x__github__deploy` reaches the
    // server-level arm with no `mcp__` anywhere on the tool side; the arm
    // must constrain the tool side's first segment, not only the rule's.
    const toolName = 'x__github__deploy';
    expect(matchesRule(parseRule('mcp__github'), toolName)).toBe(false);
    for (const lists of [
      { permissionsAllow: ['mcp__github'] },
      { permissionsDeny: ['mcp__github'] },
    ]) {
      const pm = new PermissionManager(makeConfig(lists));
      pm.initialize();
      expect(await pm.evaluate({ toolName })).toBe('default');
    }

    // Positive control: a real MCP tool of that server still matches.
    const real = prodTool('github', 'deploy');
    expect(real.name).toBe('mcp__github__deploy');
    expect(
      matchesRule(
        parseRule('mcp__github'),
        real.name,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        undefined,
        real.permissionAliases,
      ),
    ).toBe(true);
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

// The flatten-and-resplit collision the spelling layer cannot solve: server
// `foo_`'s tool `_internal` registers verbatim as `mcp__foo____internal`
// (`mcp__` + `foo_` + `__` + `_internal`), and re-deriving the boundary by
// split('__') reads its server segment as `foo`
// (R4-2/R13-1). The matcher therefore takes the boundary from the producer
// (DiscoveredMCPTool.serverName/serverToolName, carried on the invocation and
// resolvable from the registry) whenever the caller supplies it.
describe('the producer-carried identity channel (R4-2)', () => {
  const FOO_UNDERSCORE_TOOL = 'mcp__foo____internal';
  const fooUnderscoreIdentity = {
    serverName: 'foo_',
    serverToolName: '_internal',
  };

  it('refuses a whole-server rule for foo against a foo_ tool when identity is present', () => {
    expect(
      matchesMcpPattern(
        'mcp__foo',
        FOO_UNDERSCORE_TOOL,
        undefined,
        undefined,
        fooUnderscoreIdentity,
      ),
    ).toBe(false);
    expect(
      matchesToolPattern(
        'mcp__foo',
        FOO_UNDERSCORE_TOOL,
        undefined,
        fooUnderscoreIdentity,
      ),
    ).toBe(false);
  });

  it('still matches the foo_ server own whole-server rule', () => {
    expect(
      matchesMcpPattern(
        'mcp__foo_',
        FOO_UNDERSCORE_TOOL,
        undefined,
        undefined,
        fooUnderscoreIdentity,
      ),
    ).toBe(true);
  });

  it('refuses a whole-server wildcard for foo against a foo_ tool when identity is present', () => {
    expect(
      matchesMcpPattern(
        'mcp__foo__*',
        FOO_UNDERSCORE_TOOL,
        undefined,
        undefined,
        fooUnderscoreIdentity,
      ),
    ).toBe(false);
    // The foo_ whole-server spelling itself keeps working.
    expect(
      matchesMcpPattern(
        'mcp__foo___*',
        FOO_UNDERSCORE_TOOL,
        undefined,
        undefined,
        fooUnderscoreIdentity,
      ),
    ).toBe(true);
  });

  it('reads a pure-underscore tool prefix as separator continuation, not a tool filter', () => {
    // `mcp__foo____*` is `mcp__foo__` + `_*`: without the guard it would act
    // as a tool-prefix wildcard for underscore-led tools on server foo_.
    expect(
      matchesMcpPattern(
        'mcp__foo____*',
        FOO_UNDERSCORE_TOOL,
        undefined,
        undefined,
        fooUnderscoreIdentity,
      ),
    ).toBe(false);
    // A tool prefix with real characters is a genuine filter.
    expect(
      matchesMcpPattern(
        'mcp__foo____in*',
        FOO_UNDERSCORE_TOOL,
        undefined,
        undefined,
        fooUnderscoreIdentity,
      ),
    ).toBe(true);
  });

  it('does not over-restrict mid-name underscores: a foo_bar tool answers only its own server rule', () => {
    // `split('__')` keeps `foo_bar` as one segment (single underscores are
    // not separators), so the spelling layer already refuses `mcp__foo`
    // here; the pin is that the identity compare stays exactly as strict —
    // no `startsWith` on either side — while `mcp__foo_bar` keeps matching.
    const fooBarIdentity = { serverName: 'foo_bar', serverToolName: 'baz' };
    expect(
      matchesMcpPattern(
        'mcp__foo',
        'mcp__foo_bar__baz',
        undefined,
        undefined,
        fooBarIdentity,
      ),
    ).toBe(false);
    expect(
      matchesMcpPattern(
        'mcp__foo_bar',
        'mcp__foo_bar__baz',
        undefined,
        undefined,
        fooBarIdentity,
      ),
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
    const identity = {
      serverName: tool.serverName,
      serverToolName: tool.serverToolName,
    };

    const pm = new PermissionManager(
      makeConfig({ permissionsAllow: ['mcp__foo'] }),
    );
    pm.initialize();
    expect(
      await pm.evaluate({
        toolName: tool.name,
        toolAliases: tool.permissionAliases,
        mcpIdentity: identity,
      }),
    ).toBe('default');
    // Registration-level check agrees: the foo_ tool is not disabled by a
    // deny written for foo either.
    const pmDeny = new PermissionManager(
      makeConfig({ permissionsDeny: ['mcp__foo'] }),
    );
    pmDeny.initialize();
    expect(
      await pmDeny.getToolRegistrationStatus(
        tool.name,
        tool.permissionAliases,
        identity,
      ),
    ).toBe('registered');

    // Positive control: server foo's own tool is still covered by the rule.
    const ownTool = prodTool('foo', 'deploy');
    expect(
      await pm.evaluate({
        toolName: ownTool.name,
        toolAliases: ownTool.permissionAliases,
        mcpIdentity: {
          serverName: ownTool.serverName,
          serverToolName: ownTool.serverToolName,
        },
      }),
    ).toBe('allow');
    expect(
      await pmDeny.getToolRegistrationStatus(
        ownTool.name,
        ownTool.permissionAliases,
        {
          serverName: ownTool.serverName,
          serverToolName: ownTool.serverToolName,
        },
      ),
    ).toBe('disabled');
  });

  it('keeps the documented match-all and partial-key wildcards working (R13-1)', () => {
    const identity = { serverName: 'foo_bar', serverToolName: 'evil' };
    // A prefix that closes no server segment is coarser than any boundary the
    // producer can speak to, so it still matches every MCP tool.
    expect(
      matchesMcpPattern(
        'mcp__*',
        SAFE_SERVER_TOOL,
        undefined,
        undefined,
        identity,
      ),
    ).toBe(true);
    expect(
      matchesToolPattern('mcp__*', SAFE_SERVER_TOOL, undefined, identity),
    ).toBe(true);
    expect(
      matchesMcpPattern(
        'mcp__foo*',
        SAFE_SERVER_TOOL,
        undefined,
        undefined,
        identity,
      ),
    ).toBe(true);
    // A prefix that does close a segment still names its own server only.
    expect(
      matchesMcpPattern(
        'mcp__foo__*',
        SAFE_SERVER_TOOL,
        undefined,
        undefined,
        identity,
      ),
    ).toBe(false);
  });

  it('matches a rule written in the registered spelling of an unsafe key (R13-1)', async () => {
    const tool = prodTool('foo:bar', 'a.b');
    const identity = {
      serverName: tool.serverName,
      serverToolName: tool.serverToolName,
    };
    // The registered provider-safe spelling is what the UI and the model show,
    // so a server-level or wildcard rule copied from there keeps matching.
    expect(
      matchesMcpPattern(
        'mcp__foo_bar',
        tool.name,
        undefined,
        tool.permissionAliases,
        identity,
      ),
    ).toBe(true);
    expect(
      matchesMcpPattern(
        'mcp__foo_bar__*',
        tool.name,
        undefined,
        tool.permissionAliases,
        identity,
      ),
    ).toBe(true);
    // The tool side of a rule is written in a rendering as well.
    expect(
      matchesMcpPattern(
        'mcp__foo_bar__a_b*',
        tool.name,
        undefined,
        tool.permissionAliases,
        identity,
      ),
    ).toBe(true);
    expect(
      matchesMcpPattern(
        'mcp__foo:bar',
        tool.name,
        undefined,
        tool.permissionAliases,
        identity,
      ),
    ).toBe(true);

    const pm = new PermissionManager(
      makeConfig({ permissionsDeny: ['mcp__foo_bar'] }),
    );
    pm.initialize();
    expect(
      await pm.evaluate({
        toolName: tool.name,
        toolAliases: tool.permissionAliases,
        mcpIdentity: identity,
      }),
    ).toBe('deny');
  });

  it('reads an all-underscore tool prefix as this server own tool (R13-1)', async () => {
    const tool = prodTool('github', '__debug');
    expect(tool.name).toBe('mcp__github____debug');
    const identity = {
      serverName: tool.serverName,
      serverToolName: tool.serverToolName,
    };
    expect(
      matchesMcpPattern(
        'mcp__github____*',
        tool.name,
        undefined,
        tool.permissionAliases,
        identity,
      ),
    ).toBe(true);

    // The guard that keeps a sibling key out stays: `mcp__foo____*` was
    // written for server `foo`, so it must not auto-approve `foo_`'s tool.
    const sibling = prodTool('foo_', '_internal');
    const pm = new PermissionManager(
      makeConfig({ permissionsAllow: ['mcp__foo____*'] }),
    );
    pm.initialize();
    expect(
      await pm.evaluate({
        toolName: sibling.name,
        toolAliases: sibling.permissionAliases,
        mcpIdentity: {
          serverName: sibling.serverName,
          serverToolName: sibling.serverToolName,
        },
      }),
    ).toBe('default');
  });
});

// The three wildcard-arm refinements from the round-17 review: the tool side
// of a boundary-matched prefix also reads the registered name's own tool
// segment (R13-1), the separator-continuation guard requires the tool name to
// actually start with those underscores (R17-1), and coarse-vs-foreign is
// decided by the producer's own renderings instead of a segment count of the
// flattened rule (R17-2).
describe('wildcard arms read the producer identity, not a re-split (R13-1/R17-1/R17-2)', () => {
  it('matches a tool prefix that reaches into the registered name hash suffix (R13-1)', async () => {
    // `search.repositories` registers as `mcp__github__search_repositories_<hash>`;
    // a rule copied from `/tools` as a literal prefix of that spelling must
    // keep matching — the producer renderings alone stop one character short.
    const tool = prodTool('github', 'search.repositories');
    const identity = {
      serverName: tool.serverName,
      serverToolName: tool.serverToolName,
    };
    expect(
      matchesToolPattern(
        'mcp__github__search_repositories_*',
        tool.name,
        tool.permissionAliases,
        identity,
      ),
    ).toBe(true);

    const pm = new PermissionManager(
      makeConfig({
        permissionsDeny: ['mcp__github__search_repositories_*'],
      }),
    );
    pm.initialize();
    expect(
      await pm.evaluate({
        toolName: tool.name,
        toolAliases: tool.permissionAliases,
        mcpIdentity: identity,
      }),
    ).toBe('deny');
  });

  it('refuses a sibling-key whole-server spelling that lands as separator continuation (R17-1)', async () => {
    // `mcp__foo___*` is server `foo_`'s whole-server wildcard spelling; the
    // rule's own segment reads `foo` once the separator absorbs the trailing
    // underscore, so the guard must also require the tool name to start with
    // the underscores — server `foo`'s `deploy` does not.
    const tool = prodTool('foo', 'deploy');
    expect(tool.name).toBe('mcp__foo__deploy');
    expect(
      matchesMcpPattern('mcp__foo___*', tool.name, undefined, undefined, {
        serverName: 'foo',
        serverToolName: 'deploy',
      }),
    ).toBe(false);

    const pm = new PermissionManager(
      makeConfig({ permissionsAllow: ['mcp__foo___*'] }),
    );
    pm.initialize();
    expect(
      await pm.evaluate({
        toolName: tool.name,
        toolAliases: tool.permissionAliases,
        mcpIdentity: { serverName: 'foo', serverToolName: 'deploy' },
      }),
    ).toBe('default');
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

    const pm = new PermissionManager(
      makeConfig({ permissionsDeny: ['mcp__my__svc*'] }),
    );
    pm.initialize();
    expect(
      await pm.evaluate({
        toolName: doubleUnderscoreKey.name,
        toolAliases: doubleUnderscoreKey.permissionAliases,
        mcpIdentity: { serverName: 'my__svc', serverToolName: 'deploy' },
      }),
    ).toBe('deny');
  });
});

describe('restrictive rules retain exact truncated legacy spellings (R15-1)', () => {
  it.each([
    ['s'.repeat(22), 't'.repeat(40)],
    ['s'.repeat(24), 't'.repeat(40)],
    ['weather-forecast-server-premium', 'get_extended_forecast_for_next_week'],
    ['a__very_long_server_key_name_alpha', 't'.repeat(40)],
    ['a__very_long_server_key_name_beta', 't'.repeat(40)],
  ])('keeps deny/ask without widening allow for %s', async (server, name) => {
    const tool = prodTool(server, name);
    const legacy = generateLegacyMcpToolName(`mcp__${server}__${name}`);
    expect(tool.permissionAliases).not.toContain(legacy);
    const ctx = {
      toolName: tool.name,
      toolAliases: tool.permissionAliases,
      mcpIdentity: {
        serverName: tool.serverName,
        serverToolName: tool.serverToolName,
      },
    };
    const deny = new PermissionManager(
      makeConfig({ permissionsDeny: [legacy] }),
    );
    deny.initialize();
    expect(await deny.evaluate(ctx)).toBe('deny');
    expect(deny.findMatchingDenyRule(ctx)).toBe(legacy);
    expect(deny.hasRelevantRules(ctx)).toBe(true);
    expect(
      await deny.isToolEnabled(
        tool.name,
        tool.permissionAliases,
        ctx.mcpIdentity,
      ),
    ).toBe(false);
    expect(
      matchesToolPattern(
        legacy,
        tool.name,
        tool.permissionAliases,
        ctx.mcpIdentity,
      ),
    ).toBe(true);

    const ask = new PermissionManager(
      makeConfig({ permissionsAsk: [legacy], permissionsAllow: [tool.name] }),
    );
    ask.initialize();
    expect(await ask.evaluate(ctx)).toBe('ask');
    expect(ask.hasMatchingAskRule(ctx)).toBe(true);

    const allow = new PermissionManager(
      makeConfig({ permissionsAllow: [legacy] }),
    );
    allow.initialize();
    expect(await allow.evaluate(ctx)).toBe('default');
    expect(allow.hasRelevantRules(ctx)).toBe(false);
    const unrelated = prodTool('unrelated', name);
    expect(
      await deny.evaluate({
        toolName: unrelated.name,
        toolAliases: unrelated.permissionAliases,
        mcpIdentity: {
          serverName: unrelated.serverName,
          serverToolName: unrelated.serverToolName,
        },
      }),
    ).toBe('default');
  });
});
