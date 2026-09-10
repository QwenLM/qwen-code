/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import type { PermissionManager } from '../permissions/permission-manager.js';
import type { Config } from '../config/config.js';
import type { SkillManager } from '../skills/skill-manager.js';
import type { SkillConfig, SkillLevel } from '../skills/types.js';
import type { ToolRegistry } from './tool-registry.js';
import { registerSkillHooks } from '../hooks/registerSkillHooks.js';
import { ToolNames } from './tool-names.js';
import { escapeXml } from '../utils/xml.js';
import { createDebugLogger } from '../utils/debugLogger.js';

const debugLogger = createDebugLogger('SKILL');

/**
 * The first bytes of every injected skill body. Exported so a recorded tool
 * response can be told apart from the other strings the Skill tool records —
 * its dedup message and its refusals — without inventing a second contract.
 */
export const SKILL_LLM_CONTENT_PREFIX = 'Base directory for this skill: ';

/**
 * Why the model cannot invoke a skill right now, or `undefined` when it can.
 *
 * The single source of truth for the model-facing availability rule. It is
 * asked twice, for two different jobs: `collectAvailableSkillEntriesUncached`
 * decides what to put in front of the model, and `SkillTool`'s resume path
 * decides whether a skill carried by a replayed conversation may have its
 * `allowedTools` and `hooks:` re-armed. Those must agree — a resumed session
 * that grants what no tool call can ask for is a permission the user can
 * neither see nor account for — and before this they were two hand-rolled
 * copies of the same trio.
 *
 * A reason rather than a boolean, because the resume path has to say which
 * condition failed: its whole point is that a missing gate stops being
 * silent.
 *
 * The order is the one the resume path reports in, and only shows through
 * when more than one condition fails at once. It runs permanent conditions
 * before transient ones: `disable-model-invocation` is a frontmatter fact
 * that no session can satisfy, and `SkillManager` never even enters such a
 * skill into the activation registry, so `isSkillActive` stays false for it
 * forever. Reporting `inactive` first would send the operator to touch a
 * matching file to clear a condition that cannot clear, and hide the
 * permanent cause that actually explains the decline.
 *
 * Every condition is read live — off `Config` and `SkillManager` — rather
 * than off `SkillTool`'s `hiddenSkillNames` / `pendingConditionalSkillNames`
 * snapshots: those are committed by an async `refreshSkills()` that nothing
 * sequences against a resume, so reading them here would race the very state
 * this decides on.
 *
 * Not to be reused for `pendingConditionalSkillNames`: that set is
 * deliberately this trio *minus* `isSkillActive` — a skill excluded here for
 * being inactive is exactly what it exists to name.
 */
export function skillModelInvocationBlock(
  config: Config,
  skillManager: SkillManager,
  skill: SkillConfig,
): 'disabled' | 'inactive' | 'hidden' | undefined {
  if (!config.isSkillEnabled(skill)) return 'disabled';
  if (skill.disableModelInvocation) return 'hidden';
  if (!skillManager.isSkillActive(skill)) return 'inactive';
  return undefined;
}

/**
 * Builds the LLM-facing content string when a skill body is injected.
 * Shared between SkillToolInvocation (runtime) and /context (estimation)
 * so that token estimates stay in sync with actual usage.
 */
export function buildSkillLlmContent(baseDir: string, body: string): string {
  return `${SKILL_LLM_CONTENT_PREFIX}${baseDir}\nImportant: ALWAYS resolve absolute paths from this base directory when working with skills.\n\n${body}\n`;
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
  /** File-based skills hidden from model invocation. */
  hiddenSkillNames?: Set<string>;
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
  // Include a skill only when the model could invoke it right now — see
  // `skillModelInvocationBlock` for the three conditions, which the resume
  // path reads from the same place. Keeps the listing small in large
  // monorepos where most conditional skills are not yet relevant.
  const allSkills = await skillManager.listSkills();
  const isEnabled = (skill: SkillConfig) => config.isSkillEnabled(skill);

  const availableSkills = allSkills.filter(
    (s) => skillModelInvocationBlock(config, skillManager, s) === undefined,
  );
  const hiddenSkillNames = new Set(
    allSkills.filter((s) => s.disableModelInvocation).map((s) => s.name),
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
          isEnabled(s),
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
      .filter((s) => !s.disableModelInvocation && isEnabled(s))
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
    hiddenSkillNames,
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
 * Whether a skill's side effects — `allowedTools` session allow rules and
 * frontmatter hooks — may be applied. A project skill is discovered from
 * `<repo>/.qwen/skills/` regardless of folder trust because its body only
 * influences the model, but its side effects grant tool approvals or run
 * repo-supplied commands, so they need a trusted folder: the same gate
 * `Config.getProjectHooks()` applies to settings-file hooks. User, extension
 * and bundled skills are not repo-controlled and are unaffected.
 */
export function canApplySkillSideEffects(
  skill: Pick<SkillConfig, 'level'>,
  config: Pick<Config, 'isTrustedFolder'>,
): boolean {
  return skill.level !== 'project' || config.isTrustedFolder();
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
 * Caveat under an active `settings.tools.eager` allowlist (#9827): the grant
 * flips the runtime permission predicate, but it can never promote a deferred
 * tool into the eager model request — the registry is built once in
 * `Config.initialize`, so such a tool stays deferred (still registered and
 * loadable via `tool_search`). An eager-by-default tool omitted by
 * `tools.eager` needs its name added plus a restart; a tool deferred by
 * default needs `tools.visible` instead. `permissions.allow` itself never
 * gates registration (#10075).
 *
 * No-ops when there is no permission manager or nothing to grant.
 *
 * `trustGated` marks the grants as repository-controlled: a project skill's
 * rules are honoured only while the folder is trusted, re-checked at every
 * permission decision. Whether that re-check can change mid-session depends
 * on where trust comes from — see `applySkillHooks`, which is gated the same
 * way. Pass `skill.level === 'project'`.
 *
 * `sessionId` scopes the grants to the session that loaded the skill, the
 * same scope the skill's hooks already get. `PermissionManager` is built once
 * per process and outlives a session swap, so without it a grant made in one
 * session would keep auto-approving in the next one — which has no skill
 * loaded, no body in context and no trace of where the approval came from.
 */
export function applySkillAllowedTools(
  permissionManager: PermissionManager | null | undefined,
  allowedTools: string[] | undefined,
  options?: { trustGated?: boolean; sessionId?: string },
): void {
  if (!permissionManager || !allowedTools?.length) {
    return;
  }
  for (const rule of allowedTools) {
    permissionManager.addSessionAllowRule(rule, {
      trustGated: options?.trustGated === true,
      sessionId: options?.sessionId,
    });
  }
}

/**
 * Registers a skill's frontmatter `hooks:` as session-scoped hooks.
 *
 * Mirrors `applySkillAllowedTools`: the caller is responsible for the
 * folder-trust gate (`canApplySkillSideEffects`), and the registration itself
 * is idempotent — `registerSkillHooks` dedups entries this skill already
 * added, so re-invoking a skill never stacks duplicate hooks.
 *
 * A project skill's hooks are marked trust-gated by `registerSkillHooks`, so
 * the event handler re-reads folder trust at fire time. `isTrustedFolder()`
 * reads the IDE context store first and only falls back to the `Config`'s
 * own readonly field, so with an IDE companion connected that value is live
 * and revoking trust silences an already-registered gate at the next event,
 * without a restart. With no IDE connection it is fixed for the life of the
 * `Config`, and a change made through the CLI's trust dialog takes effect on
 * restart. Granting trust never retro-registers either way — the skill has
 * to be invoked again, which is safe because registration dedups.
 *
 * No-ops when the session has no hook system or no session id.
 */
export function applySkillHooks(
  config: Pick<Config, 'getHookSystem' | 'getSessionId'>,
  skill: SkillConfig,
): void {
  // `{}` is truthy, and `parseSkillContent` assigns an empty object for an
  // explicit `hooks: {}` as well as for a block whose event names are all
  // unknown (a typo'd `PreTooluse:` is parsed, warned about once, and
  // dropped). Such a skill declares no gate, so it must not reach the warn
  // below.
  if (!skill.hooks || Object.keys(skill.hooks).length === 0) {
    return;
  }
  const hookSystem = config.getHookSystem();
  const sessionId = config.getSessionId();
  if (!hookSystem || !sessionId) {
    // Sessions that disable hooks (`disableAllHooks`, safe mode, bare mode,
    // the ACP agent's `skipHooks`) never build a hook system. The skill body
    // and its allowedTools still land, so without this line a skill whose
    // frontmatter promises an enforcement gate would go silently ungated.
    //
    // `warn`, not `debug`: control only reaches here for a skill that
    // actually declares at least one hook (the early return above rejects
    // both a missing and an empty `hooks:`), so this cannot become a
    // steady-state warning — it fires exactly when a promised gate is being
    // dropped.
    debugLogger.warn(
      `Skipping hook registration for skill "${skill.name}": no hook system or session id (hooks disabled?)`,
    );
    return;
  }
  const count = registerSkillHooks(
    hookSystem.getSessionHooksManager(),
    sessionId,
    skill,
  );
  if (count > 0) {
    debugLogger.info(`Registered ${count} hooks from skill "${skill.name}"`);
  } else {
    // Zero is the expected outcome of every re-invocation: the hooks are
    // already registered and `registerSkillHooks` dedups them.
    debugLogger.debug(
      `No new hooks registered from skill "${skill.name}" (already registered or none registrable)`,
    );
  }
}

/**
 * Applies every side effect a skill declares — `allowedTools` session allow
 * rules and frontmatter `hooks:` — behind the single folder-trust gate.
 *
 * Every path that loads a skill body must call this, whether the model invoked
 * the skill through the Skill tool or the user invoked it through its
 * `/<skill-name>` slash command. Applying only part of it is what let a skill's
 * `PreToolUse` gate silently fail open on the slash-command path (#11067): the
 * skill's instructions reached the model while the hook that was supposed to
 * enforce them was never registered.
 *
 * Both underlying registrations dedup, so calling this repeatedly for the same
 * skill is safe — and necessary, since folder trust can be granted mid-session.
 */
export function applySkillSideEffects(
  config:
    | (Pick<Config, 'getHookSystem' | 'getSessionId' | 'getPermissionManager'> &
        Pick<Config, 'isTrustedFolder'>)
    | null
    | undefined,
  skill: SkillConfig,
): void {
  if (!config) {
    return;
  }
  if (!canApplySkillSideEffects(skill, config)) {
    if (skill.allowedTools?.length || skill.hooks) {
      debugLogger.warn(
        `Skill "${skill.name}" is a project skill in an untrusted folder; ignoring its allowedTools and hooks.`,
      );
    }
    return;
  }
  applySkillAllowedTools(config.getPermissionManager(), skill.allowedTools, {
    trustGated: skill.level === 'project',
    sessionId: config.getSessionId(),
  });
  applySkillHooks(config, skill);
}

/**
 * Conservatively drop ALL loaded-skill tracking after a destructive
 * history rewrite (compaction, truncation, orphan stripping). The rewrite
 * may have removed a skill body; the dedup guard must not leave that
 * skill permanently unreloadable behind "already loaded in context".
 * Over-clearing is the safe direction: a still-resident body costs at
 * most one duplicate injection on the next invoke, while a stale entry
 * makes the body unrecoverable until session restart.
 *
 * Duck-typed (mirroring `clearCommand`'s existing `clearLoadedSkills`
 * call) so history-rewrite sites don't need a runtime import of the
 * SkillTool class.
 */
export function clearLoadedSkillTracking(
  toolRegistry: ToolRegistry | undefined,
  logTag: string,
): void {
  const tool = toolRegistry?.getTool(ToolNames.SKILL);
  if (tool && 'clearLoadedSkills' in tool) {
    (tool as { clearLoadedSkills(): void }).clearLoadedSkills();
    debugLogger.debug(
      `[SKILL_TRACKING] conservatively cleared loaded-skill tracking after ${logTag}`,
    );
  }
}
