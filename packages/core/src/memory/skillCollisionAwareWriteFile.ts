/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * A `write_file` tool that wraps the real {@link WriteFileTool} and applies
 * the auto-skill collision guard before the underlying write executes
 * (issue #4437).
 *
 * Behaviour:
 *  - When the agent writes to a path that is NOT a project SKILL.md slot,
 *    the wrapper is a passthrough — generic file writes are unchanged.
 *  - When the agent writes to a SKILL.md slot that does not yet exist,
 *    the wrapper is also a passthrough.
 *  - When the SKILL.md slot already exists, the wrapper consults the
 *    configured {@link SkillCollisionStrategy}:
 *      `rename`    → rewrite the path to the next free `<name>-N/` slot
 *      `skip`      → return a skip result without touching disk
 *      `overwrite` → behave like the real WriteFileTool (legacy behaviour)
 *
 * The wrapper deliberately lives at the skill-write boundary rather than
 * inside the generic `write_file` tool: every other caller of write_file
 * (edits, scratch files, etc.) intentionally relies on overwrite
 * semantics, so the guard is opt-in via the skill-review scoped config.
 */

import type { Config } from '../config/config.js';
import {
  BaseDeclarativeTool,
  BaseToolInvocation,
  Kind,
} from '../tools/tools.js';
import type {
  ToolInvocation,
  ToolResult,
  ToolLocation,
} from '../tools/tools.js';
import type { PermissionDecision } from '../permissions/types.js';
import { ToolNames, ToolDisplayNames } from '../tools/tool-names.js';
import {
  WriteFileTool,
  type WriteFileToolParams,
} from '../tools/write-file.js';
import { ToolErrorType } from '../tools/tool-error.js';
import type { ToolRegistry } from '../tools/tool-registry.js';
import {
  resolveSkillCollision,
  type SkillCollisionStrategy,
} from './skillCollisionGuard.js';
import { createDebugLogger } from '../utils/debugLogger.js';

const debugLogger = createDebugLogger('SKILL_COLLISION_GUARD');

/**
 * Invocation that defers all on-disk work to the inner WriteFileTool's
 * invocation, but interposes a collision check at execute() time. The
 * collision check requires async filesystem stat calls so it cannot run in
 * the synchronous `createInvocation` path.
 */
class SkillCollisionAwareWriteFileInvocation extends BaseToolInvocation<
  WriteFileToolParams,
  ToolResult
> {
  constructor(
    private readonly inner: WriteFileTool,
    private readonly projectRoot: string,
    private readonly strategy: SkillCollisionStrategy,
    params: WriteFileToolParams,
  ) {
    super(params);
  }

  override toolLocations(): ToolLocation[] {
    return [{ path: this.params.file_path }];
  }

  override getDescription(): string {
    // Cannot resolve the rename synchronously — describe the proposed write
    // as the agent requested it. The eventual execute() result includes the
    // final on-disk path so the caller still gets the truth post-write.
    return `Writing skill to ${this.params.file_path}`;
  }

  override getDefaultPermission(): Promise<PermissionDecision> {
    // The skill-review scope runs in YOLO + scoped PermissionManager, which
    // already governs path access. Matching the inner tool's "ask" default
    // is unnecessary here; allow lets the scoped PM be the single source
    // of truth for this code path.
    return Promise.resolve('allow');
  }

  override async execute(signal: AbortSignal): Promise<ToolResult> {
    const resolution = await resolveSkillCollision(
      this.params.file_path,
      this.strategy,
      this.projectRoot,
    );

    if (resolution.action === 'skip') {
      debugLogger.info(
        `Skipped auto-skill write to ${resolution.originalFilePath}: ${resolution.reason}`,
      );
      return {
        llmContent: resolution.reason,
        returnDisplay: resolution.reason,
        error: {
          message: resolution.reason,
          type: ToolErrorType.FILE_WRITE_FAILURE,
        },
      };
    }

    const finalParams: WriteFileToolParams = {
      ...this.params,
      file_path: resolution.filePath,
    };

    // Delegate to the inner WriteFileTool. Validation runs again on the
    // adjusted path so any path-level errors (e.g. directory targets) are
    // surfaced through the inner tool's structured error contract instead
    // of being swallowed here.
    const innerInvocation = this.inner.build(finalParams);
    const result = await innerInvocation.execute(signal);

    if (resolution.renamedFrom && !result.error) {
      const notice =
        `Skill name collision: "${resolution.renamedFrom}" already exists. ` +
        `Wrote new skill to "${resolution.filePath}" instead.`;
      debugLogger.warn(notice);
      // Surface the rename through the tool result. The skill-review agent
      // (and `runForkedAgent`'s `filesTouched` aggregation) consult both
      // `llmContent` and `returnDisplay` — append, don't replace.
      const annotated = `${notice}\n\n${result.llmContent ?? ''}`.trimEnd();
      return {
        ...result,
        llmContent: annotated,
        returnDisplay:
          typeof result.returnDisplay === 'string'
            ? `${notice}\n\n${result.returnDisplay}`.trimEnd()
            : result.returnDisplay,
      };
    }

    return result;
  }
}

/**
 * The wrapping declarative tool. Schema and metadata mirror the inner tool
 * so the agent sees an identical function declaration — only execute()
 * behaviour differs.
 */
export class SkillCollisionAwareWriteFileTool extends BaseDeclarativeTool<
  WriteFileToolParams,
  ToolResult
> {
  static readonly Name: string = ToolNames.WRITE_FILE;

  constructor(
    private readonly inner: WriteFileTool,
    private readonly projectRoot: string,
    private readonly strategy: SkillCollisionStrategy,
  ) {
    super(
      inner.name,
      // displayName intentionally falls back to the inner tool's user-facing
      // label so confirmation surfaces stay consistent.
      inner.displayName ?? ToolDisplayNames.WRITE_FILE,
      inner.description,
      Kind.Edit,
      inner.parameterSchema,
      inner.isOutputMarkdown,
      inner.canUpdateOutput,
      inner.shouldDefer,
      inner.alwaysLoad,
      inner.searchHint,
    );
  }

  override validateToolParams(params: WriteFileToolParams): string | null {
    return this.inner.validateToolParams(params);
  }

  protected createInvocation(
    params: WriteFileToolParams,
  ): ToolInvocation<WriteFileToolParams, ToolResult> {
    return new SkillCollisionAwareWriteFileInvocation(
      this.inner,
      this.projectRoot,
      this.strategy,
      params,
    );
  }

  override toAutoClassifierInput(
    params: WriteFileToolParams,
  ): Record<string, unknown> | string | undefined {
    return this.inner.toAutoClassifierInput(params);
  }
}

/**
 * Replace `write_file` in the registry with the collision-aware wrapper.
 *
 * Idempotent: re-registering the same tool name overwrites the prior
 * factory (the tool registry's documented behaviour for built-ins).
 *
 * `config` is the scope the inner WriteFileTool should bind to — usually
 * the YOLO override created by `runForkedAgent`. The wrapper itself holds
 * no Config reference; all path-resolution context comes from `projectRoot`.
 */
export function installSkillCollisionGuard(
  registry: ToolRegistry,
  config: Config,
  projectRoot: string,
  strategy: SkillCollisionStrategy,
): void {
  if (strategy === 'overwrite') {
    // Explicit opt-out — leave the original WriteFileTool in place.
    return;
  }
  registry.registerFactory(ToolNames.WRITE_FILE, async () => {
    const inner = new WriteFileTool(config);
    return new SkillCollisionAwareWriteFileTool(inner, projectRoot, strategy);
  });
}
