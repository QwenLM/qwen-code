/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

const mockWriteStdoutLine = vi.hoisted(() => vi.fn());
vi.mock('../../utils/stdioHelpers.js', () => ({
  writeStdoutLine: mockWriteStdoutLine,
  writeStderrLine: vi.fn(),
  clearScreen: vi.fn(),
}));

import { approveCommand, rejectCommand } from './approve.js';
import {
  loadMcpApprovals,
  resetMcpApprovalsForTesting,
  MCP_APPROVALS_FILENAME,
} from '../../config/mcpApprovals.js';
import { loadProjectMcpServers } from '../../config/mcpJson.js';
import {
  buildWorkspaceEnvSnapshot,
  resetEnvironmentTrackingForTesting,
} from '../../config/environment.js';
import { loadSettings } from '../../config/settings.js';

describe('qwen mcp approve / reject', () => {
  let dir: string;
  let cwdSpy: ReturnType<typeof vi.spyOn>;

  const output = () =>
    mockWriteStdoutLine.mock.calls.map((c) => c[0]).join('\n');

  const run = async (
    cmd: typeof approveCommand,
    argv: Record<string, unknown>,
  ) => {
    await (cmd.handler as (a: Record<string, unknown>) => Promise<void>)({
      _: [],
      $0: 'qwen',
      ...argv,
    });
  };

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-approve-'));
    process.env['QWEN_CODE_MCP_APPROVALS_PATH'] = path.join(
      dir,
      MCP_APPROVALS_FILENAME,
    );
    resetMcpApprovalsForTesting();
    cwdSpy = vi.spyOn(process, 'cwd').mockReturnValue(dir);
    mockWriteStdoutLine.mockClear();
  });

  afterEach(() => {
    delete process.env['QWEN_CODE_MCP_APPROVALS_PATH'];
    resetMcpApprovalsForTesting();
    cwdSpy.mockRestore();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  const writeMcpJson = (servers: Record<string, unknown>) =>
    fs.writeFileSync(
      path.join(dir, '.mcp.json'),
      JSON.stringify({ mcpServers: servers }),
    );

  /** What a normal boot loads: expanded against this workspace's snapshot. */
  const bootView = () =>
    loadProjectMcpServers(dir, {
      expandEnv: true,
      env: buildWorkspaceEnvSnapshot(loadSettings(dir).merged, dir),
    });

  const stateOf = (name: string) => {
    resetMcpApprovalsForTesting();
    const { servers } = bootView();
    return loadMcpApprovals().getState(dir, name, servers[name]!);
  };

  const writeWorkspaceSettings = (servers: Record<string, unknown>) => {
    const qwenDir = path.join(dir, '.qwen');
    fs.mkdirSync(qwenDir, { recursive: true });
    fs.writeFileSync(
      path.join(qwenDir, 'settings.json'),
      JSON.stringify({ mcpServers: servers }),
    );
  };

  /** Read the persisted approval status straight off disk (scope-agnostic). */
  const persistedStatus = (name: string): string | undefined => {
    const raw = fs.readFileSync(
      process.env['QWEN_CODE_MCP_APPROVALS_PATH']!,
      'utf-8',
    );
    // Keys are case-folded on win32 (issue #9775); fold the lookup too, since
    // the mkdtemp temp path can contain uppercase letters on Windows runners.
    const storedRoot =
      os.platform() === 'win32' ? path.resolve(dir).toLowerCase() : dir;
    return JSON.parse(raw)[storedRoot]?.[name]?.status;
  };

  it('reports when there are no gated servers', async () => {
    await run(approveCommand, { name: 'slack', all: false });
    expect(output()).toContain('No approval-requiring MCP servers found');
  });

  it('approves a named project server (pending -> approved)', async () => {
    writeMcpJson({ slack: { command: 'node', args: ['slack.js'] } });
    expect(stateOf('slack')).toBe('pending');

    await run(approveCommand, { name: 'slack', all: false });

    expect(stateOf('slack')).toBe('approved');
    expect(output()).toContain('Approved MCP server "slack"');
  });

  it('approves a workspace .qwen/settings.json server', async () => {
    writeWorkspaceSettings({ ws: { command: 'node', args: ['ws.js'] } });

    await run(approveCommand, { name: 'ws', all: false });

    expect(output()).toContain('Approved MCP server "ws"');
    expect(persistedStatus('ws')).toBe('approved');
  });

  it('rejects a named project server', async () => {
    writeMcpJson({ slack: { command: 'node' } });
    await run(rejectCommand, { name: 'slack', all: false });
    expect(stateOf('slack')).toBe('rejected');
  });

  it('approves all with --all', async () => {
    writeMcpJson({ a: { command: 'a' }, b: { command: 'b' } });
    await run(approveCommand, { name: undefined, all: true });
    expect(stateOf('a')).toBe('approved');
    expect(stateOf('b')).toBe('approved');
  });

  it('reports an unknown server name', async () => {
    writeMcpJson({ slack: { command: 'node' } });
    await run(approveCommand, { name: 'ghost', all: false });
    expect(output()).toContain('not found');
    expect(stateOf('slack')).toBe('pending');
  });

  it('binds approval to the config hash: editing .mcp.json reverts to pending', async () => {
    writeMcpJson({ slack: { command: 'node', args: ['slack.js'] } });
    await run(approveCommand, { name: 'slack', all: false });
    expect(stateOf('slack')).toBe('approved');

    // Edit the server's command — approval must no longer apply.
    writeMcpJson({ slack: { command: 'curl', args: ['slack.js'] } });
    expect(stateOf('slack')).toBe('pending');
  });

  // Digest is of the resolved config: approve hashes what boot hashes; rotation re-opens.
  it('hashes the resolved config: rotating a referenced variable, file untouched, reverts to pending', async () => {
    process.env['MCPAPPROVE_ROT'] = 'a';
    try {
      writeMcpJson({
        slack: {
          httpUrl: 'https://h.example/mcp',
          headers: { Authorization: 'Bearer ${MCPAPPROVE_ROT}' },
        },
      });
      await run(approveCommand, { name: 'slack', all: false });
      expect(stateOf('slack')).toBe('approved');

      process.env['MCPAPPROVE_ROT'] = 'b';
      expect(stateOf('slack')).toBe('pending');
    } finally {
      delete process.env['MCPAPPROVE_ROT'];
    }
  });

  it('hashes the same form a boot does when the variable comes from the workspace .env', async () => {
    // Another workspace's `.env` has already put a different value for the
    // same name into process.env (file-sourced, no-override), so a digest over
    // process.env would differ from the snapshot's.
    const other = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-approve-other-'));
    try {
      fs.mkdirSync(path.join(other, '.qwen'), { recursive: true });
      fs.writeFileSync(
        path.join(other, '.qwen', '.env'),
        'MCPAPPROVE_FILE_TOKEN=from-other-workspace\n',
      );
      loadSettings(other);
      expect(process.env['MCPAPPROVE_FILE_TOKEN']).toBe('from-other-workspace');

      fs.mkdirSync(path.join(dir, '.qwen'), { recursive: true });
      fs.writeFileSync(
        path.join(dir, '.qwen', '.env'),
        'MCPAPPROVE_FILE_TOKEN=from-file\n',
      );
      writeMcpJson({
        slack: {
          httpUrl: 'https://h.example/mcp',
          headers: { Authorization: 'Bearer ${MCPAPPROVE_FILE_TOKEN}' },
        },
      });
      await run(approveCommand, { name: 'slack', all: false });

      expect(bootView().servers['slack']!.headers).toEqual({
        Authorization: 'Bearer from-file',
      });
      expect(stateOf('slack')).toBe('approved');
    } finally {
      delete process.env['MCPAPPROVE_FILE_TOKEN'];
      resetEnvironmentTrackingForTesting();
      fs.rmSync(other, { recursive: true, force: true });
    }
  });
});
