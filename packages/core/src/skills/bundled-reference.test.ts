/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * The read cache is one map shared by every bundled reference in the process,
 * so the skill name is the only thing keeping two references apart. Both are
 * reachable in a single session — `config.ts` registers `AgentTool`
 * unconditionally and `WorkflowTool` on the same `Config` — and whichever tool
 * is constructed first populates the entry the other then reads. A cache
 * narrowed back to the single slot this map was extracted from therefore
 * inlines one tool's reference into the other's description, silently.
 *
 * These cases read both references through one module instance, on purpose and
 * in both orders. Each order gets a cold cache of its own — one
 * `vi.resetModules()` per case, then one re-import, so the two reads of a case
 * share a single fresh instance. The reset has to stay per case rather than per
 * read: a fresh registry for every read would hand each one an empty cache and
 * let a single-slot cache pass, which is the failure being pinned.
 * (`workflow-authoring-skill.test.ts` does reset, for the opposite reason — it
 * needs the cache cold to exercise a failed read.)
 */

import { describe, expect, it, vi } from 'vitest';
import { AGENT_DELEGATION_SKILL_NAME } from './agent-delegation-skill.js';
import {
  readBundledReference,
  resolveBundledReferenceRoute,
  isToolHiddenBehindToolSearch,
} from './bundled-reference.js';
import type { Config } from '../config/config.js';
import { WORKFLOW_AUTHORING_SKILL_NAME } from './workflow-authoring-skill.js';

/** First body line of each reference, after the frontmatter is stripped. */
const WORKFLOW_ANCHOR = '# Workflow authoring reference';
const DELEGATION_ANCHOR = '# Delegation prompt reference';

const REFERENCES = [
  [WORKFLOW_AUTHORING_SKILL_NAME, WORKFLOW_ANCHOR, DELEGATION_ANCHOR],
  [AGENT_DELEGATION_SKILL_NAME, DELEGATION_ANCHOR, WORKFLOW_ANCHOR],
] as const;

describe('hybrid reference routes', () => {
  it.each([
    [[], 'skill'],
    [['tool_search'], 'skill'],
    [['tool_call'], 'skill'],
    [['tool_search', 'tool_call'], 'skill-via-tool-search'],
  ] as const)('uses a reachable skill with bridge %j', (bridge, route) => {
    const config = {
      getToolMode: () => 'code_mode',
      getSkillManager: () => ({}),
      getToolRegistry: () => ({
        getAllToolNames: () => ['exec', 'skill', ...bridge],
        isPermissionDeferred: () => true,
        isDeferredToolRevealed: () => false,
      }),
    } as unknown as Config;
    expect(resolveBundledReferenceRoute(config, 'agent-delegation')).toBe(
      route,
    );
    expect(isToolHiddenBehindToolSearch(config, 'skill')).toBe(
      bridge.length === 2,
    );
  });

  it('inlines a hidden skill when both exec and the bridge are unavailable', () => {
    const config = {
      getToolMode: () => 'code_mode',
      getSkillManager: () => ({}),
      getToolRegistry: () => ({
        getAllToolNames: () => ['skill'],
        isPermissionDeferred: () => true,
      }),
    } as unknown as Config;
    expect(resolveBundledReferenceRoute(config, 'agent-delegation')).toBe(
      'inline',
    );
  });
});

describe('readBundledReference', () => {
  /**
   * Both orders, because a single-slot cache is wrong in whichever order it is
   * filled: the second read returns the first reference's body. Asserting one
   * order would leave the other half of the collision unmeasured.
   */
  it.each([
    ['workflow-authoring first', 0, 1],
    ['agent-delegation first', 1, 0],
  ])(
    'returns each skill its own body when %s',
    async (_case, firstIndex, secondIndex) => {
      const [firstName, firstAnchor, firstOther] = REFERENCES[firstIndex];
      const [secondName, secondAnchor, secondOther] = REFERENCES[secondIndex];

      // Cold per case: through the file-wide instance the second case would
      // find both entries already filled by the first and re-assert them, so
      // the order it names would never be the order actually filled.
      vi.resetModules();
      const cold = await import('./bundled-reference.js');

      const first = cold.readBundledReference(firstName);
      const second = cold.readBundledReference(secondName);

      expect(first?.body).toContain(firstAnchor);
      expect(first?.body).not.toContain(firstOther);
      expect(second?.body).toContain(secondAnchor);
      expect(second?.body).not.toContain(secondOther);
    },
  );

  it('caches per skill, so the base directory follows the name too', () => {
    for (const [name] of REFERENCES) {
      const reference = readBundledReference(name);

      expect(reference).not.toBeNull();
      expect(reference?.baseDir.endsWith(name)).toBe(true);
    }
  });

  it('answers a repeated read from the cache with the same body', () => {
    for (const [name, anchor] of REFERENCES) {
      const first = readBundledReference(name);
      const second = readBundledReference(name);

      expect(second).toBe(first);
      expect(second?.body).toContain(anchor);
    }
  });
});
