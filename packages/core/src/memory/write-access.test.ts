/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import type { Config } from '../config/config.js';
import {
  blocksAllMemoryWrites,
  blocksAllMemoryWritesForConfig,
} from './write-access.js';

const denyEntry = (raw: string, type: 'deny' | 'allow' | 'ask' = 'deny') => ({
  rule: { raw } as never,
  type,
  scope: 'user' as const,
});

const configWith = (opts: {
  snapshot?: string[];
  denyRules?: string[];
  allowRules?: string[];
}): Config =>
  ({
    getPermissionsDeny: () => opts.snapshot ?? [],
    getPermissionManager: () => ({
      listRules: () => [
        ...(opts.denyRules ?? []).map((raw) => denyEntry(raw)),
        ...(opts.allowRules ?? []).map((raw) => denyEntry(raw, 'allow')),
      ],
    }),
  }) as unknown as Config;

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
    // A bare `edit` denies `write_file` as well, so on its own it is already
    // both write tools and the extractor has nowhere to save.
    expect(blocksAllMemoryWrites(['edit'])).toBe(true);
    expect(blocksAllMemoryWrites(['Edit', 'write_file'])).toBe(true);
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
    expect(blocksAllMemoryWrites(['write_file(broken', 'edit(src/**)'])).toBe(
      false,
    );
    // Two malformed rules with no specifier: without the `rule.invalid`
    // guard each parses to a bare tool name and the pair reads as a blanket
    // deny. One malformed rule beside a specifier rule cannot distinguish
    // that, because the specifier rule already fails `every()` on its own.
    expect(blocksAllMemoryWrites(['write_file(**/.env', 'edit(**/.env'])).toBe(
      false,
    );
    expect(
      blocksAllMemoryWrites(['mcp__srv__write_file', 'edit(src/**)']),
    ).toBe(false);
    expect(blocksAllMemoryWrites([])).toBe(false);
    expect(blocksAllMemoryWrites(undefined)).toBe(false);
  });
});

describe('blocksAllMemoryWritesForConfig', () => {
  it('reads the live deny rules, not the config snapshot', () => {
    // `/permissions` removes a rule from the manager only; the snapshot the
    // Config captured at construction still lists it.
    const config = configWith({ snapshot: ['edit'], denyRules: [] });
    expect(blocksAllMemoryWritesForConfig(config)).toBe(false);
  });

  it('still reports a deny the manager holds', () => {
    const config = configWith({
      snapshot: [],
      denyRules: ['write_file', 'edit'],
    });
    expect(blocksAllMemoryWritesForConfig(config)).toBe(true);
  });

  it('falls back to the snapshot when no manager exists', () => {
    const config = { getPermissionsDeny: () => ['edit'] } as unknown as Config;
    expect(blocksAllMemoryWritesForConfig(config)).toBe(true);
  });

  it('ignores allow entries for the write tools', () => {
    // A manager lists every rule it holds, so an auto-edit user's
    // `allow: ['Edit', 'WriteFile']` arrives here too. Reading those as
    // denials would report `writes_denied` on every turn and silently stop
    // managed auto-memory for someone who denied nothing.
    const config = configWith({
      snapshot: [],
      denyRules: [],
      allowRules: ['Edit', 'WriteFile'],
    });
    expect(blocksAllMemoryWritesForConfig(config)).toBe(false);
  });
});
