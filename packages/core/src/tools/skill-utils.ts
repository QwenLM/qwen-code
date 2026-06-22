/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import type { PermissionManager } from '../permissions/permission-manager.js';
import type { Config } from '../config/config.js';
import type { SkillManager } from '../skills/skill-manager.js';
import type { SkillConfig, SkillLevel } from '../skills/types.js';
import { escapeXml } from '../utils/xml.js';

/**
 * Builds the LLM-facing content string when a skill body is injected.
 * Shared between SkillToolInvocation (runtime) and /context (estimation)
 * so that token estimates stay in sync with actual usage.
 */
export function buildSkillLlmContent(baseDir: string, body: string): string {
  return `Base directory for this skill: ${baseDir}\nImportant: ALWAYS resolve absolute paths from this base directory when working with skills.\n\n${body}\n`;
}

/**
 * One model-facing skill/command entry, normalized so file-based skills and
 * model-invocable commands (MCP prompts / file commands) render through a single
 * code path. `level` is present only for file-based skills — when set, the
 * rendered entry carries a `(level)` suffix and a <location> tag (matching the
 * legacy `SkillTool.updateDescriptionAndSchema` output); commands omit both.
 */
export interface AvailableSkillEntry {
  name: string;
  description: string;
  whenToUse?: string;
  level?: SkillLevel;
}

/**
 * Result of `collectAvailableSkillEntries`. The first three fields back
 * `SkillTool.validateToolParams` (in-memory only — never serialized into a
 * request, so refreshing them is prompt-cache-neutral); `entries` feeds the
 * pure `renderAvailableSkillsBlock`.
 */
export interface CollectedAvailableSkills {
  /** Active, model-invocable file-based skills. */
  availableSkills: SkillConfig[];
  /**
   * Conditional skills (`paths:` frontmatter) that exist but are not yet
   * activated — tracked so validation can distinguish "gated by paths:" from
   * "not found".
   */
  pendingConditionalSkillNames: Set<string>;
  /** Model-invocable commands, deduped against file-based skill names. */
  modelInvocableCommands: ReadonlyArray<{ name: string; description: string }>;
  /** Normalized entries, ready for `renderAvailableSkillsBlock`. */
  entries: AvailableSkillEntry[];
}

/**
 * Collects the model-facing skill set — active file-based skills + model-invocable
 * commands — applying the same filtering/dedup rules `SkillTool.refreshSkills`
 * used to apply inline. Stateful/async (reads `SkillManager` + `Config`). The
 * returned validation fields and the `entries` list are always consistent, so
 * the Skill tool, the startup snapshot, and activation reminders share identical
 * bytes from one source.
 */
export async function collectAvailableSkillEntries(
  skillManager: SkillManager,
  config: Config,
): Promise<CollectedAvailableSkills> {
  // Include a skill only when (a) it is not hidden from the model
  // (`disable-model-invocation`), (b) it is not user-disabled via
  // `skills.disabled`, and (c) it is unconditional or already activated by a
  // matching file path this session. Keeps the listing small in large monorepos
  // where most conditional skills are not yet relevant.
  const allSkills = await skillManager.listSkills();
  const disabledNames = config.getDisabledSkillNames();
  const isDisabled = (name: string) => disabledNames.has(name.toLowerCase());

  const availableSkills = allSkills.filter(
    (s) =>
      !s.disableModelInvocation &&
      skillManager.isSkillActive(s) &&
      !isDisabled(s.name),
  );

  // Track still-pending conditional skills so validation can emit a distinct
  // "gated by paths:" hint. Disabled conditional skills are excluded — no point
  // hinting at a skill the user explicitly hid.
  const pendingConditionalSkillNames = new Set(
    allSkills
      .filter(
        (s) =>
          !s.disableModelInvocation &&
          s.paths &&
          s.paths.length > 0 &&
          !skillManager.isSkillActive(s) &&
          !isDisabled(s.name),
      )
      .map((s) => s.name),
  );

  // Merge in model-invocable commands, excluding any whose name appears as a
  // model-invocable file-based skill (including pending conditional ones). Using
  // `availableSkills` here would let a path-gated skill leak through and bypass
  // the pendingConditionalSkillNames validation check. A skill marked
  // `disable-model-invocation` or user-disabled is intentionally hidden and must
  // not block an unrelated same-named command/MCP prompt, so it is excluded from
  // the dedup set.
  const provider = config.getModelInvocableCommandsProvider();
  const allCommands = provider ? provider() : [];
  const fileBasedSkillNames = new Set(
    allSkills
      .filter((s) => !s.disableModelInvocation && !isDisabled(s.name))
      .map((s) => s.name),
  );
  const modelInvocableCommands = allCommands.filter(
    (cmd) => !fileBasedSkillNames.has(cmd.name),
  );

  const entries: AvailableSkillEntry[] = [
    ...availableSkills.map((s) => ({
      name: s.name,
      description: s.description,
      whenToUse: s.whenToUse,
      level: s.level,
    })),
    ...modelInvocableCommands.map((c) => ({
      name: c.name,
      description: c.description,
    })),
  ];

  return {
    availableSkills,
    pendingConditionalSkillNames,
    modelInvocableCommands,
    entries,
  };
}

// File-based skills (with a `level`) first, then commands; each alphabetical by
// name. A deterministic order keeps the rendered block byte-stable across
// session-boundary rebuilds (resume / compaction) so it doesn't needlessly bust
// the prompt cache.
function compareSkillEntries(
  a: AvailableSkillEntry,
  b: AvailableSkillEntry,
): number {
  const aGroup = a.level !== undefined ? 0 : 1;
  const bGroup = b.level !== undefined ? 0 : 1;
  if (aGroup !== bGroup) return aGroup - bGroup;
  return a.name.localeCompare(b.name);
}

/**
 * Renders normalized skill entries into the `<available_skills>` body. Pure: no
 * I/O, no config — XML-escapes every untrusted field (extension/command names
 * bypass `validateSkillName`, so a crafted name could otherwise inject raw tags)
 * and emits a stable order. Returns '' when there are no entries; callers decide
 * the empty-state messaging.
 */
export function renderAvailableSkillsBlock(
  entries: AvailableSkillEntry[],
): string {
  return [...entries]
    .sort(compareSkillEntries)
    .map((entry) => {
      if (entry.level !== undefined) {
        const descText = `${escapeXml(entry.description)}${
          entry.whenToUse ? ` — ${escapeXml(entry.whenToUse)}` : ''
        } (${entry.level})`;
        return `<skill>
<name>
${escapeXml(entry.name)}
</name>
<description>
${descText}
</description>
<location>
${entry.level}
</location>
</skill>`;
      }
      return `<skill>
<name>
${escapeXml(entry.name)}
</name>
<description>
${escapeXml(entry.description)}
</description>
</skill>`;
    })
    .join('\n');
}

/**
 * Grants a skill's `allowedTools` as session-scoped permission allow rules.
 *
 * Each entry is a permission rule string in the same syntax as `settings.json`
 * `permissions.allow` (e.g. `Bash(git *)`, `Edit`, `mcp__server__tool`) and is
 * handed verbatim to the session allow list, so matching tool calls are
 * auto-approved for the rest of the session instead of prompting. This is an
 * additive grant only — it never hides or restricts the tools the model sees.
 *
 * No-ops when there is no permission manager or nothing to grant.
 */
export function applySkillAllowedTools(
  permissionManager: PermissionManager | null | undefined,
  allowedTools: string[] | undefined,
): void {
  if (!permissionManager || !allowedTools?.length) {
    return;
  }
  for (const rule of allowedTools) {
    permissionManager.addSessionAllowRule(rule);
  }
}
