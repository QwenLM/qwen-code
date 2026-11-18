/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import { evaluatePermissionRules } from '../core/permission-helpers.js';
import { PermissionManager } from './permission-manager.js';
import { extractShellOperationsAcrossCommand } from './shell-semantics.js';

const quote = (text: string) => `'${text.replaceAll("'", "'\\''")}'`;
const branches = Array.from(
  { length: 7 },
  (_, index) => `cd part${index} || true`,
).join('; ');
const managerWithDeny = (rule: string) => {
  const manager = new PermissionManager({
    getPermissionsAllow: () => ['Bash(*)'],
    getPermissionsAsk: () => [],
    getPermissionsDeny: () => [rule],
    getProjectRoot: () => '/project',
    getCwd: () => '/project',
    getShellExecutionSandbox: () => true,
  });
  manager.initialize();
  return manager;
};

describe('bounded working-directory alternatives', () => {
  it('keeps 64 candidates and forces confirmation for an omitted relative target', async () => {
    const command = `${branches}; echo x > protected`;
    const operations = extractShellOperationsAcrossCommand(command, '/project');
    expect(operations).toHaveLength(64);
    expect(
      new Set(operations.map((operation) => operation.filePath)).size,
    ).toBe(64);
    expect(
      operations.every(
        (operation) => operation.cwdUnknown && operation.pathMayDependOnCwd,
      ),
    ).toBe(true);

    // Each cd can independently succeed or fail: all 128 subsets are reachable.
    const reachable = Array.from({ length: 128 }, (_, mask) =>
      [
        '/project',
        ...Array.from({ length: 7 }, (_, index) => index)
          .filter((index) => mask & (1 << index))
          .map((index) => `part${index}`),
        'protected',
      ].join('/'),
    );
    const omitted = reachable.find(
      (filePath) =>
        !operations.some((operation) => operation.filePath === filePath),
    );
    expect(omitted).toBeDefined();
    const manager = managerWithDeny(`Edit(/${omitted!})`);
    for (const toolName of ['run_shell_command', 'monitor']) {
      expect(
        await evaluatePermissionRules(manager, 'allow', { toolName, command }),
      ).toEqual({
        finalPermission: 'ask',
        pmForcedAsk: true,
      });
    }
  });

  it('rebuilds a precise directory after a successful absolute cd', () => {
    expect(
      extractShellOperationsAcrossCommand(
        `${branches}; cd /known && echo x > protected`,
        '/project',
      ),
    ).toEqual([{ virtualTool: 'write_file', filePath: '/known/protected' }]);
  });

  it('bounds alternatives together across child-shell nesting', () => {
    const command = `${branches}; bash -c ${quote(`${branches}; echo x > protected`)}`;
    expect(
      extractShellOperationsAcrossCommand(command, '/project'),
    ).toHaveLength(64);
  });

  it('deduplicates alternatives without removing later repeated effects', () => {
    const operations = extractShellOperationsAcrossCommand(
      'cd child || true; echo a > /tmp/one; echo b > /tmp/two; echo a > /tmp/one',
      '/project',
    );
    expect(operations.map((operation) => operation.filePath)).toEqual([
      '/tmp/one',
      '/tmp/two',
      '/tmp/one',
    ]);
  });

  it('preserves all candidate effects in inner command order', () => {
    const operations = extractShellOperationsAcrossCommand(
      "cd child || true; bash -c 'echo a > one; echo b > two'",
      '/project',
    );
    expect(operations.map((operation) => operation.filePath)).toEqual([
      '/project/one',
      '/project/child/one',
      '/project/two',
      '/project/child/two',
    ]);
  });
});

describe('heredoc header quote boundaries', () => {
  it('does not join a quote inside a header comment to the body', () => {
    const command =
      "cat <<EOF # this isn't a quote\necho body > /tmp/protected\nEOF\ntrue";
    expect(
      extractShellOperationsAcrossCommand(command, '/project'),
    ).not.toEqual(
      expect.arrayContaining([
        expect.objectContaining({ filePath: '/tmp/protected' }),
      ]),
    );
  });

  it('keeps an escaped quote inside a multiline ANSI-C header word', () => {
    const command = "cat <<EOF $'abc\\'\ndef' > /tmp/protected\nbody\nEOF";
    expect(extractShellOperationsAcrossCommand(command, '/project')).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          virtualTool: 'write_file',
          filePath: '/tmp/protected',
        }),
      ]),
    );
  });
});

describe('static env argv at the wrapper limit', () => {
  it.each([
    `printf %s ${quote('cat /etc/shadow')}`,
    `printf %s ${quote('literal > /etc/shadow')}`,
    `env -S ${quote('cat /etc/shadow')}`,
  ])('keeps literal data and deeper env payloads unexecuted: %s', (payload) => {
    let command = `env -S ${quote(payload)}`;
    for (let depth = 0; depth < 4; depth++)
      command = `bash -c ${quote(command)}`;
    expect(extractShellOperationsAcrossCommand(command, '/project')).toEqual(
      [],
    );
  });
});

describe('literal mapfile callbacks', () => {
  it.each([
    "mapfile -C 'cat /etc/shadow' -c 1",
    "readarray -C'cat /etc/shadow' -c 1",
    "builtin mapfile -C 'cat /etc/shadow' -c 1",
    "mapfile -C 'printf first' -C 'cat /etc/shadow' -c 1",
  ])('retains the callback read and deny in %s', async (command) => {
    expect(extractShellOperationsAcrossCommand(command, '/project')).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          virtualTool: 'read_file',
          filePath: '/etc/shadow',
        }),
      ]),
    );
    const manager = managerWithDeny('Read(//etc/shadow)');
    expect(
      await evaluatePermissionRules(manager, 'allow', {
        toolName: 'run_shell_command',
        command,
      }),
    ).toEqual({
      finalPermission: 'deny',
      pmForcedAsk: false,
    });
  });

  it('inspects the callback from each reachable directory', () => {
    const command = "cd /tmp || true; mapfile -C 'cat protected' -c 1";
    expect(extractShellOperationsAcrossCommand(command, '/project')).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          virtualTool: 'read_file',
          filePath: '/project/protected',
        }),
        expect.objectContaining({
          virtualTool: 'read_file',
          filePath: '/tmp/protected',
        }),
      ]),
    );
  });

  it('does not unwrap another callback at the shell depth limit', async () => {
    let command = "mapfile -C 'cat /etc/shadow' -c 1";
    for (let depth = 0; depth < 4; depth++)
      command = `bash -c ${quote(command)}`;
    expect(extractShellOperationsAcrossCommand(command, '/project')).toEqual(
      [],
    );
    const manager = managerWithDeny('Read(//etc/shadow)');
    expect(
      await evaluatePermissionRules(manager, 'allow', {
        toolName: 'run_shell_command',
        command,
      }),
    ).toEqual({
      finalPermission: 'ask',
      pmForcedAsk: true,
    });
  });
});

describe('find execution shares the analysis bounds', () => {
  const findCommand = (depth: number) => {
    let command = 'find . -exec cat /tmp/qwen-depth-probe/protected \\;';
    for (let level = 0; level < depth; level++)
      command = `bash -c ${quote(command)}`;
    return command;
  };

  it('caps nested find writes without dropping ordinary directory operations', () => {
    const fourBranches = Array.from(
      { length: 4 },
      (_, index) => `cd part${index} || true`,
    ).join('; ');
    const inner = `${fourBranches}; echo marker > protected`;
    const command = `${fourBranches}; find . -exec bash -c ${quote(inner)} \\;`;
    const operations = extractShellOperationsAcrossCommand(command, '/project');
    expect(
      operations.filter(
        (operation) => operation.virtualTool === 'list_directory',
      ),
    ).toHaveLength(16);
    const writes = operations.filter(
      (operation) => operation.virtualTool === 'write_file',
    );
    expect(writes).toHaveLength(64);
    expect(new Set(writes.map((operation) => operation.filePath)).size).toBe(
      64,
    );
    expect(
      writes.every(
        (operation) => operation.cwdUnknown && operation.pathMayDependOnCwd,
      ),
    ).toBe(true);
  });

  it('preserves inner command order across cwd alternatives and repeated clauses', () => {
    const command =
      'cd child || true; find . -exec cat one \\; -exec cat two \\; -exec cat one \\;';
    const operations = extractShellOperationsAcrossCommand(command, '/project');
    expect(
      operations
        .filter((operation) => operation.virtualTool === 'read_file')
        .map((operation) => operation.filePath),
    ).toEqual([
      '/project/one',
      '/project/child/one',
      '/project/two',
      '/project/child/two',
      '/project/one',
      '/project/child/one',
    ]);
  });

  it.each(['-execdir', '-okdir'])(
    'keeps the %s execution directory unknown',
    (marker) => {
      expect(
        extractShellOperationsAcrossCommand(
          `find /tmp ${marker} cat protected \\;`,
          '/project',
        ),
      ).toEqual([
        { virtualTool: 'list_directory', filePath: '/tmp' },
        {
          virtualTool: 'read_file',
          filePath: '/project/protected',
          cwdUnknown: true,
          pathMayDependOnCwd: true,
        },
      ]);
    },
  );

  it('keeps the known read and raw-shell deny before the shared depth limit', async () => {
    const command = findCommand(3);
    expect(extractShellOperationsAcrossCommand(command, '/project')).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          virtualTool: 'read_file',
          filePath: '/tmp/qwen-depth-probe/protected',
        }),
      ]),
    );
    const manager = managerWithDeny('Read(//tmp/qwen-depth-probe/protected)');
    expect(
      await evaluatePermissionRules(manager, 'allow', {
        toolName: 'run_shell_command',
        command,
      }),
    ).toEqual({ finalPermission: 'deny', pmForcedAsk: false });
    // Monitor's existing reconstruction of this deeply quoted command stays
    // conservative; the shared bound must not turn its confirmation into allow.
    expect(
      await evaluatePermissionRules(manager, 'allow', {
        toolName: 'monitor',
        command,
      }),
    ).toEqual({ finalPermission: 'ask', pmForcedAsk: true });
  });

  it('does not reset the depth limit or silently grant the unexpanded payload', async () => {
    const command = findCommand(4);
    expect(extractShellOperationsAcrossCommand(command, '/project')).toEqual([
      { virtualTool: 'list_directory', filePath: '/project' },
    ]);
    const manager = managerWithDeny('Read(//tmp/qwen-depth-probe/protected)');
    for (const toolName of ['run_shell_command', 'monitor']) {
      expect(
        await evaluatePermissionRules(manager, 'allow', { toolName, command }),
      ).toEqual({ finalPermission: 'ask', pmForcedAsk: true });
    }
  });

  it('keeps an ordinary find without execution clauses grantable', async () => {
    const command = 'find /tmp -type f -name protected';
    const manager = managerWithDeny('Read(//tmp/qwen-depth-probe/protected)');
    expect(extractShellOperationsAcrossCommand(command, '/project')).toEqual([
      { virtualTool: 'list_directory', filePath: '/tmp' },
    ]);
    expect(
      await evaluatePermissionRules(manager, 'allow', {
        toolName: 'run_shell_command',
        command,
      }),
    ).toEqual({ finalPermission: 'allow', pmForcedAsk: false });
  });
});
