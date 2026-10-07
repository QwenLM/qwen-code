/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * What a deployment's tool-surface settings actually do, configuration by
 * configuration.
 *
 * `tools.eager` is the largest single lever on resident context — in the
 * #12028 sample it takes built-in tool schemas from 21,461 to ~5,868 tokens
 * with no code change — and nothing in the product shows an operator what
 * their list resolves to before they ship it. This file resolves the surface
 * for a handful of realistic configurations and prints it, which is the part of
 * #12333's gate that needs no model: it answers *which tools a configuration
 * withholds*, deterministically, with no registry, network or model.
 *
 * The base semantics it relies on are pinned next door in
 * `permission-manager.test.ts`: which families are exempt from the allowlist,
 * that a deny rule beats eager membership, that `deferred` is not `disabled`,
 * and that `permissions.allow` reshapes nothing. This file does not repeat
 * those. It adds the report, the one mistake a real deployment made, and the
 * monotonicity property that makes a tuned list predictable.
 *
 * Two honest limits:
 *
 * - The status here is the *permission-derived* one. A tool whose own class
 *   sets `shouldDefer=true` (`task_stop`, `monitor`, `computer_use__*`, …) is
 *   on demand regardless, so `registered` means "the settings do not withhold
 *   it", not "its schema is in the first request".
 * - Nothing here says whether the model *thinks to* reach a withheld tool.
 *   That is recall, it needs a real model against a task set, and #12333
 *   records why the existing benchmark cannot ask it today.
 */

import { describe, expect, it } from 'vitest';
import { PermissionManager } from './permission-manager.js';
import type {
  PermissionManagerConfig,
  ToolRegistrationStatus,
} from './permission-manager.js';
import { ToolNames } from '../tools/tool-names.js';

function makeConfig(
  opts: Partial<{
    eagerTools: string[];
    permissionsDeny: string[];
  }> = {},
): PermissionManagerConfig {
  return {
    getPermissionsAllow: () => undefined,
    getPermissionsAsk: () => undefined,
    getPermissionsDeny: () => opts.permissionsDeny,
    getCoreTools: () => undefined,
    getEagerTools: () => opts.eagerTools,
    getProjectRoot: () => '/project',
    getCwd: () => '/project',
    getApprovalMode: () => 'default',
  };
}

/** Every built-in tool name, plus one sample from each dynamic family. */
const MCP_SAMPLE = 'mcp__acme__search';
const COMPUTER_USE_SAMPLE = 'computer_use__screenshot';
const ALL_NAMES: readonly string[] = [
  ...Object.values(ToolNames),
  MCP_SAMPLE,
  COMPUTER_USE_SAMPLE,
];

/** The allowlist a file-and-shell deployment would write. */
const FILE_WORK_ALLOWLIST = [
  ToolNames.READ_FILE,
  ToolNames.WRITE_FILE,
  ToolNames.EDIT,
  ToolNames.GLOB,
  ToolNames.GREP,
  ToolNames.SHELL,
  ToolNames.SKILL,
];

const WITHOUT_SKILL = FILE_WORK_ALLOWLIST.filter(
  (name) => name !== ToolNames.SKILL,
);

async function resolveSurface(
  config: PermissionManagerConfig,
): Promise<Map<string, ToolRegistrationStatus>> {
  const manager = new PermissionManager(config);
  manager.initialize();
  const surface = new Map<string, ToolRegistrationStatus>();
  for (const name of ALL_NAMES) {
    surface.set(name, await manager.getToolRegistrationStatus(name));
  }
  return surface;
}

function namesWithStatus(
  surface: Map<string, ToolRegistrationStatus>,
  status: ToolRegistrationStatus,
): string[] {
  return [...surface]
    .filter(([, value]) => value === status)
    .map(([name]) => name)
    .sort();
}

const SHAPES = [
  { label: 'default — no allowlist', config: makeConfig() },
  {
    label: 'file work — 7-tool allowlist',
    config: makeConfig({ eagerTools: FILE_WORK_ALLOWLIST }),
  },
  {
    label: 'file work, skill omitted',
    config: makeConfig({ eagerTools: WITHOUT_SKILL }),
  },
  { label: 'empty allowlist', config: makeConfig({ eagerTools: [] }) },
  {
    label: 'whole-tool deny on zoom_image',
    config: makeConfig({ permissionsDeny: [ToolNames.ZOOM_IMAGE] }),
  },
] as const;

describe('eager tool surface per deployment configuration', () => {
  /**
   * Printed, not asserted: the absolute counts depend on which tools exist in
   * this release, and an operator comparing two configurations wants the list
   * of names, not a number that every new tool changes. The assertion is only
   * that each configuration produced a line, so a refactor that silently
   * stopped resolving anything still fails.
   */
  it('prints the resolved surface for each configuration', async () => {
    const lines: string[] = [];
    for (const { label, config } of SHAPES) {
      const surface = await resolveSurface(config);
      const withheld = namesWithStatus(surface, 'deferred');
      const removed = namesWithStatus(surface, 'disabled');
      lines.push(
        `${label}: ${namesWithStatus(surface, 'registered').length} registered, ` +
          `${withheld.length} withheld, ${removed.length} removed`,
      );
      if (withheld.length > 0) lines.push(`  withheld: ${withheld.join(', ')}`);
      if (removed.length > 0) lines.push(`  removed:  ${removed.join(', ')}`);
    }
    console.log(`\n${lines.join('\n')}\n`);
    expect(lines.length).toBeGreaterThanOrEqual(SHAPES.length);
  });

  /**
   * The trap that broke the skill route in the session behind #12028: an
   * allowlist that omits `skill` withholds it, while the skill *listing* stays
   * in the prompt regardless — the model is told which skills exist and then
   * has no declared tool to load one with. Recoverable through ToolSearch, but
   * only if the model thinks to look, which is the half this file cannot
   * measure. Asserted both ways so the trap cannot become invisible.
   */
  it('withholds skill when an allowlist omits it', async () => {
    const withSkill = await resolveSurface(
      makeConfig({ eagerTools: FILE_WORK_ALLOWLIST }),
    );
    const withoutSkill = await resolveSurface(
      makeConfig({ eagerTools: WITHOUT_SKILL }),
    );

    expect(withSkill.get(ToolNames.SKILL)).toBe('registered');
    expect(withoutSkill.get(ToolNames.SKILL)).toBe('deferred');
  });

  /**
   * Monotonicity: a shorter allowlist withholds a superset. Without it, a
   * future exemption could make a narrower configuration withhold *less*, and
   * an operator tuning the list would be reading a number that does not move in
   * the direction they expect.
   */
  it('withholds a superset as the allowlist narrows', async () => {
    const wide = await resolveSurface(
      makeConfig({ eagerTools: FILE_WORK_ALLOWLIST }),
    );
    const narrow = await resolveSurface(makeConfig({ eagerTools: [] }));
    const wideWithheld = new Set(namesWithStatus(wide, 'deferred'));
    const narrowWithheld = new Set(namesWithStatus(narrow, 'deferred'));

    for (const name of wideWithheld) {
      expect(narrowWithheld.has(name)).toBe(true);
    }
    expect(narrowWithheld.size).toBeGreaterThan(wideWithheld.size);
  });

  /**
   * The extreme a deployment might actually try — `"eager": []` — compared
   * against the baseline rather than against an empty expectation: whatever a
   * release removes by other means, the allowlist must not add to it. This is
   * the #9827 / #10075 guarantee at the one setting where "withhold everything"
   * could most easily turn into "remove everything".
   */
  it('removes nothing that the baseline configuration keeps', async () => {
    const baseline = await resolveSurface(makeConfig());
    const narrow = await resolveSurface(makeConfig({ eagerTools: [] }));

    expect(namesWithStatus(narrow, 'disabled')).toEqual(
      namesWithStatus(baseline, 'disabled'),
    );
  });
});
