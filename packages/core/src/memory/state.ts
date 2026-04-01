/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

const runningExtractProjects = new Set<string>();

export function isExtractRunning(projectRoot: string): boolean {
  return runningExtractProjects.has(projectRoot);
}

export function markExtractRunning(projectRoot: string): void {
  runningExtractProjects.add(projectRoot);
}

export function clearExtractRunning(projectRoot: string): void {
  runningExtractProjects.delete(projectRoot);
}

export function resetAutoMemoryStateForTests(): void {
  runningExtractProjects.clear();
}