/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

// #14147: the POSIX single-quote escape the hosted gate drivers each used
// to carry as a private const (four copies: hosted-shell-output-driver,
// hosted-provider-control-driver, hosted-workspace-tool-turn-driver,
// hosted-monitor-run-fault-driver).

/** Quote a value for embedding in a POSIX single-quoted shell string. */
export const quotePosix = (value: string) =>
  "'" + value.replaceAll("'", "'\"'\"'") + "'";
