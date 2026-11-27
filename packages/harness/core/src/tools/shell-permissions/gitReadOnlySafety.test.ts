/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { checkReadOnlyShellCommand } from './shellReadOnlyValidation.js';
import {
  gitReadOnlyContextReason,
  type ShellReadOnlyContext,
} from './gitReadOnlySafety.js';
import { createShellToolChecker } from '../tool-checkers/checkers/bash-checker.js';
import {
  PermissionModes,
  rulesForToolName,
  type PermissionRules,
} from '../../permissions/manager/decision/index.js';

describe('Git read-only context', () => {
  let root: string;
  let cwd: string;
  let context: ShellReadOnlyContext;

  function repository(directory: string) {
    fs.mkdirSync(path.join(directory, '.git', 'objects'), { recursive: true });
    fs.mkdirSync(path.join(directory, '.git', 'refs'));
    fs.writeFileSync(
      path.join(directory, '.git', 'HEAD'),
      'ref: refs/heads/main\n',
    );
  }

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'git-readonly-'));
    cwd = path.join(root, 'project');
    fs.mkdirSync(cwd);
    context = { cwd };
  });
  afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

  function permission(
    command: string,
    input: Record<string, unknown> = {},
    allow = false,
  ) {
    const rules: PermissionRules = {
      allow: allow ? { userSettings: ['Bash(git:*)'] } : {},
      deny: {},
      ask: {},
    };
    return createShellToolChecker('Bash', () => context).check(
      { ...input, command },
      {
        cwd,
        mode: PermissionModes.Default,
        rules,
        rulesForTool: rulesForToolName(rules, 'Bash'),
        additionalDirectories: [],
        toolUseId: 'git-check',
      },
    );
  }

  it('shares Git context guards with permission auto-allow without overriding explicit rules', async () => {
    expect((await permission('git diff')).kind).toBe('allow');
    fs.writeFileSync(path.join(cwd, 'HEAD'), 'ref: refs/heads/main\n');
    expect((await permission('git diff')).kind).not.toBe('allow');
    expect((await permission('git diff', {}, true)).kind).toBe('allow');
  });

  it('normalizes symlink cwd spellings', () => {
    const alias = path.join(root, 'alias');
    fs.symlinkSync(cwd, alias, 'junction');
    expect(
      gitReadOnlyContextReason({
        ...context,
        cwd: alias,
      }),
    ).toBeUndefined();
  });

  it('checks actual ancestors when the execution directory is a symlink', () => {
    fs.writeFileSync(path.join(cwd, 'HEAD'), 'ref: refs/heads/main\n');
    const nested = path.join(cwd, 'src');
    fs.mkdirSync(nested);
    const alias = path.join(root, 'alias');
    fs.symlinkSync(nested, alias, 'junction');
    expect(gitReadOnlyContextReason({ ...context, cwd: alias })).toContain(
      'Bare repository',
    );
  });

  it('allows normal repositories and their subdirectories', () => {
    repository(cwd);
    const nested = path.join(cwd, 'src');
    fs.mkdirSync(nested);
    for (const directory of [cwd, nested]) {
      for (const command of [
        'git diff',
        'git show HEAD',
        'git status --short',
      ]) {
        expect(
          checkReadOnlyShellCommand(command, undefined, {
            ...context,
            cwd: directory,
          }).readonly,
        ).toBe(true);
      }
    }
  });

  it.each(['HEAD', 'objects', 'refs'])(
    'rejects bare-repository indicator %s, including in ancestors',
    (name) => {
      fs.writeFileSync(path.join(cwd, name), 'indicator');
      const nested = path.join(cwd, 'src');
      fs.mkdirSync(nested);
      for (const directory of [cwd, nested]) {
        expect(
          gitReadOnlyContextReason({ ...context, cwd: directory }),
        ).toContain('Bare repository');
      }
    },
  );

  it('does not interpret normal tracked names as bare metadata in a valid repository', () => {
    repository(cwd);
    fs.writeFileSync(path.join(cwd, 'HEAD'), 'a tracked file');
    expect(gitReadOnlyContextReason(context)).toBeUndefined();
  });

  it.each(['pointer', 'symlink'])(
    'rejects a planted .git %s inside the working tree',
    (kind) => {
      const target = path.join(cwd, 'planted', '.git');
      fs.mkdirSync(target, { recursive: true });
      fs.writeFileSync(path.join(target, 'HEAD'), 'ref: refs/heads/main\n');
      if (kind === 'pointer')
        fs.writeFileSync(path.join(cwd, '.git'), 'gitdir: planted/.git\n');
      else fs.symlinkSync(target, path.join(cwd, '.git'), 'junction');
      expect(gitReadOnlyContextReason(context)).toContain('redirection');
    },
  );

  it('allows a linked worktree pointer into an external .git directory', () => {
    const target = path.join(root, 'main', '.git', 'worktrees', 'project');
    fs.mkdirSync(target, { recursive: true });
    fs.writeFileSync(path.join(target, 'HEAD'), 'ref: refs/heads/main\n');
    fs.writeFileSync(path.join(cwd, '.git'), `gitdir: ${target}\n`);
    expect(gitReadOnlyContextReason(context)).toBeUndefined();
  });

  it('rejects a pointer to an external directory without a .git component', () => {
    const target = path.join(root, 'bare');
    fs.mkdirSync(target);
    fs.writeFileSync(path.join(target, 'HEAD'), 'ref: refs/heads/main\n');
    fs.writeFileSync(path.join(cwd, '.git'), `gitdir: ${target}\n`);
    expect(gitReadOnlyContextReason(context)).toContain('redirection');
  });

  it.each([
    'gitdir: missing\n',
    'gitdir: /net/untrusted/repo\n',
    'x'.repeat(4097),
  ])('rejects unverifiable gitdir data', (text) => {
    fs.writeFileSync(path.join(cwd, '.git'), text);
    expect(gitReadOnlyContextReason(context)).toBeDefined();
  });

  it('rejects a dangling .git symlink', () => {
    fs.symlinkSync(
      path.join(root, 'missing'),
      path.join(cwd, '.git'),
      'junction',
    );
    expect(gitReadOnlyContextReason(context)).toContain('redirection');
  });

  it('keeps cd plus Git behind permission checks without misreading quoted arguments', () => {
    expect(
      checkReadOnlyShellCommand('cd src && git diff', undefined, context)
        .readonly,
    ).toBe(false);
    expect(
      checkReadOnlyShellCommand('echo git && pwd', undefined, {
        ...context,
        cwd: '/missing',
      }).readonly,
    ).toBe(true);
  });
});
