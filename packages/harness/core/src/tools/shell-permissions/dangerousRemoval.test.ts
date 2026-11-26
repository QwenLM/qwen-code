/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir, homedir } from 'node:os';
import * as path from 'node:path';
import { analyzeShellCommand } from './shellCommandAnalysis.js';
import {
  checkDangerousRemoval,
  DANGEROUS_REMOVAL_DECISION_POINT,
  DANGEROUS_REMOVAL_KIND,
  isCriticalPath,
  isSameOrAncestor,
  type DangerousRemovalOptions,
} from './dangerousRemoval.js';

const CWD = '/srv/work/project';

function check(
  command: string,
  overrides: Partial<DangerousRemovalOptions> = {},
  analysisOverrides: Partial<ReturnType<typeof analyzeShellCommand>> = {},
) {
  const analysis = { ...analyzeShellCommand(command), ...analysisOverrides };
  return checkDangerousRemoval(command, analysis, {
    executionCwd: CWD,
    permissionCwd: CWD,
    additionalDirectories: [],
    ...overrides,
  });
}

function expectHit(command: string, overrides?: Partial<DangerousRemovalOptions>) {
  const result = check(command, overrides);
  expect(result, `expected a hit for: ${command}`).not.toBeNull();
  expect(result!.reason.attribution.type).toBe('safetyCheck');
  if (result!.reason.attribution.type === 'safetyCheck') {
    expect(result!.reason.attribution.safetyCheckKind).toBe(DANGEROUS_REMOVAL_KIND);
    expect(result!.reason.attribution.bypassImmune).toBe(true);
    expect(result!.reason.attribution.classifierApprovable).toBe(true);
  }
  expect(result!.reason.decisionPoint).toBe(DANGEROUS_REMOVAL_DECISION_POINT);
  expect(result!.suggestions).toEqual([]);
  expect(result!.extra?.fillableByAllow).toBeUndefined();
  return result!;
}

function expectMiss(command: string, overrides?: Partial<DangerousRemovalOptions>) {
  const result = check(command, overrides);
  expect(result, `expected a miss for: ${command}`).toBeNull();
}

describe('checkDangerousRemoval', () => {
  describe('critical system paths', () => {
    it.each([
      'rm -rf /',
      'rm -rf ~',
      'rm -rf /Users',
      'rm -rf /tmp',
      'rm /',
      'rm ~',
      'rm -rf ~/',
      `rm -rf ${homedir()}`,
    ])('asks for %s', (command) => {
      const hit = expectHit(command);
      expect(hit.reason.message).toContain('critical system directory');
    });

    it('recognises the home directory by its real path', () => {
      const homeCanonical = path.resolve(homedir());
      expect(isCriticalPath(homeCanonical)).toBe(true);
      expect(isCriticalPath(homeCanonical + '/')).toBe(true);
    });

    it('does not flag directories below the top level', () => {
      expectMiss('rm -rf /usr/local');
      expectMiss('rm -rf /tmp/scratch');
      expectMiss('rm ~/notes.txt');
      expectMiss('rm -rf ~/.cache/foo');
    });
  });

  describe('workspace paths', () => {
    it.each(['rm -rf .', 'rm -rf ..', `rm -rf ${CWD}`, `rm -rf ${CWD}/`, 'rm -rf /srv/work', 'rm -rf *'])(
      'asks for %s',
      (command) => {
        const hit = expectHit(command);
        expect(hit.reason.message).toContain('workspace directory');
      },
    );

    it('covers additional working directories and their ancestors, glob or not', () => {
      const opts = { additionalDirectories: ['/other/lib'] };
      expectHit('rm -rf /other/lib', opts);
      expectHit('rm -rf /other/lib/*', opts);
      expectHit('rm -rf /other', opts);
      expectMiss('rm -rf /other/lib/dist', opts);
    });

    it('judges relative targets against the execution cwd, containment against the boundary', () => {
      // dir_path: .. — the removal runs in the parent, which is an ancestor.
      expectHit('rm -rf .', { executionCwd: '/srv/work', permissionCwd: CWD });
      // dir_path: ../sibling — a sibling is nobody's ancestor.
      expectMiss('rm -rf .', { executionCwd: '/srv/work/sibling', permissionCwd: CWD });
    });

    it('does not flag ordinary subdirectories or siblings', () => {
      expectMiss('rm -rf ./build');
      expectMiss('rm -rf build/*');
      expectMiss('rm -rf ../sibling');
      expectMiss('rm file.txt');
      expectMiss('rm -rf build/*.o');
      expectMiss('rm -rf a b -v');
      expectMiss('rm -- -x');
    });

    it('skips workspace containment when there is no boundary, keeps critical paths', () => {
      expectMiss('rm -rf .', { executionCwd: undefined, permissionCwd: undefined });
      expectHit('rm -rf ~', { executionCwd: undefined, permissionCwd: undefined });
    });

    it('follows a symlink to the workspace', () => {
      const root = mkdtempSync(path.join(tmpdir(), 'dangerous-removal-'));
      try {
        const workspace = path.join(root, 'ws');
        mkdirSync(workspace);
        const link = path.join(root, 'link');
        symlinkSync(workspace, link);
        expectHit(`rm -rf ${link}`, { executionCwd: workspace, permissionCwd: workspace });
        expectMiss(`rm -rf ${path.join(root, 'missing')}`, {
          executionCwd: workspace,
          permissionCwd: workspace,
        });
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    });
  });

  describe('possibly-empty variables', () => {
    it.each([
      'rm -rf $UNSET/*',
      'rm -rf "$DIR"/',
      'rm -rf ${DIR:-}/',
      'rm -rf ${DIR:-}/*',
      'rm -rf /$UNSET',
      'rm -rf ${DIR:-/}',
      'rm -rf $1/',
      'rm -rf "$@"/',
    ])('asks for %s', (command) => {
      expectHit(command);
    });

    it('treats a non-empty literal default as the target', () => {
      expectMiss('rm -rf ${DIR:-/tmp/x}');
      expectHit('rm -rf ${DIR:-/tmp}');
    });

    it('treats a variable followed by a real path as opaque', () => {
      expectMiss('rm -rf $HOME/.cache');
      expectMiss('rm -rf ${DIR:-}/x');
      expectMiss('rm -rf $OUT/build');
      expectMiss('rm -rf $UNSET');
      expectMiss('rm -rf build/$NAME');
      expectMiss('rm -rf ~/$UNSET');
      expectMiss('rm -rf /$UNSET/x');
    });

    it('does not treat positional parameters as empty when the script sets them', () => {
      expectMiss('set -- /tmp/x; rm -rf $1/');
      expectMiss('f() { rm -rf $1/; }; f /tmp/x');
    });
  });

  describe('wrappers, interpreters and substitutions', () => {
    it.each([
      'sudo rm -rf /',
      'sudo -u root rm -rf ~',
      'env -i rm -rf ~',
      'nohup timeout 5 rm -rf .',
      '/bin/rm -rf ~',
      '\\rm -rf /',
      'FOO=1 rm -rf /',
      'busybox rm -rf /',
      'eval "rm -rf $X/*"',
      'eval rm -rf /',
      'watch "rm -rf /"',
      'xargs -n1 rm -rf /',
    ])('asks for %s', (command) => {
      expectHit(command);
    });

    it.each([
      'sh -c "rm -rf $HOME/*"',
      "sh -c 'rm -rf /'",
      "sh -c 'echo $(rm -rf /)'",
      'echo $(rm -rf ~)',
      'echo `rm -rf /`',
      'find /tmp -exec rm -rf $X/ \\;',
      'find . -name x -exec rm -rf / \\;',
    ])('asks for nested %s', (command) => {
      expectHit(command);
    });

    it('does not flag ordinary find -exec or stdin-fed removals', () => {
      expectMiss("find . -name '*.o' -exec rm -rf {} \\;");
      expectMiss('xargs rm -rf');
      expectMiss('printf / | xargs rm -rf');
    });

    it('handles the parser cold start by scanning the raw text', () => {
      const command = 'echo "$(rm -rf /)"';
      const analysis = analyzeShellCommand(command);
      const result = checkDangerousRemoval(
        command,
        { ...analysis, hasParserSegments: false, executableSegments: [...analysis.topLevelSegments] },
        { executionCwd: CWD, permissionCwd: CWD, additionalDirectories: [] },
      );
      expect(result).not.toBeNull();
    });

    it('refuses a command with too many substitutions to analyse', () => {
      const many = Array.from({ length: 65 }, (_, i) => `$(echo ${i})`).join(' ');
      const hit = expectHit(`rm -rf ${many}`);
      expect(hit.reason.message).toContain('too many');
      expectMiss(`echo ${many}`);
    });
  });

  describe('statically unresolvable targets', () => {
    it.each([
      'cd /tmp && rm -rf *',
      'cd build && rm -rf ./*',
      'rm -rf build/*/*',
      'rm -rf */dist/*',
      'rm -rf ../*',
      'rm -rf */',
      'rm -rf ~user',
      'rm -rf $(pwd)/x',
    ])('asks for %s', (command) => {
      expectHit(command);
    });

    it('does not track cd for non-glob targets (known miss, by design)', () => {
      expectMiss('cd / && rm -rf tmp');
      expectMiss('cd sub && rm -rf node_modules');
      // Removes the workspace at runtime; resolved against cwd it is a child.
      expectMiss('cd .. && rm -rf project/');
    });

    it('rmdir -p judges every ancestor', () => {
      expectHit(`rmdir -p ${CWD}/empty/child`);
      expectMiss(`rmdir ${CWD}/empty/child`);
    });
  });

  describe('non-removal commands', () => {
    it('ignores commands without rm', () => {
      expectMiss('ls -la /');
      expectMiss('echo rm');
      expectMiss('git rm --cached file');
      expectMiss('npm run remove');
    });
  });

  describe('path predicates', () => {
    it('isSameOrAncestor', () => {
      expect(isSameOrAncestor('/a/b', '/a/b')).toBe(true);
      expect(isSameOrAncestor('/a/b/', '/a/b')).toBe(true);
      expect(isSameOrAncestor('/a', '/a/b')).toBe(true);
      expect(isSameOrAncestor('/', '/a/b')).toBe(true);
      expect(isSameOrAncestor('/a/b/c', '/a/b')).toBe(false);
      expect(isSameOrAncestor('/a/c', '/a/b')).toBe(false);
      expect(isSameOrAncestor('/private/tmp/x', '/tmp/x')).toBe(true);
    });

    it('isCriticalPath', () => {
      expect(isCriticalPath('/')).toBe(true);
      expect(isCriticalPath('/etc')).toBe(true);
      expect(isCriticalPath('/private/etc')).toBe(true);
      expect(isCriticalPath('C:\\')).toBe(true);
      expect(isCriticalPath('C:\\Windows')).toBe(true);
      expect(isCriticalPath('/etc/hosts')).toBe(false);
      expect(isCriticalPath('/srv/work/project')).toBe(false);
    });
  });
});
