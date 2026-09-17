/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

let environmentBeforeLoad: Readonly<NodeJS.ProcessEnv> | undefined;

export function captureEnvironmentBeforeLoad(): void {
  // Both startup paths load workspace values before the daemon takes its snapshot.
  // User-scoped model deletion must retain the environment from before either load.
  environmentBeforeLoad ??= Object.freeze({ ...process.env });
}

export function getEnvironmentBeforeLoad():
  | Readonly<NodeJS.ProcessEnv>
  | undefined {
  return environmentBeforeLoad;
}

export function resetEnvironmentSnapshotForTesting(): void {
  environmentBeforeLoad = undefined;
}
