/**
 * @license
 * Copyright 2025 Qwen team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect } from 'vitest';
import { extractShellOperations } from './shell-semantics.js';
import type { ShellOperation } from './shell-semantics.js';

const CWD = '/home/user/project';

// Helper: sort ops for stable comparison
function sorted(ops: ShellOperation[]) {
  return [...ops].sort((a, b) =>
    `${a.virtualTool}:${a.filePath ?? ''}:${a.domain ?? ''}`.localeCompare(
      `${b.virtualTool}:${b.filePath ?? ''}:${b.domain ?? ''}`,
    ),
  );
}

describe('extractShellOperations', () => {
  // ── Empty / no-op ──────────────────────────────────────────────────────────

  it('returns [] for empty string', () => {
    expect(extractShellOperations('', CWD)).toEqual([]);
  });

  it('returns [] for whitespace', () => {
    expect(extractShellOperations('   ', CWD)).toEqual([]);
  });

  it('returns [] for unknown commands', () => {
    expect(extractShellOperations('frobnicate /etc/passwd', CWD)).toEqual([]);
  });

  it('returns [] for env-var assignments', () => {
    expect(extractShellOperations('FOO=bar', CWD)).toEqual([]);
  });

  // ── cat ────────────────────────────────────────────────────────────────────

  it('cat: absolute path', () => {
    const ops = extractShellOperations('cat /etc/passwd', CWD);
    expect(ops).toEqual([
      { virtualTool: 'read_file', filePath: '/etc/passwd' },
    ]);
  });

  it('cat: relative path resolved against cwd', () => {
    const ops = extractShellOperations('cat secrets.txt', CWD);
    expect(ops).toEqual([
      { virtualTool: 'read_file', filePath: `${CWD}/secrets.txt` },
    ]);
  });

  it('cat: ~ expansion', () => {
    const ops = extractShellOperations('cat ~/.ssh/id_rsa', CWD);
    expect(ops[0]?.filePath).toMatch(/\/\.ssh\/id_rsa$/);
  });

  it('cat: multiple files', () => {
    const ops = extractShellOperations('cat /a/b /c/d', CWD);
    expect(sorted(ops)).toEqual([
      { virtualTool: 'read_file', filePath: '/a/b' },
      { virtualTool: 'read_file', filePath: '/c/d' },
    ]);
  });

  it('cat: flags are ignored', () => {
    const ops = extractShellOperations('cat -n /etc/hosts', CWD);
    expect(ops).toEqual([{ virtualTool: 'read_file', filePath: '/etc/hosts' }]);
  });

  it('cat: quoted path', () => {
    const ops = extractShellOperations("cat '/etc/my file.conf'", CWD);
    expect(ops).toEqual([
      { virtualTool: 'read_file', filePath: '/etc/my file.conf' },
    ]);
  });

  // ── head / tail ────────────────────────────────────────────────────────────

  it('head: -n value not treated as path', () => {
    const ops = extractShellOperations('head -n 10 /var/log/syslog', CWD);
    expect(ops).toEqual([
      { virtualTool: 'read_file', filePath: '/var/log/syslog' },
    ]);
  });

  it('tail: multiple files with flag', () => {
    const ops = extractShellOperations('tail -c 100 /a /b', CWD);
    expect(sorted(ops)).toEqual([
      { virtualTool: 'read_file', filePath: '/a' },
      { virtualTool: 'read_file', filePath: '/b' },
    ]);
  });

  // ── diff ───────────────────────────────────────────────────────────────────

  it('diff: two files', () => {
    const ops = extractShellOperations('diff /old /new', CWD);
    expect(sorted(ops)).toEqual([
      { virtualTool: 'read_file', filePath: '/new' },
      { virtualTool: 'read_file', filePath: '/old' },
    ]);
  });

  // ── grep ───────────────────────────────────────────────────────────────────

  it('grep: first positional is pattern, rest are files', () => {
    const ops = extractShellOperations('grep password /etc/shadow', CWD);
    expect(ops).toEqual([
      { virtualTool: 'read_file', filePath: '/etc/shadow' },
    ]);
  });

  it('grep: -r becomes list_directory', () => {
    const ops = extractShellOperations('grep -r secret /etc', CWD);
    expect(ops).toEqual([{ virtualTool: 'list_directory', filePath: '/etc' }]);
  });

  it('grep: -e flag shifts all positionals to paths', () => {
    const ops = extractShellOperations(
      'grep -e password /etc/passwd /etc/shadow',
      CWD,
    );
    expect(sorted(ops)).toEqual([
      { virtualTool: 'read_file', filePath: '/etc/passwd' },
      { virtualTool: 'read_file', filePath: '/etc/shadow' },
    ]);
  });

  it('grep: -f patternfile — positionals are file paths', () => {
    const ops = extractShellOperations('grep -f patterns.txt /etc/hosts', CWD);
    // -f consumes patterns.txt; /etc/hosts is the only positional → first positional skipped? No.
    // With -f, hasPatternFlag=true, so all positionals are file paths (no slice(1))
    expect(ops).toEqual([{ virtualTool: 'read_file', filePath: '/etc/hosts' }]);
  });

  it('grep: -A value not treated as path', () => {
    const ops = extractShellOperations('grep -A 3 error /var/log/app.log', CWD);
    expect(ops).toEqual([
      { virtualTool: 'read_file', filePath: '/var/log/app.log' },
    ]);
  });

  // ── ls / find ──────────────────────────────────────────────────────────────

  it('ls: no args defaults to cwd', () => {
    const ops = extractShellOperations('ls', CWD);
    expect(ops).toEqual([{ virtualTool: 'list_directory', filePath: CWD }]);
  });

  it('ls: explicit dir', () => {
    const ops = extractShellOperations('ls /var/log', CWD);
    expect(ops).toEqual([
      { virtualTool: 'list_directory', filePath: '/var/log' },
    ]);
  });

  it('find: first positional is starting dir', () => {
    const ops = extractShellOperations('find /etc -name "*.conf"', CWD);
    expect(ops).toEqual([{ virtualTool: 'list_directory', filePath: '/etc' }]);
  });

  it('find: no starting dir defaults to cwd', () => {
    const ops = extractShellOperations('find -name "*.txt"', CWD);
    expect(ops).toEqual([{ virtualTool: 'list_directory', filePath: CWD }]);
  });

  // ── touch / mkdir ──────────────────────────────────────────────────────────

  it('touch: creates a file (write_file)', () => {
    const ops = extractShellOperations('touch /tmp/new.txt', CWD);
    expect(ops).toEqual([
      { virtualTool: 'write_file', filePath: '/tmp/new.txt' },
    ]);
  });

  it('mkdir: creates a directory (write_file)', () => {
    const ops = extractShellOperations('mkdir -p /tmp/a/b', CWD);
    expect(ops).toEqual([{ virtualTool: 'write_file', filePath: '/tmp/a/b' }]);
  });

  // ── cp / mv ────────────────────────────────────────────────────────────────

  it('cp: src=read, dst=write', () => {
    const ops = extractShellOperations('cp /etc/passwd /tmp/backup', CWD);
    expect(sorted(ops)).toEqual([
      { virtualTool: 'read_file', filePath: '/etc/passwd' },
      { virtualTool: 'write_file', filePath: '/tmp/backup' },
    ]);
  });

  it('mv: src=edit, dst=write', () => {
    const ops = extractShellOperations('mv /tmp/a /tmp/b', CWD);
    expect(sorted(ops)).toEqual([
      { virtualTool: 'edit', filePath: '/tmp/a' },
      { virtualTool: 'write_file', filePath: '/tmp/b' },
    ]);
  });

  // ── rm ─────────────────────────────────────────────────────────────────────

  it('rm: single file is edit', () => {
    const ops = extractShellOperations('rm /tmp/secret.txt', CWD);
    expect(ops).toEqual([{ virtualTool: 'edit', filePath: '/tmp/secret.txt' }]);
  });

  it('rm -rf: directory is edit', () => {
    const ops = extractShellOperations('rm -rf /tmp/dir', CWD);
    expect(ops).toEqual([{ virtualTool: 'edit', filePath: '/tmp/dir' }]);
  });

  // ── chmod / chown ──────────────────────────────────────────────────────────

  it('chmod: mode arg is skipped, file is edit', () => {
    const ops = extractShellOperations('chmod 755 /usr/local/bin/script', CWD);
    expect(ops).toEqual([
      { virtualTool: 'edit', filePath: '/usr/local/bin/script' },
    ]);
  });

  it('chown: owner arg is skipped, file is edit', () => {
    const ops = extractShellOperations('chown root:root /etc/config', CWD);
    expect(ops).toEqual([{ virtualTool: 'edit', filePath: '/etc/config' }]);
  });

  // ── sed ────────────────────────────────────────────────────────────────────

  it('sed without -i: read_file', () => {
    const ops = extractShellOperations("sed 's/foo/bar/' /etc/hosts", CWD);
    expect(ops).toEqual([{ virtualTool: 'read_file', filePath: '/etc/hosts' }]);
  });

  it('sed -i: edit', () => {
    const ops = extractShellOperations("sed -i 's/foo/bar/' /etc/hosts", CWD);
    expect(ops).toEqual([{ virtualTool: 'edit', filePath: '/etc/hosts' }]);
  });

  it('sed -e: all positionals are files', () => {
    const ops = extractShellOperations("sed -e 's/foo/bar/' /a /b", CWD);
    expect(sorted(ops)).toEqual([
      { virtualTool: 'read_file', filePath: '/a' },
      { virtualTool: 'read_file', filePath: '/b' },
    ]);
  });

  // ── awk ────────────────────────────────────────────────────────────────────

  it('awk: program expression filtered, file identified', () => {
    const ops = extractShellOperations("awk '{print $1}' /etc/passwd", CWD);
    expect(ops).toEqual([
      { virtualTool: 'read_file', filePath: '/etc/passwd' },
    ]);
  });

  it('awk -F: separator consumed, file identified', () => {
    const ops = extractShellOperations("awk -F: '{print $2}' /etc/shadow", CWD);
    expect(ops).toEqual([
      { virtualTool: 'read_file', filePath: '/etc/shadow' },
    ]);
  });

  // ── dd ─────────────────────────────────────────────────────────────────────

  it('dd if= and of=', () => {
    const ops = extractShellOperations('dd if=/dev/sda of=/tmp/disk.img', CWD);
    expect(sorted(ops)).toEqual([
      { virtualTool: 'read_file', filePath: '/dev/sda' },
      { virtualTool: 'write_file', filePath: '/tmp/disk.img' },
    ]);
  });

  // ── Redirections ───────────────────────────────────────────────────────────

  it('redirect >: write_file', () => {
    const ops = extractShellOperations('echo hello > /tmp/out.txt', CWD);
    expect(ops).toEqual([
      { virtualTool: 'write_file', filePath: '/tmp/out.txt' },
    ]);
  });

  it('redirect >>: write_file', () => {
    const ops = extractShellOperations('date >> /var/log/app.log', CWD);
    expect(ops).toEqual([
      { virtualTool: 'write_file', filePath: '/var/log/app.log' },
    ]);
  });

  it('redirect <: read_file', () => {
    const ops = extractShellOperations('sort < /tmp/data.txt', CWD);
    expect(ops).toContainEqual({
      virtualTool: 'read_file',
      filePath: '/tmp/data.txt',
    });
  });

  it('combined redirect >file without space', () => {
    const ops = extractShellOperations('echo hi >/tmp/foo', CWD);
    expect(ops).toContainEqual({
      virtualTool: 'write_file',
      filePath: '/tmp/foo',
    });
  });

  it('redirect 2>/dev/null: ignored (no op)', () => {
    const ops = extractShellOperations('cat /etc/passwd 2>/dev/null', CWD);
    expect(ops).not.toContainEqual(
      expect.objectContaining({ filePath: '/dev/null' }),
    );
    expect(ops).toContainEqual({
      virtualTool: 'read_file',
      filePath: '/etc/passwd',
    });
  });

  // ── curl / wget ────────────────────────────────────────────────────────────

  it('curl: extracts domain', () => {
    const ops = extractShellOperations(
      'curl https://api.example.com/data',
      CWD,
    );
    expect(ops).toEqual([
      { virtualTool: 'web_fetch', domain: 'api.example.com' },
    ]);
  });

  it('curl: -o flag value not treated as URL', () => {
    const ops = extractShellOperations(
      'curl -o /tmp/out.json https://api.example.com',
      CWD,
    );
    expect(ops).toEqual([
      { virtualTool: 'web_fetch', domain: 'api.example.com' },
    ]);
  });

  it('wget: extracts domain', () => {
    const ops = extractShellOperations(
      'wget https://example.com/file.tar.gz',
      CWD,
    );
    expect(ops).toEqual([{ virtualTool: 'web_fetch', domain: 'example.com' }]);
  });

  it('wget: -O flag value not treated as URL', () => {
    const ops = extractShellOperations(
      'wget -O /tmp/file.gz https://example.com/f.gz',
      CWD,
    );
    expect(ops).toEqual([{ virtualTool: 'web_fetch', domain: 'example.com' }]);
  });

  // ── sudo / prefix commands ─────────────────────────────────────────────────

  it('sudo cat: transparent wrapper', () => {
    const ops = extractShellOperations('sudo cat /etc/sudoers', CWD);
    expect(ops).toEqual([
      { virtualTool: 'read_file', filePath: '/etc/sudoers' },
    ]);
  });

  it('sudo -u user cat: strips flags before inner cmd', () => {
    const ops = extractShellOperations('sudo -u root cat /etc/shadow', CWD);
    expect(ops).toEqual([
      { virtualTool: 'read_file', filePath: '/etc/shadow' },
    ]);
  });

  it('env cmd: transparent wrapper', () => {
    const ops = extractShellOperations('env cat /etc/hosts', CWD);
    expect(ops).toEqual([{ virtualTool: 'read_file', filePath: '/etc/hosts' }]);
  });

  it('timeout cmd: transparent wrapper', () => {
    const ops = extractShellOperations(
      'timeout 30 wget https://example.com',
      CWD,
    );
    expect(ops).toEqual([{ virtualTool: 'web_fetch', domain: 'example.com' }]);
  });

  // ── Combination: command + redirect ───────────────────────────────────────

  it('cat src > dst: both read and write', () => {
    const ops = extractShellOperations('cat /etc/passwd > /tmp/copy', CWD);
    expect(sorted(ops)).toEqual([
      { virtualTool: 'read_file', filePath: '/etc/passwd' },
      { virtualTool: 'write_file', filePath: '/tmp/copy' },
    ]);
  });

  it('grep pattern file > out: read + write', () => {
    const ops = extractShellOperations(
      'grep secret /etc/config > /tmp/out',
      CWD,
    );
    expect(sorted(ops)).toEqual([
      { virtualTool: 'read_file', filePath: '/etc/config' },
      { virtualTool: 'write_file', filePath: '/tmp/out' },
    ]);
  });

  // ── Variables / unresolvable patterns ─────────────────────────────────────

  it('$VAR paths are not included', () => {
    const ops = extractShellOperations('cat $SECRET_FILE', CWD);
    // $SECRET_FILE starts with $, filtered by looksLikePath
    expect(ops).toEqual([]);
  });
});
