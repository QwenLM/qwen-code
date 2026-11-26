import { getTaskOutputBaseDir } from '../../utils/task/diskOutput.js';
import { realpathSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { resolveConfigDirectoryNames } from '../../config/configDirectory.js';
import { getConfigHomeDirOverride } from '../../utils/paths.js';
import { sanitizePath } from '../../utils/sanitizePath.js';
import type { InternalPathContext } from '../../permissions/manager/decision/types/tool-check.js';

export type { InternalPathContext } from '../../permissions/manager/decision/types/tool-check.js';

export interface InternalPathResolveContext {
  readonly cwd: string;
  readonly sessionId?: string;
}

export interface InternalPathDeps {
  readonly resolve: (
    context: InternalPathResolveContext,
  ) => InternalPathContext;
}

export interface InternalPathRoots {
  readonly userConfigDir: string;
  readonly projectConfigDirName: string;
  readonly mcpOutputDirName: string;
  readonly taskOutputDir?: string;
  readonly inboundUploadDir?: string;
}

/** Product adapters resolve environment/configuration before calling this helper. */
export function resolveInternalPaths(
  { cwd, sessionId }: InternalPathResolveContext,
  roots: InternalPathRoots,
): InternalPathContext {
  const projectId = sanitizePath(cwd);
  const projectConfigDir = join(cwd, roots.projectConfigDirName);
  const projectTempDir = join(roots.userConfigDir, 'tmp', projectId);
  let realProjectTempDir: string | undefined;
  try {
    realProjectTempDir = join(
      realpathSync(roots.userConfigDir),
      'tmp',
      projectId,
    );
  } catch {
    // An unresolved root cannot grant an additional real-path allowance.
  }
  return {
    projectConfigDir,
    userConfigDir: roots.userConfigDir,
    projectStorageDir: join(roots.userConfigDir, 'projects', projectId),
    projectTempDir,
    realProjectTempDir,
    taskOutputDir: roots.taskOutputDir,
    pastedImageDir: sessionId
      ? join(projectTempDir, 'images', sessionId)
      : undefined,
    inboundUploadDir: roots.inboundUploadDir,
    plansDir: join(roots.userConfigDir, 'plans'),
    autoMemoryDirs: [join(roots.userConfigDir, 'memory')],
    agentMemoryDirs: [
      join(roots.userConfigDir, 'agent-memory'),
      join(projectConfigDir, 'agent-memory'),
      join(projectConfigDir, 'agent-memory-local'),
    ],
    mcpOutputDirName: roots.mcpOutputDirName,
  };
}

/** Shared Core/CLI defaults do not read product branding. */
export const qwenInternalPathDeps: InternalPathDeps = {
  resolve(context) {
    const names = resolveConfigDirectoryNames({
      rawValue: process.env['QWEN_CONFIG_DIR_NAME'],
      envName: 'QWEN_CONFIG_DIR_NAME',
      userDefault: '.qwen',
      projectDefault: '.qwen',
    });
    const userConfigDir =
      getConfigHomeDirOverride() ??
      (process.env['QWEN_CONFIG_DIR']
        ? resolve(process.env['QWEN_CONFIG_DIR'])
        : join(
            process.env['QWEN_CLI_HOME'] || homedir() || tmpdir(),
            names.userConfigDirName,
          ));
    return resolveInternalPaths(context, {
      userConfigDir,
      projectConfigDirName: names.projectConfigDirName,
      mcpOutputDirName: 'qwen-mcp-outputs',
      taskOutputDir: context.sessionId
        ? join(
            getTaskOutputBaseDir('qwen-code'),
            sanitizePath(context.cwd),
            context.sessionId,
            'tasks',
          )
        : undefined,
      inboundUploadDir: context.sessionId
        ? join(
            process.env['QWEN_HOME'] || join(homedir(), '.qwen-code'),
            'uploads',
            context.sessionId,
          )
        : undefined,
    });
  },
};


