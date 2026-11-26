/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * 会话 id 派生只服务 daemon 的 fork / plain resume 区分；fork id 由 fork 流程自行生成。
 */

/** 仅解析 SDK 当前生成的拆分式 --session-id / --resume 参数；不支持 --resume=<id>。 */
export function findSessionIdArg(args: readonly string[]): string | undefined {
  const index = args.findIndex(
    (arg) => arg === '--session-id' || arg === '--resume',
  );
  if (index >= 0 && index + 1 < args.length) {
    return args[index + 1];
  }
  for (const arg of args) {
    if (arg.startsWith('--session-id=')) {
      return arg.slice('--session-id='.length);
    }
  }
  return undefined;
}

/**
 * 只认 `--session-id`（拆分式与 `=` 式），不把 `--resume` 当成本会话 id 声明。fork 语义
 * 下 `--resume <id>` 携带的是源会话 id，把它当本会话 id 会让 fork 退化成 resume；daemon
 * 的 fork 派生走本函数，plain resume 仍走 `findSessionIdArg`。
 */
export function findSessionIdOnlyArg(
  args: readonly string[],
): string | undefined {
  const index = args.findIndex((arg) => arg === '--session-id');
  if (index >= 0 && index + 1 < args.length) {
    return args[index + 1];
  }
  for (const arg of args) {
    if (arg.startsWith('--session-id=')) {
      return arg.slice('--session-id='.length);
    }
  }
  return undefined;
}

/** argv 是否声明了 fork（`--fork-session` 是布尔 flag，SDK 只推裸 flag，不产值）。 */
export function hasForkSessionArg(args: readonly string[]): boolean {
  return args.some((arg) => arg === '--fork-session');
}
