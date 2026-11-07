/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import { blocksAllMemoryWrites } from './write-access.js';

describe('blocksAllMemoryWrites', () => {
  it('reports a blanket deny on both write tools', () => {
    expect(blocksAllMemoryWrites(['write_file', 'edit'])).toBe(true);
  });

  it('recognizes the aliases the CLI and settings accept', () => {
    expect(blocksAllMemoryWrites(['Write', 'Edit'])).toBe(true);
    expect(blocksAllMemoryWrites(['WriteFileTool', 'replace'])).toBe(true);
  });

  it('needs both write tools denied, since either one can save', () => {
    expect(blocksAllMemoryWrites(['write_file'])).toBe(false);
    expect(blocksAllMemoryWrites(['edit'])).toBe(false);
  });

  it('ignores specifier rules, which allow the tool on other paths', () => {
    expect(
      blocksAllMemoryWrites(['write_file(**/.env)', 'edit(**/.env)']),
    ).toBe(false);
    expect(blocksAllMemoryWrites(['edit(src/**)', 'write_file'])).toBe(false);
  });

  it('ignores unrelated tools, malformed rules, and empty input', () => {
    expect(
      blocksAllMemoryWrites(['run_shell_command', 'write_file', 'edit']),
    ).toBe(true);
    expect(blocksAllMemoryWrites(['write_file(broken', 'edit'])).toBe(false);
    expect(blocksAllMemoryWrites(['mcp__srv__write_file', 'edit'])).toBe(false);
    expect(blocksAllMemoryWrites([])).toBe(false);
    expect(blocksAllMemoryWrites(undefined)).toBe(false);
  });
});
