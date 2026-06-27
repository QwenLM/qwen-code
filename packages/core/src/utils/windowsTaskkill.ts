/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

// Absolute path to the Windows taskkill binary, resolved once. Never spawn
// taskkill by its bare name: on Windows, child_process resolves a bare command
// through the executable search path AND the current directory, so a
// taskkill.exe/.bat planted in the workspace or on PATH could run from any
// teardown/cleanup path with the CLI's environment — arbitrary code execution
// out of a benign kill. See #5873.
//
// Only trust SystemRoot when it's an absolute drive path: a relative-poisoned
// value (e.g. SystemRoot=Windows) would otherwise make the resolved path
// relative and re-open the CWD resolution this is meant to close. Fall back to
// the canonical absolute path otherwise.
const systemRoot = process.env['SystemRoot'];
export const WINDOWS_TASKKILL =
  systemRoot && /^[A-Za-z]:[\\/]/.test(systemRoot)
    ? `${systemRoot}\\System32\\taskkill.exe`
    : 'C:\\Windows\\System32\\taskkill.exe';
