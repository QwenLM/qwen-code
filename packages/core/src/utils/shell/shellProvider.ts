/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

export const SHELL_TYPES = ['bash', 'powershell'] as const;
export type ShellType = (typeof SHELL_TYPES)[number];

/** The default shell type used when no explicit shell is specified. */
export const DEFAULT_SHELL_TYPE: ShellType = 'bash';
/**
 * 单次命令所属会话提供的 Shell 输入。
 *
 * ShellProvider 按 shellType 全局缓存并被所有会话复用，会话相关的数据不能在
 * 创建 provider 时捕获，只能随每条命令传入，否则后创建的会话会覆盖前一个会话
 * 读到的值。由命令所属的 Config 实现。
 */
export interface ShellSessionContext {
  /** 需要前置到 PATH 的插件 `bin/` 目录绝对路径。 */
  getPluginBinPaths(): string[];
  /**
   * 本会话 hook 写出的环境脚本，在每条命令前 source。按会话隔离：A 会话不得
   * source 到 B 会话的 `session-env/<sessionId>/*.sh`。
   */
  getSessionEnvScript(): Promise<string | null>;
  /** 本会话合并后的完整 settings 快照，供按会话注入子进程环境。 */
  getSettings?(): unknown;
}

/** {@link ShellProvider.buildExecCommand} 的逐次调用参数。 */
export interface BuildExecCommandOptions {
  id: number | string;
  /** 本次命令所属会话的输入；缺省时按无插件目录处理。 */
  sessionContext?: ShellSessionContext;
}

/**
 * Abstraction for shell-specific command assembly and spawn configuration.
 * Each shell type (bash, powershell) provides its own implementation.
 */
export type ShellProvider = {
  /** The shell type identifier. */
  type: ShellType;

  /** Absolute path to the shell binary. */
  shellPath: string;

  /** Whether to spawn the child process in detached mode. */
  detached: boolean;

  /** Path syntax written to cwdFilePath by this provider. */
  cwdFileContentPathStyle?: 'posix' | 'native';

  /**
   * Assembles the full command string for execution.
   * Includes: snapshot sourcing, env setup, extglob disable, eval-wrap, pwd tracking.
   *
   * @returns commandString - The assembled command to pass to spawn.
   * @returns cwdFilePath - Path to temp file where pwd is written for CWD tracking.
   */
  buildExecCommand(
    command: string,
    opts: BuildExecCommandOptions,
  ): Promise<{
    commandString: string;
    cwdFilePath: string;
    /** Per-execution data, kept out of the shell command text. */
    env?: Record<string, string>;
    /** Content-free wrapper metadata for failure diagnosis. */
    diagnostics?: string;
    cleanup?: () => void;
  }>;

  /**
   * Returns the arguments array for spawn().
   * e.g., ['-c', '-l', commandString] or ['-c', commandString]
   */
  getSpawnArgs(commandString: string): string[];

  /**
   * Returns extra environment variables for the child process.
   */
  getEnvironmentOverrides(command: string): Promise<Record<string, string>>;
};
