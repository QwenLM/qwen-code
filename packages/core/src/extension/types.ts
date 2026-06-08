/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * The scope an extension is installed at.
 *
 * - `User`: installed under `~/.qwen/extensions/` and available in every
 *   workspace.
 * - `Project`: installed under `<project>/.qwen/extensions/` and only loaded
 *   when the workspace is trusted, so it is scoped to that project.
 *
 * Kept in its own module (rather than `extensionManager.ts`) so lower-level
 * files such as `storage.ts` can depend on it without creating an import cycle.
 */
export enum ExtensionScope {
  User = 'user',
  Project = 'project',
}
