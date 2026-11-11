/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import nodePath from 'node:path';
import {
  deriveCommandName,
  pathToNamespace,
} from './commandNamespace.js';

describe('pathToNamespace (posix)', () => {
  const p = nodePath.posix;
  const base = '/root/commands';

  it('returns empty when target equals base', () => {
    expect(pathToNamespace(base, base, p)).toBe('');
  });

  it('joins single-segment subpath', () => {
    expect(pathToNamespace('/root/commands/foo', base, p)).toBe('foo');
  });

  it('joins multi-segment subpath with :', () => {
    expect(pathToNamespace('/root/commands/foo/bar', base, p)).toBe('foo:bar');
    expect(pathToNamespace('/root/commands/a/b/c', base, p)).toBe('a:b:c');
  });

  it('preserves segments verbatim (no sanitization)', () => {
    expect(pathToNamespace('/root/commands/foo bar/baz', base, p)).toBe(
      'foo bar:baz',
    );
    expect(pathToNamespace('/root/commands/中文/cmd', base, p)).toBe(
      '中文:cmd',
    );
  });

  it('returns empty when target escapes base', () => {
    expect(pathToNamespace('/root/escape', base, p)).toBe('');
    expect(pathToNamespace('/elsewhere', base, p)).toBe('');
  });

  it('normalizes trailing separators', () => {
    expect(pathToNamespace('/root/commands/foo/', '/root/commands/', p)).toBe(
      'foo',
    );
  });
});

describe('pathToNamespace (win32)', () => {
  const p = nodePath.win32;
  const base = 'C:\\root\\commands';

  it('joins backslash subpath with :', () => {
    expect(pathToNamespace('C:\\root\\commands\\foo\\bar', base, p)).toBe(
      'foo:bar',
    );
  });

  it('returns empty when different drive letters', () => {
    expect(pathToNamespace('D:\\root\\commands\\foo', base, p)).toBe('');
  });

  it('returns empty for UNC vs local drive', () => {
    expect(
      pathToNamespace('\\\\server\\share\\commands\\foo', base, p),
    ).toBe('');
  });
});

describe('deriveCommandName (posix)', () => {
  const p = nodePath.posix;
  const base = '/root/commands';

  it('handles top-level command', () => {
    const r = deriveCommandName({
      filePath: '/root/commands/cmd.md',
      baseDir: base,
      isSkillFile: false,
      path: p,
    });
    expect(r).toEqual({
      identity: 'cmd',
      displayBase: 'cmd',
      namespace: '',
      leaf: 'cmd',
    });
  });

  it('handles one-level nested command', () => {
    const r = deriveCommandName({
      filePath: '/root/commands/foo/bar.md',
      baseDir: base,
      isSkillFile: false,
      path: p,
    });
    expect(r?.identity).toBe('foo:bar');
    expect(r?.namespace).toBe('foo');
    expect(r?.leaf).toBe('bar');
  });

  it('handles multi-level nesting', () => {
    const r = deriveCommandName({
      filePath: '/root/commands/a/b/c.md',
      baseDir: base,
      isSkillFile: false,
      path: p,
    });
    expect(r?.identity).toBe('a:b:c');
  });

  it('handles SKILL.md in a subdirectory', () => {
    const r = deriveCommandName({
      filePath: '/root/commands/foo/SKILL.md',
      baseDir: base,
      isSkillFile: true,
      path: p,
    });
    expect(r?.identity).toBe('foo');
    expect(r?.namespace).toBe('');
    expect(r?.leaf).toBe('foo');
  });

  it('handles SKILL.md in a nested subdirectory', () => {
    const r = deriveCommandName({
      filePath: '/root/commands/foo/bar/SKILL.md',
      baseDir: base,
      isSkillFile: true,
      path: p,
    });
    expect(r?.identity).toBe('foo:bar');
    expect(r?.namespace).toBe('foo');
    expect(r?.leaf).toBe('bar');
  });

  it('returns null for root-level SKILL.md', () => {
    const r = deriveCommandName({
      filePath: '/root/commands/SKILL.md',
      baseDir: base,
      isSkillFile: true,
      path: p,
    });
    expect(r).toBeNull();
  });

  it('prefixes with plugin name verbatim', () => {
    const r = deriveCommandName({
      filePath: '/root/commands/foo/bar.md',
      baseDir: base,
      isSkillFile: false,
      pluginName: 'my-plugin',
      path: p,
    });
    expect(r?.identity).toBe('my-plugin:foo:bar');
    expect(r?.displayBase).toBe('foo:bar');
  });

  it('preserves whitespace and non-ASCII in plugin name', () => {
    const r = deriveCommandName({
      filePath: '/root/commands/cmd.md',
      baseDir: base,
      isSkillFile: false,
      pluginName: 'foo bar',
      path: p,
    });
    expect(r?.identity).toBe('foo bar:cmd');
  });

  it('rejects empty plugin name', () => {
    const r = deriveCommandName({
      filePath: '/root/commands/cmd.md',
      baseDir: base,
      isSkillFile: false,
      pluginName: '',
      path: p,
    });
    expect(r).toBeNull();
  });

  it('preserves non-ASCII leaf characters', () => {
    const r = deriveCommandName({
      filePath: '/root/commands/中文.md',
      baseDir: base,
      isSkillFile: false,
      path: p,
    });
    expect(r?.identity).toBe('中文');
    expect(r?.leaf).toBe('中文');
  });

  it('preserves whitespace in intermediate segments', () => {
    const r = deriveCommandName({
      filePath: '/root/commands/foo bar/baz.md',
      baseDir: base,
      isSkillFile: false,
      path: p,
    });
    expect(r?.identity).toBe('foo bar:baz');
  });
});

describe('deriveCommandName (win32)', () => {
  const p = nodePath.win32;
  const base = 'C:\\root\\commands';

  it('joins backslash subpath', () => {
    const r = deriveCommandName({
      filePath: 'C:\\root\\commands\\foo\\bar.md',
      baseDir: base,
      isSkillFile: false,
      path: p,
    });
    expect(r?.identity).toBe('foo:bar');
  });

  it('handles SKILL.md across backslash separators', () => {
    const r = deriveCommandName({
      filePath: 'C:\\root\\commands\\foo\\SKILL.md',
      baseDir: base,
      isSkillFile: true,
      path: p,
    });
    expect(r?.identity).toBe('foo');
  });

  it('returns null for root-level SKILL.md', () => {
    const r = deriveCommandName({
      filePath: 'C:\\root\\commands\\SKILL.md',
      baseDir: base,
      isSkillFile: true,
      path: p,
    });
    expect(r).toBeNull();
  });

  it('returns empty namespace when on a different drive', () => {
    const r = deriveCommandName({
      filePath: 'D:\\root\\commands\\foo\\bar.md',
      baseDir: base,
      isSkillFile: false,
      path: p,
    });
    // Different drive means relative path becomes absolute → namespace = ''
    expect(r?.namespace).toBe('');
    expect(r?.leaf).toBe('bar');
    expect(r?.identity).toBe('bar');
  });
});

describe('deriveCommandName (default path)', () => {
  it('uses node:path automatically when no impl is provided', () => {
    // Use a path that works on the host OS to verify default wiring.
    const cwd = nodePath.resolve('/');
    const baseDir = nodePath.join(cwd, 'root', 'commands');
    const filePath = nodePath.join(baseDir, 'foo', 'bar.md');
    const r = deriveCommandName({
      filePath,
      baseDir,
      isSkillFile: false,
    });
    expect(r?.identity).toBe('foo:bar');
  });
});
