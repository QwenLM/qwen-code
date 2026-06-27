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

import picomatch from 'picomatch';
import type { SkillConfig } from './types.js';
import { createDebugLogger } from '../utils/debugLogger.js';
import { resolveProjectRelativePath } from '../utils/projectPath.js';

// Re-export so existing consumers (skill-activation.test.ts) keep
// working through the old import path. The canonical home is now
// `utils/projectPath.ts` so `ConditionalRulesRegistry` can share the
// same Windows-cross-drive guard without inverting the dependency
// direction (utils → skills would be wrong).
export { resolveProjectRelativePath } from '../utils/projectPath.js';

const debugLogger = createDebugLogger('SKILL_ACTIVATION');

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
/**
 * Optional callback invoked by the registry when picomatch rejects a
 * `paths:` entry. SkillManager wires this into its `parseErrors` map
 * so the failure is surfaced via `getParseErrors()` (and the `/skills`
 * UI) instead of only landing in debug logs.
 */
export type InvalidPatternHandler = (
  skill: SkillConfig,
  pattern: string,
  error: Error,
) => void;

export class SkillActivationRegistry {
  private readonly compiled: CompiledSkill[];
  private readonly activated = new Set<string>();
  private readonly projectRoot: string;

  constructor(
    conditionalSkills: readonly SkillConfig[],
    projectRoot: string,
    onInvalidPattern?: InvalidPatternHandler,
  ) {
    this.projectRoot = projectRoot;
    this.compiled = conditionalSkills.map((skill) => {
      const matchers: picomatch.Matcher[] = [];
      for (const p of skill.paths ?? []) {
        try {
          // dot: true so broad globs like `**/*.js` activate on
          // dotfiles too (`.eslintrc.js`, `.env`, `.github/foo.yml`).
          // Skill activation asks "did the model touch a file matching
          // this glob" — the gitignore-style "skip hidden" exclusion
          // makes sense for filesystem walks, not for activation.
          matchers.push(picomatch(p, { dot: true }));
        } catch (e) {
          // picomatch can throw on pathological inputs (oversize patterns,
          // broken extglob nesting). Drop the offending pattern but keep
          // the rest of the skill — better than letting the error bubble
          // up to refreshCache and abort skill loading entirely (this
          // site is outside the levels-level Promise.allSettled boundary).
          //
          // Surface to the caller (SkillManager) so the failure shows up
          // in `getParseErrors()` / the `/skills` UI instead of
          // disappearing into a debug-level log line that the typical
          // skill author never sees.
          const err = e instanceof Error ? e : new Error(String(e));
          debugLogger.warn(
            `Skill "${skill.name}" has invalid glob "${p}", skipping pattern: ${err.message}`,
          );
          onInvalidPattern?.(skill, p, err);
        }
      }
      return { skill, matchers };
    });
  }

  /**
   * Activate any conditional skills whose `paths` globs match `filePath`.
   * Returns the names of skills newly activated by this call (empty when
   * either no skill matched, or every match was already active).
   */
  matchAndConsume(filePath: string): string[] {
    if (this.compiled.length === 0) return [];

    // Skip files outside the project root — conditional skills are scoped
    // to the project, matching ConditionalRulesRegistry's behavior. The
    // helper handles the Windows cross-drive case (where `path.relative`
    // returns an absolute string).
    const relativePath = resolveProjectRelativePath(filePath, this.projectRoot);
    if (relativePath === null) {
      debugLogger.debug(
        `Skipping ${filePath}: outside project root or cross-drive`,
      );
      return [];
    }
    debugLogger.debug(`matchAndConsume ${filePath} → relative=${relativePath}`);

    const newlyActivated: string[] = [];
    for (const { skill, matchers } of this.compiled) {
      if (this.activated.has(skill.name)) continue;
      if (matchers.some((m) => m(relativePath))) {
        this.activated.add(skill.name);
        newlyActivated.push(skill.name);
        debugLogger.info(
          `Activated skill "${skill.name}" via path "${relativePath}"`,
        );
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
