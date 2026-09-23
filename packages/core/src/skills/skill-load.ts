import {
  type SkillConfig,
  type SkillValidationResult,
  parseAllowedToolsField,
  parseModelField,
  parsePathsField,
  parseUserInvocableField,
  validateSkillName,
} from './types.js';
import { validateSymlinkTarget } from './symlinkScope.js';
import * as fs from 'fs/promises';
import * as path from 'path';
import { parse as parseYaml } from '../utils/yaml-parser.js';
import { createDebugLogger } from '../utils/debugLogger.js';
import { normalizeContent } from '../utils/textUtils.js';

const debugLogger = createDebugLogger('SKILL_LOAD');

const SKILL_MANIFEST_FILE = 'SKILL.md';

/**
 * Resource-exhaustion errnos that must never be swallowed by the per-entry
 * skips in the extension/skill/agent loaders. Every queued
 * `fs.promises.readFile` opens its descriptor as soon as the libuv pool
 * dequeues it, so under a low `RLIMIT_NOFILE` (long-running daemons holding
 * pipes/sockets, containers with a low LimitNOFILE, system-wide ENFILE) these
 * reads fail mid-scan. Treating them like parse failures would silently commit
 * a truncated extension set — and, because the cache fingerprint is captured
 * from pre-load disk state, that truncation would stick until restart. They
 * must instead fail the whole refresh closed so a later refresh retries.
 */
const RESOURCE_EXHAUSTION_CODES = new Set([
  'EMFILE',
  'ENFILE',
  'EAGAIN',
  'ENOMEM',
]);

/**
 * Rethrow when `error` is resource exhaustion (see RESOURCE_EXHAUSTION_CODES);
 * everything else — parse/validation failures, ENOENT-class skips — is the
 * caller's business and stays swallowed.
 */
export function isResourceExhaustion(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException | undefined)?.code;
  return typeof code === 'string' && RESOURCE_EXHAUSTION_CODES.has(code);
}

/**
 * Upper bound on the number of per-entry manifest reads in flight at once,
 * shared by the gated loaders (extension skills, extension agents and plugin
 * skills — the three `mapWithConcurrency` callers). Loading nests
 * (extensions fan out to per-extension skill/agent scans, which fan out to
 * per-file reads), so a per-level cap cannot express a shared budget.
 *
 * The gate bounds admissions to those manifest callbacks, not every open
 * descriptor in the process: the commands `readdir` enumeration
 * (`loadCommandsFromDir` in extensionManager.ts), the extensions-root
 * readdir, the per-extension sync config/hooks reads, `loadExtensionWorkflows`
 * and the managed `SkillManager.loadSkillsFromDir` (skill-manager.ts, an
 * unbounded `Promise.all` this module does not cover) all sit outside it.
 *
 * 8 measured no wall-clock loss versus 64 (the default 4-thread libuv pool
 * is the real bottleneck either way) while keeping peak descriptors far
 * below even a container's low LimitNOFILE — see the EMFILE rethrow below
 * for why headroom here matters.
 */
export const SKILL_LOAD_CONCURRENCY = 8;

/**
 * How many extensions the top-level directory scan allows into their
 * per-extension phase simultaneously. The per-extension work itself draws
 * from the shared semaphore, so this only bounds scheduling fan-out, not
 * descriptors; keeping it modest avoids queueing tens of thousands of
 * closures at once.
 */
export const EXTENSION_SCAN_CONCURRENCY = 8;

/**
 * Module-wide semaphore shared by the gated manifest readers (extension
 * skills, extension agents and plugin skills — the `mapWithConcurrency`
 * callers), so their in-flight read budget is shared, not per-loader.
 * Intentionally tiny; avoids pulling in a dependency for what is ~30 lines.
 */
class CountdownGate {
  private readonly queue: Array<() => void> = [];
  private active = 0;
  private peakActive = 0;

  constructor(private readonly limit: number) {}

  async acquire(): Promise<void> {
    if (this.active < this.limit) {
      this.active += 1;
      this.peakActive = Math.max(this.peakActive, this.active);
      return;
    }
    await new Promise<void>((resolve) => {
      this.queue.push(() => {
        this.active += 1;
        this.peakActive = Math.max(this.peakActive, this.active);
        resolve();
      });
    });
  }

  release(): void {
    this.active -= 1;
    const next = this.queue.shift();
    if (next) next();
  }

  /** Peak simultaneous holders since process start; exported for tests. */
  peak(): number {
    return this.peakActive;
  }
}

const descriptorGate = new CountdownGate(SKILL_LOAD_CONCURRENCY);

/**
 * Test-only observation: the peak number of simultaneous manifest-read
 * admissions since process start. Lets a test pin the global descriptor
 * ceiling without mocking `fs.promises`.
 */
export function peakDescriptorGateInFlight(): number {
  return descriptorGate.peak();
}

/**
 * Order-preserving map whose per-item work is admitted through the shared
 * descriptor gate. Every gated item must complete (or fail) while holding its
 * permit without making further gated acquisitions: a level that holds a
 * permit across nested gated work stacks orphans when a sibling fails and can
 * deadlock the module-wide pool — schedule such levels with
 * `scheduleWithConcurrency` instead (the loaders below do exactly that). The
 * batch always settles before rejecting (allSettled, then rethrow the first
 * original rejection reason) so a failing item never abandons siblings
 * mid-flight. The rethrow carries the original error object because the
 * loader entrances classify resource exhaustion by `error.code` (see
 * `isResourceExhaustion`), not by message. The `limit` parameter only bounds
 * batch scheduling, not descriptors.
 */
export async function mapWithConcurrency<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  if (items.length === 0) return [];
  const effective = Math.max(1, limit);
  const results: R[] = new Array(items.length);
  for (let i = 0; i < items.length; i += effective) {
    const slice = items.slice(i, i + effective);
    const settled = await Promise.allSettled(
      slice.map(async (item, j) => {
        await descriptorGate.acquire();
        try {
          results[i + j] = await fn(item);
        } finally {
          descriptorGate.release();
        }
      }),
    );
    const firstRejection = settled.find(
      (result): result is PromiseRejectedResult => result.status === 'rejected',
    );
    if (firstRejection) {
      // Preserve the original error object: the refresh boundary surfaces it
      // verbatim to fail-closed consumers, and the per-entry errno
      // classification above keys off `error.code`.
      throw firstRejection.reason;
    }
  }
  return results;
}

/**
 * Scheduling-only variant for fan-out levels that open no descriptors
 * themselves (e.g. the top-level extensions scan, which merely starts the
 * per-extension loaders). Items here must NOT hold gate permits while their
 * nested gated work runs: a level that holds a permit across nested gated
 * acquisitions stacks orphans when a sibling fails, draining the shared pool
 * one failed scan at a time. Per-item rejections do not abort the remaining
 * items in flight — the whole pass settles, then the first original rejection
 * reason is rethrown (same contract as `mapWithConcurrency`).
 */
export async function scheduleWithConcurrency<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  if (items.length === 0) return [];
  const effective = Math.max(1, limit);
  const results: R[] = new Array(items.length);
  for (let i = 0; i < items.length; i += effective) {
    const slice = items.slice(i, i + effective);
    const settled = await Promise.allSettled(
      slice.map(async (item, j) => {
        results[i + j] = await fn(item);
      }),
    );
    const firstRejection = settled.find(
      (result): result is PromiseRejectedResult => result.status === 'rejected',
    );
    if (firstRejection) {
      throw firstRejection.reason;
    }
  }
  return results;
}

export async function loadSkillsFromDir(
  baseDir: string,
): Promise<SkillConfig[]> {
  debugLogger.debug(`Loading skills from directory (skill-load): ${baseDir}`);
  try {
    const entries = await fs.readdir(baseDir, { withFileTypes: true });
    debugLogger.debug(`Found ${entries.length} entries in ${baseDir}`);

    const loaded = await mapWithConcurrency(
      entries,
      SKILL_LOAD_CONCURRENCY,
      async (entry): Promise<SkillConfig | null> => {
        // Skip transient install artifacts (backup / staging dirs left behind
        // by a crashed reinstall). Without this filter a stale `.backup-*`
        // sibling with a valid SKILL.md would be loaded as a duplicate skill,
        // and a "deleted" skill could reappear from its backup sibling.
        // Match only the actual artifact shape (`.backup-<pid>-<timestamp>` /
        // `.installing-<pid>-<timestamp>`, anchored at the end of the entry
        // name) so that legitimate skill dirs whose names merely contain
        // `.backup-` or `.installing-` (e.g. `db.backup-2024`) are not skipped.
        if (
          /\.backup-\d+-\d+$/.test(entry.name) ||
          /\.installing-\d+-\d+$/.test(entry.name)
        ) {
          debugLogger.debug(`Skipping install artifact entry: ${entry.name}`);
          return null;
        }

        // Process directories and symlinks that resolve to directories.
        // Plain files are silently skipped (each skill must be a directory).
        const isDirectory = entry.isDirectory();
        const isSymlink = entry.isSymbolicLink();

        if (!isDirectory && !isSymlink) {
          debugLogger.warn(`Skipping non-directory entry: ${entry.name}`);
          return null;
        }

        const skillDir = path.join(baseDir, entry.name);

        // For symlinks, verify the target (a) resolves and (b) is a
        // directory. Shared with `skill-manager.ts` so the two parsers
        // stay in sync. Targets pointing outside `baseDir` are allowed
        // — see `symlinkScope.ts` for the rationale.
        if (isSymlink) {
          const check = await validateSymlinkTarget(skillDir);
          if (!check.ok) {
            if (check.reason === 'not-directory') {
              debugLogger.warn(
                `Skipping symlink ${entry.name} that does not point to a directory`,
              );
            } else {
              debugLogger.warn(
                `Skipping invalid symlink ${entry.name}: ${check.error instanceof Error ? check.error.message : 'Unknown error'}`,
              );
            }
            return null;
          }
        }
        const skillManifest = path.join(skillDir, SKILL_MANIFEST_FILE);

        try {
          // Check if SKILL.md exists
          await fs.access(skillManifest);

          const content = await fs.readFile(skillManifest, 'utf8');
          return parseSkillContent(content, skillManifest);
        } catch (error) {
          if (isResourceExhaustion(error)) {
            // Fail the whole refresh closed so a later refresh retries,
            // instead of committing a truncated set as a successful load.
            throw error;
          }
          const errorMessage =
            error instanceof Error ? error.message : 'Unknown error';
          debugLogger.error(
            `Failed to parse skill at ${skillDir}: ${errorMessage}`,
          );
          return null;
        }
      },
    );

    return loaded.filter((skill) => skill != null);
  } catch (error) {
    // Resource exhaustion at the directory level (e.g. readdir EMFILE) fails
    // the whole refresh; a missing or unreadable directory stays an empty set.
    if (isResourceExhaustion(error)) {
      throw error;
    }
    // Directory doesn't exist or can't be read
    const errorMessage =
      error instanceof Error ? error.message : 'Unknown error';
    debugLogger.debug(
      `Cannot read skills directory ${baseDir}: ${errorMessage}`,
    );
    return [];
  }
}

export function parseSkillContent(
  content: string,
  filePath: string,
): SkillConfig {
  debugLogger.debug(`Parsing skill content from: ${filePath}`);

  // Normalize content to handle BOM and CRLF line endings
  const normalizedContent = normalizeContent(content);

  // Split frontmatter and content
  // Use (?:\n|$) to allow frontmatter ending with or without trailing newline
  const frontmatterRegex = /^---\n([\s\S]*?)\n---(?:\n|$)([\s\S]*)$/;
  const match = normalizedContent.match(frontmatterRegex);

  if (!match) {
    throw new Error('Invalid format: missing YAML frontmatter');
  }

  const [, frontmatterYaml, body] = match;

  // Parse YAML frontmatter
  const frontmatter = parseYaml(frontmatterYaml) as Record<string, unknown>;

  // Extract required fields
  const nameRaw = frontmatter['name'];
  const descriptionRaw = frontmatter['description'];

  if (nameRaw == null || nameRaw === '') {
    throw new Error('Missing "name" in frontmatter');
  }

  if (descriptionRaw == null || descriptionRaw === '') {
    throw new Error('Missing "description" in frontmatter');
  }

  // Convert to strings
  const name = String(nameRaw);
  // Reject unsafe names early — the value flows into the SkillTool
  // description, schema enums, and the path-activation
  // <system-reminder>, all of which the model treats as trusted text.
  validateSkillName(name);
  const description = String(descriptionRaw);

  // Extract optional fields
  const allowedTools = parseAllowedToolsField(frontmatter);

  // Extract optional model field
  const model = parseModelField(frontmatter);
  const argumentHint =
    typeof frontmatter['argument-hint'] === 'string'
      ? frontmatter['argument-hint']
      : undefined;

  // `whenToUse` and `disable-model-invocation` were historically only
  // parsed by the project/user/bundled parser in skill-manager.ts, which
  // meant an extension SKILL.md with `disable-model-invocation: true`
  // had the flag silently stripped — and (post-paths PR) would still
  // fire path-activation reminders for a skill the model can't invoke.
  // Extract them here too so the extension and managed parsers agree.
  const whenToUse =
    typeof frontmatter['when_to_use'] === 'string'
      ? frontmatter['when_to_use']
      : undefined;
  const disableModelInvocationRaw = frontmatter['disable-model-invocation'];
  const disableModelInvocation =
    disableModelInvocationRaw === true || disableModelInvocationRaw === 'true'
      ? true
      : undefined;
  const userInvocable = parseUserInvocableField(frontmatter);

  // Optional `paths` frontmatter: glob patterns that gate when this skill
  // is offered to the model (conditional skill).
  const paths = parsePathsField(frontmatter);
  const priority = parsePriorityField(frontmatter, filePath);

  const config: SkillConfig = {
    name,
    description,
    allowedTools,
    argumentHint,
    model,
    filePath,
    // Set skillRoot to the directory containing SKILL.md so command
    // hooks for extension skills get `QWEN_SKILL_ROOT` set in their
    // environment (registerSkillHooks.ts:116 skips the env var when
    // skillRoot is undefined). Matches the project/user/bundled
    // parser in skill-manager.ts. The previous omission silently
    // broke `$QWEN_SKILL_ROOT/scripts/...` references in extension
    // skill hook commands.
    //
    // Note: extension parser still does not extract `hooks:`
    // frontmatter; that's a separate alignment task and may be
    // intentionally restricted to managed (project/user/bundled)
    // skills as a security boundary. If hooks become supported here
    // they need their own extraction pass and the same managed-vs-
    // extension trust review.
    skillRoot: path.dirname(filePath),
    body: body.trim(),
    level: 'extension',
    whenToUse,
    disableModelInvocation,
    userInvocable,
    paths,
    priority,
  };

  // Validate the parsed configuration
  const validation = validateConfig(config);
  if (!validation.isValid) {
    throw new Error(`Validation failed: ${validation.errors.join(', ')}`);
  }

  debugLogger.debug(`Successfully parsed skill: ${name} from ${filePath}`);
  return config;
}

export function validateConfig(
  config: Partial<SkillConfig>,
): SkillValidationResult {
  const errors: string[] = [];
  const warnings: string[] = [];

  // Check required fields
  if (typeof config.name !== 'string') {
    errors.push('Missing or invalid "name" field');
  } else if (config.name.trim() === '') {
    errors.push('"name" cannot be empty');
  }

  if (typeof config.description !== 'string') {
    errors.push('Missing or invalid "description" field');
  } else if (config.description.trim() === '') {
    errors.push('"description" cannot be empty');
  }

  // Validate allowedTools if present
  if (config.allowedTools !== undefined) {
    if (!Array.isArray(config.allowedTools)) {
      errors.push('"allowedTools" must be an array');
    } else {
      for (const tool of config.allowedTools) {
        if (typeof tool !== 'string') {
          errors.push('"allowedTools" must contain only strings');
          break;
        }
      }
    }
  }

  if (
    config.priority !== undefined &&
    (typeof config.priority !== 'number' || !Number.isFinite(config.priority))
  ) {
    errors.push('"priority" must be a finite number');
  }

  // Warn if body is empty
  if (!config.body || config.body.trim() === '') {
    warnings.push('Skill body is empty');
  }

  return {
    isValid: errors.length === 0,
    errors,
    warnings,
  };
}

/**
 * Parse the optional `priority` frontmatter field for a skill.
 *
 * NOTE for adding new optional frontmatter fields: the SKILL.md parsing
 * logic exists in **two** places — `parseSkillContent` here (used for
 * extension skills) and `SkillManager.parseSkillContent` in
 * `skill-manager.ts` (used for project / user / bundled skills). Any new
 * field must be wired into both, or extension SKILL.md authors will see
 * the field silently dropped — the same regression that previously hit
 * `whenToUse`, `disable-model-invocation`, `paths`, and `priority`. Prefer
 * extracting the field's parsing into a shared helper (like this one)
 * rather than inlining `frontmatter['key']` twice.
 *
 * Strict typecheck: `priority` must be a finite JS number. The custom
 * YAML parser returns `true`/`false` as JS booleans and `null` as `null`,
 * all of which `Number()` would silently coerce to 1/0/0. Anything that
 * isn't already `typeof === 'number'` is rejected before checking
 * finiteness. Empty string is treated as omission for ergonomics
 * (matches `paths:` lenient handling).
 *
 * Returns `undefined` (and warns) for invalid values rather than
 * throwing — `priority` is a cosmetic ordering hint, not a load-blocking
 * field, so a typo in this single key shouldn't make a previously-working
 * skill silently disappear from the listing.
 */
export function parsePriorityField(
  frontmatter: Record<string, unknown>,
  filePath: string,
  // Optional logger so the caller's namespace tags the warning. Without
  // this, a warning for a project/user/bundled SKILL.md emitted from
  // SkillManager.parseSkillContent would be tagged `[SKILL_LOAD]` —
  // misleading for log filtering. Defaults to skill-load's own logger
  // for the original (extension) call site.
  warn: (message: string) => void = (message) => debugLogger.warn(message),
): number | undefined {
  const raw = frontmatter['priority'];
  if (raw === undefined || raw === null || raw === '') {
    return undefined;
  }

  if (typeof raw !== 'number' || !Number.isFinite(raw)) {
    warn(
      `Ignoring invalid priority value in ${filePath}: expected a finite number.`,
    );
    return undefined;
  }

  return raw;
}

/**
 * Normalize a skill priority to a finite number for sort comparisons.
 * Used in the `listSkills()` sort comparator so extension-provided skills
 * (which bypass the frontmatter parser and validateConfig) can't poison
 * ordering with `NaN` or non-number values that `(a ?? 0) - (b ?? 0)`
 * would otherwise propagate as `NaN`.
 */
export function normalizeSkillPriority(priority: unknown): number {
  return typeof priority === 'number' && Number.isFinite(priority)
    ? priority
    : 0;
}
