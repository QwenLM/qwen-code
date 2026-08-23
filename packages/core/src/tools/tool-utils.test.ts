/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { expect, describe, it } from 'vitest';
import { isToolEnabled } from './tool-utils.js';
import { ToolNames } from './tool-names.js';

describe('isToolEnabled', () => {
  it('enables tool when coreTools is undefined and tool is not excluded', () => {
    expect(isToolEnabled(ToolNames.SHELL, undefined, undefined)).toBe(true);
  });

  it('disables tool when excluded by canonical tool name', () => {
    expect(
      isToolEnabled(ToolNames.SHELL, undefined, ['run_shell_command']),
    ).toBe(false);
  });

  it('enables tool when explicitly listed by display name', () => {
    expect(isToolEnabled(ToolNames.SHELL, ['Shell'], undefined)).toBe(true);
  });

  it('enables tool when explicitly listed by class name', () => {
    expect(isToolEnabled(ToolNames.SHELL, ['ShellTool'], undefined)).toBe(true);
  });

  it('supports class names with leading underscores', () => {
    expect(isToolEnabled(ToolNames.SHELL, ['__ShellTool'], undefined)).toBe(
      true,
    );
  });

  it('enables tool when coreTools contains a legacy tool name alias', () => {
    expect(
      isToolEnabled(ToolNames.GREP, ['search_file_content'], undefined),
    ).toBe(true);
  });

  it('enables tool when coreTools contains a legacy display name alias', () => {
    expect(isToolEnabled(ToolNames.GLOB, ['FindFiles'], undefined)).toBe(true);
  });

  it('keeps the pre-rename TodoWrite display name working as a legacy alias', () => {
    // The display name was renamed from 'TodoWrite' to 'TodoList'; existing
    // coreTools/excludeTools configs that reference the old name must still
    // resolve via ToolDisplayNamesMigration.
    expect(isToolEnabled(ToolNames.TODO_WRITE, ['TodoWrite'], undefined)).toBe(
      true,
    );
    expect(isToolEnabled(ToolNames.TODO_WRITE, undefined, ['TodoWrite'])).toBe(
      false,
    );
  });

  it('enables tool when coreTools contains an argument-specific pattern', () => {
    expect(
      isToolEnabled(ToolNames.SHELL, ['Shell(git status)'], undefined),
    ).toBe(true);
  });

  it('disables tool when not present in coreTools', () => {
    expect(isToolEnabled(ToolNames.SHELL, ['Edit'], undefined)).toBe(false);
  });

  it('uses legacy display name aliases when excluding tools', () => {
    expect(isToolEnabled(ToolNames.GREP, undefined, ['SearchFiles'])).toBe(
      false,
    );
  });

  it('does not treat argument-specific exclusions as matches', () => {
    expect(
      isToolEnabled(ToolNames.SHELL, undefined, ['Shell(git status)']),
    ).toBe(true);
  });

  it('considers excludeTools even when tool is explicitly enabled', () => {
    expect(isToolEnabled(ToolNames.SHELL, ['Shell'], ['ShellTool'])).toBe(
      false,
    );
  });
});
