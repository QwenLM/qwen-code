/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import type { PermissionManager } from '../permissions/permission-manager.js';
import type { Config } from '../config/config.js';
import type { SkillManager } from '../skills/skill-manager.js';
import type { SkillConfig, SkillLevel } from '../skills/types.js';
import type { MicrocompactMeta } from '../services/microcompaction/microcompact.js';
import type { ToolRegistry } from './tool-registry.js';
import { ToolNames } from './tool-names.js';
import { escapeXml } from '../utils/xml.js';
import { createDebugLogger } from '../utils/debugLogger.js';

const debugLogger = createDebugLogger('SKILL');

/** Prefix every injected skill body shares (see {@link buildSkillLlmContent}).
 * Used as a positive residency marker: a Skill tool-result whose output starts
 * with this is a real body; a dedup confirmation, SkillTool error text
 * (`Skill "x" not found.` / `is disabled.` / `Failed to load skill "x":`),
 * a `/unskill` placeholder, or a microcompact cleared message are NOT bodies
 * and so must not keep a skill tracked (or let `/unskill` claim a body exists). */
const SKILL_BODY_PREFIX = 'Base directory for this skill:';

/**
 * Builds the LLM-facing content string when a skill body is injected.
 * Shared between SkillToolInvocation (runtime) and /context (estimation)
 * so that token estimates stay in sync with actual usage.
 */
export function buildSkillLlmContent(baseDir: string, body: string): string {
  return `${SKILL_BODY_PREFIX} ${baseDir}\nImportant: ALWAYS resolve absolute paths from this base directory when working with skills.\n\n${body}\n`;
}

/** Whether a Skill tool-result output is an injected skill body (built by
 * {@link buildSkillLlmContent}). Proves residency: excludes dedup confirmations,
 * SkillTool error text, `/unskill` placeholders, and cleared messages. */
export function isSkillBodyOutput(output: unknown): boolean {
  return typeof output === 'string' && output.startsWith(SKILL_BODY_PREFIX);
}

const SKILL_UNLOADED_PLACEHOLDER_PREFIX = `[Skill '`;
const SKILL_UNLOADED_PLACEHOLDER_SUFFIX = `' unloaded via /unskill; invoke the Skill tool again to reload.]`;

/** Placeholder `/unskill` writes in place of a blanked skill body. */
export function skillUnloadedPlaceholder(skillName: string): string {
  return `${SKILL_UNLOADED_PLACEHOLDER_PREFIX}${skillName}${SKILL_UNLOADED_PLACEHOLDER_SUFFIX}`;
}

/**
 * Whether a tool-result output is a `/unskill` placeholder. Microcompaction
 * treats it like its own cleared message: it must not absorb a keepRecent
 * protection slot, nor be re-blanked (which would also emit a spurious
 * eviction report for the name).
 */
export function isSkillUnloadedPlaceholder(output: unknown): boolean {
  return (
    typeof output === 'string' &&
    output.startsWith(SKILL_UNLOADED_PLACEHOLDER_PREFIX) &&
    output.endsWith(SKILL_UNLOADED_PLACEHOLDER_SUFFIX)
  );
}

/**
 * Whether a tool-result output is the dedup guard's short confirmation
 * (`Skill "x" is already loaded in context.`, emitted by SkillTool) rather
 * than a full body. A kept confirmation must NOT suppress eviction
 * reporting for its skill — the body it refers to may already be gone;
 * only a kept full body proves residency.
 */
export function isSkillDedupConfirmation(output: unknown): boolean {
  return (
    typeof output === 'string' &&
    output.startsWith('Skill "') &&
    output.endsWith('" is already loaded in context.')
  );
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
 * Short-lived memo cache for `collectAvailableSkillEntries`. Keyed by
 * `SkillManager` instance so independent managers (e.g. in tests) don't
 * share results. Each entry stores the in-flight or resolved promise and a
 * monotonic timestamp; entries older than `COLLECT_CACHE_TTL_MS` are
 * discarded on the next call.
 */
interface CachedCollect {
  promise: Promise<CollectedAvailableSkills>;
  ts: number;
}

let collectCache = new WeakMap<SkillManager, CachedCollect>();

/** Cache lifetime in milliseconds. */
const COLLECT_CACHE_TTL_MS = 2_000;

/**
 * Evict any cached result for the given manager, or reset the entire cache
 * when called without an argument. Exported for tests and explicit
 * invalidation hooks.
 */
export function clearCollectedSkillEntriesCache(
  skillManager?: SkillManager,
): void {
  if (skillManager) {
    collectCache.delete(skillManager);
  } else {
    // Replace the WeakMap entirely to clear all entries.
    collectCache = new WeakMap();
  }
}

/**
 * Collects the model-facing skill set — active file-based skills + model-invocable
 * commands — applying the same filtering/dedup rules `SkillTool.refreshSkills`
 * used to apply inline. Stateful/async (reads `SkillManager` + `Config`). The
 * returned validation fields and the `entries` list are always consistent, so
 * the Skill tool, the startup snapshot, and activation reminders share identical
 * bytes from one source.
 *
 * Results are memoized for up to 2 s per `SkillManager` instance so that
 * near-simultaneous startup callers (SkillTool, drainSkillAndCommandReminders,
 * buildAvailableSkillsReminder, coreToolScheduler) share a single scan.
 */
export async function collectAvailableSkillEntries(
  skillManager: SkillManager,
  config: Config,
): Promise<CollectedAvailableSkills> {
  const cached = collectCache.get(skillManager);
  if (cached && Date.now() - cached.ts < COLLECT_CACHE_TTL_MS) {
    return cached.promise;
  }

  const promise = collectAvailableSkillEntriesUncached(skillManager, config);
  collectCache.set(skillManager, { promise, ts: Date.now() });

  // If the underlying scan fails, evict the cache so the next caller retries
  // instead of getting a cached rejection.
  promise.catch(() => {
    const entry = collectCache.get(skillManager);
    if (entry?.promise === promise) {
      collectCache.delete(skillManager);
    }
  });

  return promise;
}

/** Uncached implementation — see `collectAvailableSkillEntries` for the
 * memoized public API. */
async function collectAvailableSkillEntriesUncached(
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

/**
 * Duck-typed view of `SkillTool`'s loaded-skill tracking. Kept structural
 * (mirroring `clearCommand`'s existing duck-typed `clearLoadedSkills` call)
 * so history-eviction consumers don't need a runtime import of the tool
 * class.
 */
interface LoadedSkillTracker {
  unloadSkills(names: Iterable<string>): void;
  clearLoadedSkills(): void;
}

function getLoadedSkillTracker(
  toolRegistry: ToolRegistry | undefined,
): LoadedSkillTracker | undefined {
  const tool = toolRegistry?.getTool(ToolNames.SKILL);
  if (tool && 'unloadSkills' in tool && 'clearLoadedSkills' in tool) {
    return tool as unknown as LoadedSkillTracker;
  }
  return undefined;
}

/**
 * Sync loaded-skill tracking after a history eviction blanked Skill tool
 * results. Targeted un-track when every blanked skill was resolved; blanket
 * clear when any could not be resolved — over-clearing only costs a
 * duplicated body on the next invoke, while a stale entry leaves that skill
 * permanently unreloadable behind the dedup guard.
 *
 * Shared by pre-send microcompaction, /compress-fast, and the
 * memory-pressure `compact_history` step (mirrors
 * `disarmFileReadCacheAfterEviction` for the file-read cache).
 */
export function syncSkillEvictions(
  meta: Pick<MicrocompactMeta, 'evictedSkillNames' | 'unresolvedEvictedSkills'>,
  toolRegistry: ToolRegistry | undefined,
  logTag: string,
): void {
  if (
    meta.unresolvedEvictedSkills === 0 &&
    meta.evictedSkillNames.length === 0
  ) {
    return;
  }
  const tracker = getLoadedSkillTracker(toolRegistry);
  if (!tracker) {
    return;
  }
  if (meta.unresolvedEvictedSkills > 0) {
    tracker.clearLoadedSkills();
    debugLogger.debug(
      `[SKILL_TRACKING] cleared all loaded-skill tracking after ${logTag} ` +
        `(${meta.unresolvedEvictedSkills} unresolved blanked skill result(s))`,
    );
    return;
  }
  tracker.unloadSkills(meta.evictedSkillNames);
  debugLogger.debug(
    `[SKILL_TRACKING] un-tracked ${meta.evictedSkillNames.length} ` +
      `skill(s) after ${logTag}: ${meta.evictedSkillNames.join(', ')}`,
  );
}

/**
 * Blanket-clear loaded-skill tracking. Used by LLM compression
 * (`tryCompress`), where the summary may or may not retain any given skill
 * body and no per-skill eviction meta exists.
 */
export function clearLoadedSkillTracking(
  toolRegistry: ToolRegistry | undefined,
  logTag: string,
): void {
  const tracker = getLoadedSkillTracker(toolRegistry);
  if (!tracker) {
    return;
  }
  tracker.clearLoadedSkills();
  debugLogger.debug(
    `[SKILL_TRACKING] cleared loaded-skill tracking after ${logTag}`,
  );
}
