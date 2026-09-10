/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * @fileoverview Reaching the bundled `workflow-authoring` reference from
 * outside the Skill tool.
 *
 * The authoring reference is a bundled skill rather than tool-description
 * prose because only the turn that actually writes a script needs it, while a
 * tool description is paid for on every turn. That trade only works if two
 * other things hold, and this module is what makes them hold:
 *
 * 1. A build where the model cannot reach the Skill tool (denied by
 *    permissions, or a `coreTools` allowlist that omits it) must still get the
 *    reference — so the Workflow tool inlines it into its description instead.
 *    {@link isWorkflowAuthoringSkillAvailable} decides which of the two.
 * 2. The `workflow` keyword already steers a turn toward orchestration, and
 *    that is exactly the turn the reference is for. Injecting it there saves a
 *    round trip — but only if it is injected in the SAME form the Skill tool
 *    would produce and registered as loaded, or the model would pay for it
 *    twice and `/context` would under-count it.
 */

import { readFileSync } from 'node:fs';
import * as path from 'node:path';
import type { Config } from '../config/config.js';
import { ToolNames } from '../tools/tool-names.js';
import { buildSkillLlmContent } from '../tools/skill-utils.js';
import { parseSkillContent } from './skill-load.js';
import { resolveBundleDir } from '../utils/bundlePaths.js';
import { createDebugLogger } from '../utils/debugLogger.js';

const debugLogger = createDebugLogger('WORKFLOW_AUTHORING_SKILL');

/** Name of the bundled authoring reference, as the model would invoke it. */
export const WORKFLOW_AUTHORING_SKILL_NAME = 'workflow-authoring';

/** The reference as the Skill tool would load it. */
export interface WorkflowAuthoringReference {
  /** Markdown body, frontmatter stripped. */
  body: string;
  /** Directory holding `SKILL.md`, the base for relative paths in the body. */
  baseDir: string;
}

/**
 * Resolved once: the file ships with the build and cannot change under a
 * running process, and the Workflow tool reads it during construction.
 * `undefined` = not attempted yet, `null` = attempted and unreadable.
 */
let cachedReference: WorkflowAuthoringReference | null | undefined;

/** Where the bundled reference lives, in both a source tree and a build. */
function referencePath(): string {
  return path.join(
    resolveBundleDir(import.meta.url),
    'bundled',
    WORKFLOW_AUTHORING_SKILL_NAME,
    'SKILL.md',
  );
}

/**
 * The bundled reference's body, or `null` when it cannot be read.
 *
 * Synchronous on purpose: the Workflow tool decides between pointing at the
 * skill and inlining it while building its own description, which happens in a
 * constructor. The file is small and read at most once per process.
 *
 * Never throws — a build that somehow shipped without the file degrades to a
 * tool description that points at a skill, which is the same thing the model
 * sees when the skill is present.
 */
export function readWorkflowAuthoringReference(): WorkflowAuthoringReference | null {
  if (cachedReference !== undefined) return cachedReference;
  try {
    const filePath = referencePath();
    const parsed = parseSkillContent(readFileSync(filePath, 'utf8'), filePath);
    cachedReference = { body: parsed.body, baseDir: path.dirname(filePath) };
  } catch (error) {
    debugLogger.warn(`cannot read the workflow-authoring reference: ${error}`);
    cachedReference = null;
  }
  return cachedReference;
}

/**
 * Whether the model can reach the reference through the Skill tool.
 *
 * False means the Workflow tool has to carry the reference itself. Three ways
 * that happens: skills are off entirely (no `SkillManager`), the Skill tool is
 * not in this session's tool set (a deny rule or a `coreTools` allowlist), or
 * this particular skill is disabled.
 *
 * Read through `getAllToolNames()` rather than `getTool()` because it counts
 * tools registered as lazy factories: this runs while the Workflow tool itself
 * is being constructed, and the Skill tool may not be instantiated yet. A
 * question this cannot answer resolves to `true` — pointing at a skill that
 * turns out to be missing costs the model one failed call, while inlining
 * ~9 KB of reference into every request costs every turn of the session.
 */
export function isWorkflowAuthoringSkillAvailable(config: Config): boolean {
  try {
    if (!config.getSkillManager?.()) return false;
    const toolNames = config.getToolRegistry?.()?.getAllToolNames?.();
    if (Array.isArray(toolNames) && !toolNames.includes(ToolNames.SKILL)) {
      return false;
    }
    return (
      config.isSkillEnabled?.({
        name: WORKFLOW_AUTHORING_SKILL_NAME,
        level: 'bundled',
      }) !== false
    );
  } catch (error) {
    debugLogger.warn(`cannot resolve skill availability: ${error}`);
    return true;
  }
}

/**
 * The subset of `SkillTool` this module needs. Structural rather than a real
 * import so a tool module never has to import a skills module that imports it
 * back.
 */
interface LoadedSkillTracker {
  getLoadedSkillNames(): ReadonlySet<string>;
  markSkillLoaded(name: string, content?: string): void;
}

function skillLoadTracker(config: Config): LoadedSkillTracker | null {
  const tool = config.getToolRegistry?.()?.getTool?.(ToolNames.SKILL) as
    | Partial<LoadedSkillTracker>
    | undefined;
  return typeof tool?.getLoadedSkillNames === 'function' &&
    typeof tool?.markSkillLoaded === 'function'
    ? (tool as LoadedSkillTracker)
    : null;
}

/** What a keyword-triggered turn should do about the reference. */
export type WorkflowAuthoringAutoload =
  | {
      status: 'loaded';
      /** Byte-identical to what `Skill("workflow-authoring")` would return. */
      content: string;
      /** Call once the content is actually in the request. */
      markLoaded(): void;
    }
  | { status: 'already-loaded' }
  | { status: 'unavailable' };

/**
 * Whether to inject the reference into a turn the `workflow` keyword steered,
 * and the content to inject.
 *
 * `markLoaded()` is separate from building the content so a caller that ends
 * up not sending the turn does not leave the session believing the model has
 * read something it never saw.
 *
 * Returns `unavailable` when the reference cannot be tracked as loaded, even
 * if it could be read: an injection the Skill tool does not know about would
 * be sent again in full the next time the model invoked the skill.
 */
export function resolveWorkflowAuthoringAutoload(
  config: Config,
): WorkflowAuthoringAutoload {
  if (!isWorkflowAuthoringSkillAvailable(config))
    return { status: 'unavailable' };
  const tracker = skillLoadTracker(config);
  if (!tracker) return { status: 'unavailable' };
  if (tracker.getLoadedSkillNames().has(WORKFLOW_AUTHORING_SKILL_NAME)) {
    return { status: 'already-loaded' };
  }
  const reference = resolveReferenceForInjection(config);
  if (!reference) return { status: 'unavailable' };
  const content = buildSkillLlmContent(reference.baseDir, reference.body);
  return {
    status: 'loaded',
    content,
    markLoaded: () =>
      tracker.markSkillLoaded(WORKFLOW_AUTHORING_SKILL_NAME, content),
  };
}

/**
 * Prefer the manager's own cached copy: it is the exact `(filePath, body)`
 * pair the Skill tool would render, so the injected content matches what a
 * later `Skill("workflow-authoring")` call would produce even if a build ever
 * resolved the two paths differently. Falls back to reading the file.
 */
function resolveReferenceForInjection(
  config: Config,
): WorkflowAuthoringReference | null {
  try {
    const cached = config
      .getSkillManager?.()
      ?.getCachedSkills?.('bundled')
      ?.find((skill) => skill.name === WORKFLOW_AUTHORING_SKILL_NAME);
    if (cached?.body && cached.filePath) {
      return { body: cached.body, baseDir: path.dirname(cached.filePath) };
    }
  } catch (error) {
    debugLogger.warn(`cannot read the cached skill entry: ${error}`);
  }
  return readWorkflowAuthoringReference();
}
