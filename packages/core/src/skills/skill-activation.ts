/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

// Path-based skill activation (turn-level lazy offering).
//
// Skills with a `paths:` frontmatter are "conditional": they stay out of the
// SkillTool listing until a tool call touches a file matching one of their
// glob patterns. This keeps the model's tool description small in large
// monorepos where most skills are irrelevant to the current task.
//
// Mirrors the design of ConditionalRulesRegistry in utils/rulesDiscovery.ts
// but returns skill names (not content), because the activation affects which
// skills are advertised in SkillTool's description rather than injecting text.

import * as path from 'node:path';
import picomatch from 'picomatch';
import type { SkillConfig } from './types.js';

interface CompiledSkill {
  readonly skill: SkillConfig;
  readonly matchers: picomatch.Matcher[];
}

/**
 * Splits a skill list into unconditional skills (no `paths:`) and conditional
 * skills (with non-empty `paths:`). Unconditional skills are always offered to
 * the model; conditional skills only appear after activation.
 */
export function splitConditionalSkills(skills: readonly SkillConfig[]): {
  unconditional: SkillConfig[];
  conditional: SkillConfig[];
} {
  const unconditional: SkillConfig[] = [];
  const conditional: SkillConfig[] = [];
  for (const skill of skills) {
    if (skill.paths && skill.paths.length > 0) {
      conditional.push(skill);
    } else {
      unconditional.push(skill);
    }
  }
  return { unconditional, conditional };
}

/**
 * Tracks which conditional skills have been activated during the session by
 * matching tool-invocation file paths against each skill's `paths` globs.
 *
 * Once activated, a skill stays active for the rest of the registry's
 * lifetime. A new registry is constructed on every `refreshCache()` so that
 * edits to skill files (adding/removing `paths`) take effect; prior
 * activations do not carry over across rebuilds (same as
 * ConditionalRulesRegistry).
 */
export class SkillActivationRegistry {
  private readonly compiled: CompiledSkill[];
  private readonly activated = new Set<string>();
  private readonly projectRoot: string;

  constructor(conditionalSkills: readonly SkillConfig[], projectRoot: string) {
    this.projectRoot = projectRoot;
    this.compiled = conditionalSkills.map((skill) => ({
      skill,
      matchers: (skill.paths ?? []).map((p) => picomatch(p, { dot: false })),
    }));
  }

  /**
   * Activate any conditional skills whose `paths` globs match `filePath`.
   * Returns the names of skills newly activated by this call (empty when
   * either no skill matched, or every match was already active).
   */
  matchAndConsume(filePath: string): string[] {
    if (this.compiled.length === 0) return [];

    const absolutePath = path.isAbsolute(filePath)
      ? filePath
      : path.resolve(this.projectRoot, filePath);
    const relativePath = path
      .relative(this.projectRoot, absolutePath)
      .replace(/\\/g, '/');

    // Skip files outside the project root — conditional skills are scoped to
    // the project, matching ConditionalRulesRegistry's behavior.
    if (relativePath === '..' || relativePath.startsWith('../')) {
      return [];
    }

    const newlyActivated: string[] = [];
    for (const { skill, matchers } of this.compiled) {
      if (this.activated.has(skill.name)) continue;
      if (matchers.some((m) => m(relativePath))) {
        this.activated.add(skill.name);
        newlyActivated.push(skill.name);
      }
    }
    return newlyActivated;
  }

  isActivated(name: string): boolean {
    return this.activated.has(name);
  }

  getActivatedNames(): ReadonlySet<string> {
    return this.activated;
  }

  get totalCount(): number {
    return this.compiled.length;
  }

  get activatedCount(): number {
    return this.activated.size;
  }
}
