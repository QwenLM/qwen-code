/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Integration coverage for #7626: real spawns, real fs, real registry —
 * no ShellExecutionService mock. Replicates the reported scenario: a
 * quiet child keeps its output file empty for its whole run, and the
 * status sidecar is what tells the model the process is still alive.
 */

import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { Config } from '../config/config.js';
import { BackgroundShellRegistry } from '../services/backgroundShellRegistry.js';
import { createMockWorkspaceContext } from '../test-utils/mockWorkspaceContext.js';
import { ShellTool } from './shell.js';

const POLL_INTERVAL_MS = 100;
const SETTLE_TIMEOUT_MS = 15_000;

let tmpDirs: string[] = [];

function makeTempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tmpDirs.push(dir);
  return dir;
}

async function waitFor(
  predicate: () => boolean,
  timeoutMs = SETTLE_TIMEOUT_MS,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) {
      throw new Error('Timed out waiting for condition');
    }
    await new Promise((resolve) => setTimeout(resolve, POLL_INTERVAL_MS));
  }
}

function extractPath(llmContent: string, label: string): string {
  const match = llmContent.match(new RegExp(`${label}: (.+)`));
  if (!match) throw new Error(`No "${label}" line in: ${llmContent}`);
  return match[1].trim();
}

function readStatus(statusPath: string): Record<string, unknown> {
  return JSON.parse(readFileSync(statusPath, 'utf8')) as Record<
    string,
    unknown
  >;
}

describe('background shell status sidecar (integration, real spawn)', () => {
  let shellTool: ShellTool;
  let registry: BackgroundShellRegistry;
  let cwd: string;

  beforeEach(() => {
    cwd = makeTempDir('qwen-bg-status-cwd-');
    const projectTempDir = makeTempDir('qwen-bg-status-tmp-');
    registry = new BackgroundShellRegistry();

    const mockConfig = {
      getCoreTools: vi.fn().mockReturnValue([]),
      getPermissionsAllow: vi.fn().mockReturnValue([]),
      getPermissionsAsk: vi.fn().mockReturnValue([]),
      getPermissionsDeny: vi.fn().mockReturnValue([]),
      getDebugMode: vi.fn().mockReturnValue(false),
      getTargetDir: vi.fn().mockReturnValue(cwd),
      getSessionId: vi.fn().mockReturnValue('bg-status-session'),
      getWorkspaceContext: vi
        .fn()
        .mockReturnValue(createMockWorkspaceContext(cwd)),
      storage: {
        getUserSkillsDirs: vi.fn().mockReturnValue([]),
        getProjectTempDir: vi.fn().mockReturnValue(projectTempDir),
        getProjectDir: vi.fn().mockReturnValue(projectTempDir),
      },
      getTruncateToolOutputThreshold: vi.fn().mockReturnValue(0),
      getTruncateToolOutputLines: vi.fn().mockReturnValue(0),
      getPermissionManager: vi.fn().mockReturnValue(undefined),
      getGeminiClient: vi.fn(),
      getFileSystemService: vi.fn().mockReturnValue(undefined),
      getFileHistoryService: vi.fn().mockReturnValue(undefined),
      getFileReadCache: vi.fn().mockReturnValue(undefined),
      getFileReadCacheDisabled: vi.fn().mockReturnValue(true),
      getModel: vi.fn().mockReturnValue('qwen3-coder-plus'),
      isInteractive: vi.fn().mockReturnValue(false),
      getGitCoAuthor: vi.fn().mockReturnValue({ commit: false, pr: false }),
      setApprovalMode: vi.fn(),
      getShouldUseNodePtyShell: vi.fn().mockReturnValue(false),
      getShellDefaultTimeoutMs: vi.fn().mockReturnValue(undefined),
      getShellHeartbeatIntervalMs: vi.fn().mockReturnValue(undefined),
      getBackgroundShellRegistry: vi.fn().mockReturnValue(registry),
    } as unknown as Config;

    shellTool = new ShellTool(mockConfig);
  });

  afterEach(() => {
    registry.abortAll();
    for (const dir of tmpDirs) {
      rmSync(dir, { recursive: true, force: true });
    }
    tmpDirs = [];
  });

  it('reports running (with pid) while a quiet child keeps the output file empty, then completed', async () => {
    // A child that produces no output for its whole life — the #7626
    // scenario in miniature. Before the sidecar, the model's only
    // signal was the 0-byte output file.
    const invocation = shellTool.build({
      command: `node -e "setTimeout(() => {}, 1500)"`,
      is_background: true,
    });
    const result = await invocation.execute(new AbortController().signal);
    const text = String(result.llmContent);
    const statusPath = extractPath(text, 'status file');
    const outputPath = extractPath(text, 'output file');

    const running = readStatus(statusPath);
    expect(running['status']).toBe('running');
    expect(typeof running['pid']).toBe('number');
    // The bug scenario: process alive, no output captured yet (the write
    // stream is opened lazily, so "absent" and "empty" are equivalent here).
    const capturedOutputBytes = (() => {
      try {
        return statSync(outputPath).size;
      } catch {
        return 0;
      }
    })();
    expect(capturedOutputBytes).toBe(0);

    await waitFor(() => readStatus(statusPath)['status'] !== 'running');
    const settled = readStatus(statusPath);
    expect(settled['status']).toBe('completed');
    expect(settled['exitCode']).toBe(0);
    expect(typeof settled['endTime']).toBe('string');
  });

  it('reports failed with the exit reason for a non-zero exit', async () => {
    const invocation = shellTool.build({
      command: `node -e "process.exit(3)"`,
      is_background: true,
    });
    const result = await invocation.execute(new AbortController().signal);
    const statusPath = extractPath(String(result.llmContent), 'status file');

    await waitFor(() => readStatus(statusPath)['status'] !== 'running');
    const settled = readStatus(statusPath);
    expect(settled['status']).toBe('failed');
    expect(String(settled['error'])).toContain('3');
  });

  it('reports cancelled when the registry aborts the shell', async () => {
    const invocation = shellTool.build({
      command: `node -e "setTimeout(() => {}, 60000)"`,
      is_background: true,
    });
    const result = await invocation.execute(new AbortController().signal);
    const statusPath = extractPath(String(result.llmContent), 'status file');
    expect(readStatus(statusPath)['status']).toBe('running');

    registry.abortAll();
    await waitFor(() => readStatus(statusPath)['status'] === 'cancelled');
    expect(typeof readStatus(statusPath)['endTime']).toBe('string');
  });
});
