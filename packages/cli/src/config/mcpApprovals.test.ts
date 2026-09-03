/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

// @vitest-environment node

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { MCPServerConfig } from '@qwen-code/qwen-code-core';
import { hashMcpServerConfig } from '@qwen-code/qwen-code-core';
import {
  loadMcpApprovals,
  getPendingGatedMcpServers,
  getPromptableMcpServers,
  resetMcpApprovalsForTesting,
  MCP_APPROVALS_FILENAME,
} from './mcpApprovals.js';

describe('mcpApprovals (hash-bound approval store)', () => {
  let dir: string;
  const projectRoot = '/work/my-repo';
  const server: MCPServerConfig = {
    command: 'node',
    args: ['server.js'],
    scope: 'project',
  };

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-approvals-'));
    process.env['QWEN_CODE_MCP_APPROVALS_PATH'] = path.join(
      dir,
      MCP_APPROVALS_FILENAME,
    );
    resetMcpApprovalsForTesting();
  });

  afterEach(() => {
    delete process.env['QWEN_CODE_MCP_APPROVALS_PATH'];
    resetMcpApprovalsForTesting();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  /** Keys are stored case-folded on win32 (issue #9775), verbatim elsewhere. */
  const expectedStoredKey = (p: string) =>
    os.platform() === 'win32' ? path.resolve(p).toLowerCase() : path.resolve(p);

  it('is pending with no stored decision', () => {
    const approvals = loadMcpApprovals();
    expect(approvals.getState(projectRoot, 'slack', server)).toBe('pending');
  });

  it('returns approved after approval', async () => {
    const approvals = loadMcpApprovals();
    await approvals.setState(projectRoot, 'slack', server, 'approved');
    expect(approvals.getState(projectRoot, 'slack', server)).toBe('approved');
  });

  it('returns rejected after rejection', async () => {
    const approvals = loadMcpApprovals();
    await approvals.setState(projectRoot, 'slack', server, 'rejected');
    expect(approvals.getState(projectRoot, 'slack', server)).toBe('rejected');
  });

  it('persists decisions across reload', async () => {
    await loadMcpApprovals().setState(projectRoot, 'slack', server, 'approved');
    resetMcpApprovalsForTesting();
    expect(loadMcpApprovals().getState(projectRoot, 'slack', server)).toBe(
      'approved',
    );
  });

  it('writes the file with the documented shape', async () => {
    await loadMcpApprovals().setState(projectRoot, 'slack', server, 'approved');
    const onDisk = JSON.parse(
      fs.readFileSync(path.join(dir, MCP_APPROVALS_FILENAME), 'utf-8'),
    );
    const record = onDisk[expectedStoredKey(projectRoot)]['slack'];
    expect(record.status).toBe('approved');
    expect(record.hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it('persists decisions for server names that match object prototype keys', async () => {
    await loadMcpApprovals().setState(
      projectRoot,
      '__proto__',
      server,
      'approved',
    );

    const onDisk = JSON.parse(
      fs.readFileSync(path.join(dir, MCP_APPROVALS_FILENAME), 'utf-8'),
    );
    const projectRecord = onDisk[expectedStoredKey(projectRoot)];
    const record = Object.getOwnPropertyDescriptor(
      projectRecord,
      '__proto__',
    )?.value;

    expect(record.status).toBe('approved');
    resetMcpApprovalsForTesting();
    expect(loadMcpApprovals().getState(projectRoot, '__proto__', server)).toBe(
      'approved',
    );
  });

  it('recovers when a per-project approvals record is corrupted', async () => {
    const filePath = path.join(dir, MCP_APPROVALS_FILENAME);
    fs.writeFileSync(
      filePath,
      JSON.stringify({ [path.resolve(projectRoot)]: 'garbage' }),
    );
    const approvals = loadMcpApprovals();
    await expect(
      approvals.setState(projectRoot, 'slack', server, 'approved'),
    ).resolves.toBeUndefined();
    expect(approvals.getState(projectRoot, 'slack', server)).toBe('approved');
  });

  it('recovers when the approvals file is not a JSON object', () => {
    const filePath = path.join(dir, MCP_APPROVALS_FILENAME);
    fs.writeFileSync(filePath, '[1, 2, 3]');

    const approvals = loadMcpApprovals();

    expect(approvals.errors).toEqual([
      {
        message: 'MCP approvals file is not a valid JSON object.',
        path: filePath,
      },
    ]);
    expect(approvals.getState(projectRoot, 'slack', server)).toBe('pending');
  });

  it('recovers when the approvals file contains malformed JSON', () => {
    const filePath = path.join(dir, MCP_APPROVALS_FILENAME);
    fs.writeFileSync(filePath, '{bad json');

    const approvals = loadMcpApprovals();

    expect(approvals.errors).toHaveLength(1);
    expect(approvals.errors[0]?.path).toBe(filePath);
    expect(approvals.getState(projectRoot, 'slack', server)).toBe('pending');
  });

  describe('hash binding (the issue #4615 requirement)', () => {
    it('reverts to pending when the config changes after approval', async () => {
      const approvals = loadMcpApprovals();
      await approvals.setState(projectRoot, 'slack', server, 'approved');
      expect(approvals.getState(projectRoot, 'slack', server)).toBe('approved');

      // Same name, edited command — the user never reviewed this.
      const edited: MCPServerConfig = { ...server, command: 'curl' };
      expect(approvals.getState(projectRoot, 'slack', edited)).toBe('pending');
    });

    it('a rejected server also reverts to pending when edited', async () => {
      const approvals = loadMcpApprovals();
      await approvals.setState(projectRoot, 'slack', server, 'rejected');
      const edited: MCPServerConfig = { ...server, args: ['other.js'] };
      expect(approvals.getState(projectRoot, 'slack', edited)).toBe('pending');
    });

    it('ignores provenance-only changes (scope) — stays approved', async () => {
      const approvals = loadMcpApprovals();
      await approvals.setState(projectRoot, 'slack', server, 'approved');
      const sameBehavior: MCPServerConfig = {
        command: 'node',
        args: ['server.js'],
      };
      expect(approvals.getState(projectRoot, 'slack', sameBehavior)).toBe(
        'approved',
      );
    });
  });

  it('keeps decisions independent per project root', async () => {
    const approvals = loadMcpApprovals();
    await approvals.setState(projectRoot, 'slack', server, 'approved');
    expect(approvals.getState('/work/other-repo', 'slack', server)).toBe(
      'pending',
    );
  });

  // Windows paths are case-insensitive: the CLI stores `process.cwd()` as
  // typed while IDE integrations pass VS Code's lowercased `fsPath` (issue
  // #9775). These cases only apply where the filesystem folds case.
  const itOnWin32 = os.platform() === 'win32' ? it : it.skip;

  describe('win32 project-root casing (issue #9775)', () => {
    /** Same directory, drive-letter casing flipped (`C:\...` <-> `c:\...`). */
    function flipDriveCase(p: string): string {
      return p.charAt(0) === p.charAt(0).toUpperCase()
        ? p.charAt(0).toLowerCase() + p.slice(1)
        : p.charAt(0).toUpperCase() + p.slice(1);
    }

    /** Flip the case of the first alphabetic char after the drive prefix. */
    function flipFirstNonDriveChar(p: string): string {
      let i = /^[A-Za-z]:[\\/]/.test(p) ? 3 : 0;
      for (; i < p.length; i++) {
        const ch = p[i];
        if (/[A-Za-z]/.test(ch)) {
          return (
            p.slice(0, i) +
            (ch === ch.toUpperCase() ? ch.toLowerCase() : ch.toUpperCase()) +
            p.slice(i + 1)
          );
        }
      }
      return p;
    }

    itOnWin32('matches an approval across drive-letter casing', async () => {
      const approvals = loadMcpApprovals();
      await approvals.setState(dir, 'slack', server, 'approved');
      const variant = flipDriveCase(path.resolve(dir));
      expect(fs.existsSync(variant)).toBe(true);
      expect(approvals.getState(variant, 'slack', server)).toBe('approved');
    });

    itOnWin32(
      'matches an approval across non-drive directory-name casing',
      async () => {
        const approvals = loadMcpApprovals();
        await approvals.setState(dir, 'slack', server, 'approved');
        // Flip a component beyond the drive letter (e.g. Users <-> users). A
        // drive-letter-only fold would orphan this lookup and re-create the
        // invisible-approval bug class this PR fixes, so the fold must cover
        // the whole path.
        const resolvedDir = path.resolve(dir);
        const variant = flipFirstNonDriveChar(resolvedDir);
        expect(variant).not.toBe(resolvedDir);
        expect(fs.existsSync(variant)).toBe(true);
        expect(approvals.getState(variant, 'slack', server)).toBe('approved');
      },
    );

    itOnWin32('leaves foreign POSIX keys untouched at load time', async () => {
      const filePath = path.join(dir, MCP_APPROVALS_FILENAME);
      fs.writeFileSync(
        filePath,
        JSON.stringify({
          '/home/u/Projects/Foo': {
            slack: {
              hash: hashMcpServerConfig(server),
              status: 'approved',
            },
          },
        }),
      );
      resetMcpApprovalsForTesting();
      // A synced `~/.qwen` can carry Linux decisions; their case is
      // significant there, so they must round-trip verbatim.
      expect(Object.keys(loadMcpApprovals().file.config)).toEqual([
        '/home/u/Projects/Foo',
      ]);
    });

    itOnWin32(
      'a later approval cannot override an earlier rejection on merged keys',
      async () => {
        const resolvedDir = path.resolve(dir);
        fs.writeFileSync(
          path.join(dir, MCP_APPROVALS_FILENAME),
          JSON.stringify({
            [resolvedDir]: {
              slack: {
                hash: hashMcpServerConfig(server),
                status: 'rejected',
              },
            },
            [flipDriveCase(resolvedDir)]: {
              slack: {
                hash: hashMcpServerConfig(server),
                status: 'approved',
              },
            },
          }),
        );
        resetMcpApprovalsForTesting();
        // Records carry no timestamps and file order does not track recency;
        // the conservative merge keeps the rejection so a stale approval can
        // never auto-enable a gated server the user rejected.
        expect(loadMcpApprovals().getState(resolvedDir, 'slack', server)).toBe(
          'rejected',
        );
      },
    );

    itOnWin32(
      'matches decisions stored by older builds under legacy cased keys',
      async () => {
        const resolvedDir = path.resolve(dir);
        const filePath = path.join(dir, MCP_APPROVALS_FILENAME);
        fs.writeFileSync(
          filePath,
          JSON.stringify({
            [flipDriveCase(resolvedDir)]: {
              slack: {
                hash: hashMcpServerConfig(server),
                status: 'approved',
              },
            },
          }),
        );
        resetMcpApprovalsForTesting();
        expect(loadMcpApprovals().getState(resolvedDir, 'slack', server)).toBe(
          'approved',
        );
      },
    );

    itOnWin32(
      'merges duplicate-cased keys for the same project at load time',
      async () => {
        const resolvedDir = path.resolve(dir);
        const workspaceServer: MCPServerConfig = {
          command: 'node',
          args: ['ws.js'],
          scope: 'workspace',
        };
        fs.writeFileSync(
          path.join(dir, MCP_APPROVALS_FILENAME),
          JSON.stringify({
            [flipDriveCase(resolvedDir)]: {
              slack: {
                hash: hashMcpServerConfig(server),
                status: 'approved',
              },
            },
            [resolvedDir]: {
              ws: {
                hash: hashMcpServerConfig(workspaceServer),
                status: 'rejected',
              },
            },
          }),
        );
        resetMcpApprovalsForTesting();
        const approvals = loadMcpApprovals();
        expect(approvals.getState(resolvedDir, 'slack', server)).toBe(
          'approved',
        );
        expect(approvals.getState(resolvedDir, 'ws', workspaceServer)).toBe(
          'rejected',
        );
      },
    );

    itOnWin32(
      'keeps the rejection regardless of key order in the file',
      async () => {
        const resolvedDir = path.resolve(dir);
        fs.writeFileSync(
          path.join(dir, MCP_APPROVALS_FILENAME),
          JSON.stringify({
            [flipDriveCase(resolvedDir)]: {
              slack: {
                hash: hashMcpServerConfig(server),
                status: 'approved',
              },
            },
            [resolvedDir]: {
              slack: {
                hash: hashMcpServerConfig(server),
                status: 'rejected',
              },
            },
          }),
        );
        resetMcpApprovalsForTesting();
        // Mirror order of the previous merge case: the approval is written
        // under one casing and the later rejection appended under the other.
        // A keep-first merge would flip this to 'approved', auto-enabling a
        // gated server the user rejected.
        expect(loadMcpApprovals().getState(resolvedDir, 'slack', server)).toBe(
          'rejected',
        );
      },
    );

    itOnWin32(
      'skips a non-record value when merging case-collided keys',
      async () => {
        const resolvedDir = path.resolve(dir);
        const filePath = path.join(dir, MCP_APPROVALS_FILENAME);
        fs.writeFileSync(
          filePath,
          JSON.stringify({
            [resolvedDir]: {
              slack: {
                hash: hashMcpServerConfig(server),
                status: 'approved',
              },
            },
            [flipDriveCase(resolvedDir)]: {
              // A hand edit or sync corruption can write `null` where a
              // record belongs. The merge guard must skip it (rather than
              // dereference `record.status` and condemn the whole file); the
              // valid decision under the other casing must survive.
              slack: null,
            },
          }),
        );
        resetMcpApprovalsForTesting();
        const approvals = loadMcpApprovals();
        expect(approvals.errors).toEqual([]);
        expect(approvals.getState(resolvedDir, 'slack', server)).toBe(
          'approved',
        );
      },
    );

    itOnWin32('folds legacy UNC keys at load time', async () => {
      const filePath = path.join(dir, MCP_APPROVALS_FILENAME);
      fs.writeFileSync(
        filePath,
        JSON.stringify({
          '\\\\FS01\\Share\\proj': {
            slack: {
              hash: hashMcpServerConfig(server),
              status: 'approved',
            },
          },
        }),
      );
      resetMcpApprovalsForTesting();
      // The load-time key fold covers UNC paths too (`\\server\share`), so a
      // network-share project approved under one casing resolves under the
      // other. Deleting the UNC branch leaves this invisible again.
      expect(
        loadMcpApprovals().getState('\\\\fs01\\share\\proj', 'slack', server),
      ).toBe('approved');
    });

    itOnWin32(
      'keeps a __proto__ server decision when merging duplicate-cased keys',
      async () => {
        const resolvedDir = path.resolve(dir);
        const filePath = path.join(dir, MCP_APPROVALS_FILENAME);
        fs.writeFileSync(
          filePath,
          JSON.stringify({
            [resolvedDir]: {
              alpha: {
                hash: hashMcpServerConfig(server),
                status: 'approved',
              },
            },
            [flipDriveCase(resolvedDir)]: {
              // Computed key (not the literal `__proto__:` form, which would
              // set the prototype instead of an own property).
              ['__proto__']: {
                hash: hashMcpServerConfig(server),
                status: 'rejected',
              },
            },
          }),
        );
        resetMcpApprovalsForTesting();
        const approvals = loadMcpApprovals();
        // The __proto__ decision must survive the merge as an own property
        // rather than being written onto the prototype and dropped by
        // JSON.stringify on the next save.
        expect(approvals.getState(resolvedDir, '__proto__', server)).toBe(
          'rejected',
        );
        const projectRecord = approvals.file.config[resolvedDir.toLowerCase()];
        expect(
          Object.getOwnPropertyDescriptor(projectRecord, '__proto__'),
        ).toBeDefined();
        expect(Object.keys(projectRecord)).toContain('__proto__');
      },
    );

    itOnWin32(
      'rewrites migrated keys in normalized form on the next save',
      async () => {
        const resolvedDir = path.resolve(dir);
        const workspaceServer: MCPServerConfig = {
          command: 'node',
          args: ['ws.js'],
          scope: 'workspace',
        };
        const filePath = path.join(dir, MCP_APPROVALS_FILENAME);
        fs.writeFileSync(
          filePath,
          JSON.stringify({
            [flipDriveCase(resolvedDir)]: {
              slack: {
                hash: hashMcpServerConfig(server),
                status: 'approved',
              },
            },
          }),
        );
        resetMcpApprovalsForTesting();
        await loadMcpApprovals().setState(
          resolvedDir,
          'ws',
          workspaceServer,
          'approved',
        );
        const onDisk = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
        expect(Object.keys(onDisk)).toEqual([resolvedDir.toLowerCase()]);
        expect(Object.keys(onDisk[resolvedDir.toLowerCase()]).sort()).toEqual([
          'slack',
          'ws',
        ]);
      },
    );
  });

  describe('getPendingGatedMcpServers (gated-scope filter)', () => {
    const workspaceServer: MCPServerConfig = {
      command: 'node',
      args: ['ws.js'],
      scope: 'workspace',
    };
    const systemServer: MCPServerConfig = {
      command: 'node',
      args: ['sys.js'],
      scope: 'system',
    };
    const userServer: MCPServerConfig = { command: 'node', args: ['user.js'] };

    it('gates both project and workspace servers, ignores user/system', () => {
      const pending = getPendingGatedMcpServers(
        {
          proj: server,
          ws: workspaceServer,
          sys: systemServer,
          usr: userServer,
        },
        projectRoot,
      );
      expect(pending.sort()).toEqual(['proj', 'ws']);
    });

    it('drops a gated server once it is approved', async () => {
      await loadMcpApprovals().setState(
        projectRoot,
        'ws',
        workspaceServer,
        'approved',
      );
      const pending = getPendingGatedMcpServers(
        { ws: workspaceServer },
        projectRoot,
      );
      expect(pending).toEqual([]);
    });

    it('keeps a rejected gated server in the pending (skip) set', async () => {
      await loadMcpApprovals().setState(
        projectRoot,
        'ws',
        workspaceServer,
        'rejected',
      );
      const pending = getPendingGatedMcpServers(
        { ws: workspaceServer },
        projectRoot,
      );
      expect(pending).toEqual(['ws']);
    });
  });

  describe('getPromptableMcpServers (strict-pending, drives the dialog)', () => {
    const workspaceServer: MCPServerConfig = {
      command: 'node',
      args: ['ws.js'],
      scope: 'workspace',
    };
    const userServer: MCPServerConfig = { command: 'node', args: ['user.js'] };

    it('prompts gated servers with no stored decision, ignores user scope', () => {
      const promptable = getPromptableMcpServers(
        { proj: server, ws: workspaceServer, usr: userServer },
        projectRoot,
      );
      expect(promptable.sort()).toEqual(['proj', 'ws']);
    });

    it('does NOT prompt a rejected server (unlike getPendingGatedMcpServers)', async () => {
      await loadMcpApprovals().setState(
        projectRoot,
        'ws',
        workspaceServer,
        'rejected',
      );
      // Same config hash as the rejection ⇒ stays rejected ⇒ not promptable,
      // yet still in the gating skip set.
      expect(
        getPromptableMcpServers({ ws: workspaceServer }, projectRoot),
      ).toEqual([]);
      expect(
        getPendingGatedMcpServers({ ws: workspaceServer }, projectRoot),
      ).toEqual(['ws']);
    });

    it('re-prompts a rejected server once an edit changes its config hash', async () => {
      await loadMcpApprovals().setState(
        projectRoot,
        'ws',
        workspaceServer,
        'rejected',
      );
      const edited: MCPServerConfig = {
        ...workspaceServer,
        args: ['ws-v2.js'],
      };
      expect(getPromptableMcpServers({ ws: edited }, projectRoot)).toEqual([
        'ws',
      ]);
    });

    it('does NOT prompt an approved server', async () => {
      await loadMcpApprovals().setState(
        projectRoot,
        'ws',
        workspaceServer,
        'approved',
      );
      expect(
        getPromptableMcpServers({ ws: workspaceServer }, projectRoot),
      ).toEqual([]);
    });
  });
});
