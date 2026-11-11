/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type { Config } from '../config/config.js';
import { SKILL_TOOL_NAME } from '../tools/tool-names.js';
import { WORKFLOW_AUTHORING_SKILL_NAME } from './workflow-prompts.js';

/** Use the tools exposed to this caller, not the root registry's superset. */
export function isWorkflowAuthoringAvailable(
  config: Config,
  toolNames: Iterable<string>,
): boolean {
  const names = new Set(toolNames);
  if (!names.has(SKILL_TOOL_NAME)) {
    return false;
  }
  const manager = config.getSkillManager();
  if (!manager.isAdminEnabled()) return false;
  const guide = manager.getSkill(WORKFLOW_AUTHORING_SKILL_NAME);
  if (!guide || guide.disabled) return false;
  // This authoring gate is separate from the general model-visible Skill
  // list. Path activation and disable-model-invocation still filter that list
  // and Skill execution, but do not select the Workflow full-text fallback.
  const visibility = manager.getSkillVisibilityOverride(guide.name);
  if (visibility === 'off' || visibility === 'user-invocable-only') {
    return false;
  }
  // Unlike the general Skill list, authoring availability uses the session
  // allowlist for both the main session and subagents.
  return manager.isSkillAllowedForMainSession(guide.name);
}
