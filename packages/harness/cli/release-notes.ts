/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

// Runtime entry: import after the host has initialized its configuration home.
// UI components remain in the explicit UI entry and load lazily for commands.
export {
  fetchChangelog,
  fetchChangelogForLocale,
  refreshChangelog,
  getChangelogSnapshot,
  subscribeChangelog,
  loadCachedVersionEntries,
  _resetChangelogSnapshotForTest,
  findChangelogEntryForCliVersion,
  parseChangelog,
  type ChangelogSnapshot,
  type VersionEntry,
} from './src/changelog/changelogFetch.js';
export { startChangelogRefresh } from './src/changelog/changelogRefresh.js';
export {
  createReleaseNotesCommand,
  type ReleaseNotesCommandOptions,
} from './src/ui/commands/releaseNotesCommand.js';
