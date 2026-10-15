/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import type { SkillLevel } from '@qwen-code/qwen-code-core';
import { t } from '../../i18n/index.js';
import { extensionOwnerLabel } from '../../services/commandMetadata.js';

// Call at render/command time, not module-load, so `/language` switches take effect.
export function levelLabel(level: SkillLevel): string {
  switch (level) {
    case 'project':
      return t('Project');
    case 'user':
      return t('User');
    case 'extension':
      return t('Extension');
    case 'bundled':
      return t('Bundled');
    default: {
      const _exhaustive: never = level;
      return _exhaustive;
    }
  }
}

/**
 * The parenthesised origin shown next to a skill on the surfaces the user
 * reads — `(Extension: Rust)` for an extension skill, the bare level word for
 * everything else.
 *
 * An extension skill gets the owner rather than the level because the level
 * says nothing the reader can act on when several extensions are installed:
 * `(Extension)` on twenty rows does not tell you which one to go configure.
 * Every other level keeps its word, because there the level *is* the answer to
 * "where did this come from".
 *
 * The owner comes from `extensionOwnerLabel`, never from parsing `name` — `:`
 * is legal inside an authored skill name.
 */
export function skillOriginLabel(skill: {
  level: SkillLevel;
  /**
   * Never read. A `SkillConfig` variable already satisfies this parameter
   * structurally; the field is declared so an object literal that *does* name
   * one — the anti-reparse fixture in `skill-level-label.test.ts` — passes
   * excess-property checking.
   */
  name?: string;
  extensionName?: string;
  extensionDisplayName?: string;
}): string {
  if (skill.level === 'extension') {
    return `(${extensionOwnerLabel({
      name: skill.extensionName,
      displayName: skill.extensionDisplayName,
    })})`;
  }
  // Delegated so the exhaustive level switch stays in one place.
  return `(${levelLabel(skill.level)})`;
}
