/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import type { PermissionManager } from '../permissions/permission-manager.js';
import type { Config } from '../config/config.js';
import type { SkillManager } from '../skills/skill-manager.js';
import type { SkillConfig, SkillLevel } from '../skills/types.js';
import type { Content } from '@google/genai';
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

/** Second static line every {@link buildSkillLlmContent} output carries;
 * checked together with the prefix so arbitrary command-executor-fallback
 * text that merely starts with the prefix cannot spoof residency. */
const SKILL_BODY_STATIC_LINE =
  'Important: ALWAYS resolve absolute paths from this base directory when working with skills.';

/**
 * Builds the LLM-facing content string when a skill body is injected.
 * Shared between SkillToolInvocation (runtime) and /context (estimation)
 * so that token estimates stay in sync with actual usage.
 */
export function buildSkillLlmContent(baseDir: string, body: string): string {
  return `${SKILL_BODY_PREFIX} ${baseDir}\n${SKILL_BODY_STATIC_LINE}\n\n${body}\n`;
}

/** Whether a Skill tool-result output is an injected skill body (built by
 * {@link buildSkillLlmContent}). Proves residency: excludes dedup confirmations,
 * SkillTool error text, and cleared messages. */
export function isSkillBodyOutput(output: unknown): boolean {
  return (
    typeof output === 'string' &&
    output.startsWith(SKILL_BODY_PREFIX) &&
    output.includes(SKILL_BODY_STATIC_LINE)
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
  trackSkills(names: Iterable<string>): void;
}

function getLoadedSkillTracker(
  toolRegistry: ToolRegistry | undefined,
): LoadedSkillTracker | undefined {
  const tool = toolRegistry?.getTool(ToolNames.SKILL);
  if (
    tool &&
    'unloadSkills' in tool &&
    'clearLoadedSkills' in tool &&
    'trackSkills' in tool
  ) {
    return tool as unknown as LoadedSkillTracker;
  }
  return undefined;
}

/**
 * The exact outputs SkillTool produced via {@link buildSkillLlmContent}
 * this process — authoritative residency provenance, recorded at load
 * time. Command-delegation outputs (disabled-skill fallback, same-named
 * MCP prompt / file command) flow through the same
 * `functionResponse{name:'skill'}` shape carrying arbitrary third-party
 * text; because both text markers below are public constants, such an
 * output can copy them and spoof a body. Membership in this set is the
 * only proof a marker-matching output is a REAL body.
 *
 * Returns `undefined` when no tracker exists (legacy / untracked
 * contexts): callers keep the marker-only check. Returns an EMPTY set in
 * a fresh process (nothing loaded yet — e.g. right after resume): the
 * markers are untrusted there too, and failing closed is safe because the
 * tracker itself starts empty, so nothing can deadlock and the only cost
 * is a bounded duplicate body on the next invoke.
 */
export function getGenuineSkillBodyOutputs(
  toolRegistry: ToolRegistry | undefined,
): ReadonlySet<string> | undefined {
  const tool = toolRegistry?.getTool(ToolNames.SKILL);
  if (tool && 'getGenuineSkillBodyOutputs' in tool) {
    return (
      tool as { getGenuineSkillBodyOutputs(): ReadonlySet<string> }
    ).getGenuineSkillBodyOutputs();
  }
  return undefined;
}

/** Residency predicate: marker-shaped AND (when provenance is available)
 * recorded by SkillTool at load time. */
export function isProvenSkillBody(
  output: unknown,
  genuineOutputs: ReadonlySet<string> | undefined,
): boolean {
  return (
    isSkillBodyOutput(output) &&
    (genuineOutputs === undefined || genuineOutputs.has(output as string))
  );
}

/**
 * Build a `callId → skill name[]` map for every Skill tool call: the name
 * lives on the request-side `functionCall.args.skill`, not on the
 * (possibly blanked) `functionResponse`, so this is the only way to
 * recover which skill a cleared body belonged to. Calls missing an id or
 * skill name are absent (callers treat that as unresolvable —
 * over-clearing only costs a duplicated body on re-invoke, while keeping
 * a stale entry leaves the skill unrecoverable behind the dedup guard).
 * Duplicate names for one id (a provider reusing call ids) are deduped
 * here so every consumer agrees on what counts as ambiguous.
 *
 * Lives here (not in microcompact.ts) so skill-utils does not
 * value-import from a module that value-imports skill-utils.
 */
export function buildCallIdToSkillName(
  history: Content[],
): Map<string, string[]> {
  const map = new Map<string, string[]>();
  for (const content of history) {
    if (content.role !== 'model' || !content.parts) continue;
    for (const part of content.parts) {
      const call = part.functionCall;
      if (!call?.id || call.name !== ToolNames.SKILL) {
        continue;
      }
      const skillName = (call.args as { skill?: unknown } | undefined)?.skill;
      if (typeof skillName === 'string' && skillName.length > 0) {
        const existing = map.get(call.id);
        if (existing) {
          if (!existing.includes(skillName)) existing.push(skillName);
        } else {
          map.set(call.id, [skillName]);
        }
      }
    }
  }
  return map;
}

/**
 * Resolve the skill names of the skill-body functionResponses in
 * `entries` by pairing their call ids against the model-role
 * functionCalls in `history`. Ambiguous or unresolvable ids are
 * omitted (callers treat them as "not provable").
 */
export function resolveLoadedSkillNames(
  entries: Content[],
  history: Content[],
  genuineOutputs?: ReadonlySet<string> | undefined,
): string[] {
  const callIdToSkillName = buildCallIdToSkillName(history);
  const names = new Set<string>();
  for (const entry of entries) {
    for (const part of entry.parts ?? []) {
      const fr = part.functionResponse;
      if (
        fr?.id &&
        fr.name === ToolNames.SKILL &&
        isProvenSkillBody(fr.response?.['output'], genuineOutputs)
      ) {
        const resolved = callIdToSkillName.get(fr.id);
        if (resolved?.length === 1) {
          names.add(resolved[0]!);
        }
      }
    }
  }
  return [...names];
}

/**
 * Rebuild loaded-skill tracking to exactly match history: clear it, then
 * re-track the skills whose bodies are resident in `history`. Used after
 * rewrites where residency is KNOWABLE — truncation (the kept prefix),
 * the hard-rescue verbatim restore, and the retry restore of stripped
 * entries — where the blanket-clear uncertainty rationale does not apply.
 * (The retry restore reconciles via `restoreStrippedRetryEntries` in
 * client.ts; the ACP continuation settle reconciles via the chat-level
 * wrapper.)
 */
export function reconcileLoadedSkillTracking(
  history: Content[],
  toolRegistry: ToolRegistry | undefined,
  logTag: string,
): void {
  const tracker = getLoadedSkillTracker(toolRegistry);
  if (!tracker) {
    return;
  }
  const names = resolveLoadedSkillNames(
    history,
    history,
    getGenuineSkillBodyOutputs(toolRegistry),
  );
  tracker.clearLoadedSkills();
  if (names.length > 0) {
    tracker.trackSkills(names);
  }
  debugLogger.debug(
    `[SKILL_TRACKING] reconciled loaded-skill tracking after ${logTag} ` +
      `(${names.length} resident skill(s))`,
  );
}

/**
 * Un-track only the skills whose bodies `entries` dropped from history —
 * unlike a blanket clear, resident bodies elsewhere keep their tracking.
 * A skill with ANOTHER resident body keeps its tracking too: un-tracking
 * it would disarm the dedup guard while a body is still resident, letting
 * a duplicate body through on the next invoke. If ANY stripped body's call
 * id cannot be resolved to a name — including when other bodies in the
 * same batch DO resolve — tracking is cleared wholesale instead:
 * over-clearing only costs one duplicated body on the next invoke, while
 * leaving the stripped body's skill tracked makes it unreloadable behind
 * the dedup guard. Marker-matching outputs SkillTool never produced
 * (spoofed command results) count as neither dropped nor unresolvable.
 */
export function unloadSkillsFromEntries(
  entries: Content[],
  history: Content[],
  toolRegistry: ToolRegistry | undefined,
  logTag: string,
): void {
  const genuineOutputs = getGenuineSkillBodyOutputs(toolRegistry);
  const callIdToSkillName = buildCallIdToSkillName(history);
  const dropped = new Set<string>();
  let hasUnresolvableBody = false;
  for (const entry of entries) {
    for (const part of entry.parts ?? []) {
      const fr = part.functionResponse;
      if (
        fr?.name !== ToolNames.SKILL ||
        !isProvenSkillBody(fr.response?.['output'], genuineOutputs)
      ) {
        continue;
      }
      const resolved = fr.id ? callIdToSkillName.get(fr.id) : undefined;
      if (resolved?.length === 1) {
        dropped.add(resolved[0]!);
      } else {
        hasUnresolvableBody = true;
      }
    }
  }
  if (hasUnresolvableBody) {
    // An unresolvable body still counts as a dropped body: its skill must
    // not stay tracked with no resident body (the deadlock direction).
    const tracker = getLoadedSkillTracker(toolRegistry);
    tracker?.clearLoadedSkills();
    debugLogger.debug(
      `[SKILL_TRACKING] blanket-cleared loaded-skill tracking after ` +
        `${logTag} (stripped body with unresolvable call id)`,
    );
    return;
  }
  if (dropped.size === 0) {
    return;
  }
  const resident = new Set(
    resolveLoadedSkillNames(history, history, genuineOutputs),
  );
  const names = [...dropped].filter((name) => !resident.has(name));
  if (names.length === 0) {
    return;
  }
  const tracker = getLoadedSkillTracker(toolRegistry);
  if (!tracker) {
    return;
  }
  tracker.unloadSkills(names);
  debugLogger.debug(
    `[SKILL_TRACKING] un-tracked ${names.length} skill(s) after ${logTag}: ` +
      names.join(', '),
  );
}
