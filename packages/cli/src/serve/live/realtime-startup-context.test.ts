/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { ChatRecord } from '@qwen-code/qwen-code-core';
import type {
  WorkspaceRegistry,
  WorkspaceRuntime,
} from '../workspace-registry.js';
import {
  buildRealtimeStartupContext,
  truncateRealtimeTextToTokenBudget,
} from './realtime-startup-context.js';

const sessionData = vi.hoisted(() => new Map<string, unknown>());
const sessionLists = vi.hoisted(() => new Map<string, unknown>());
const sessionServiceConstructions = vi.hoisted(
  () => [] as Array<{ cwd: string; runtimeBaseDir?: string }>,
);

vi.mock('@qwen-code/qwen-code-core', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('@qwen-code/qwen-code-core')>();
  return {
    ...actual,
    SessionService: class {
      constructor(
        private readonly cwd: string,
        options?: { runtimeBaseDir?: string },
      ) {
        sessionServiceConstructions.push({
          cwd,
          ...(options?.runtimeBaseDir
            ? { runtimeBaseDir: options.runtimeBaseDir }
            : {}),
        });
      }

      loadSession(sessionId: string) {
        return Promise.resolve(sessionData.get(sessionId));
      }

      listSessions() {
        const result = sessionLists.get(this.cwd);
        if (result instanceof Error) return Promise.reject(result);
        return Promise.resolve(result ?? { items: [], hasMore: false });
      }
    },
  };
});

const temporaryDirectories: string[] = [];

function temporaryDirectory(): string {
  const directory = mkdtempSync(join(tmpdir(), 'qwen-live-context-'));
  temporaryDirectories.push(directory);
  return directory;
}

function record(
  type: 'user' | 'assistant',
  text: string,
  index: number,
  cwd: string,
): ChatRecord {
  return {
    uuid: `record-${index}`,
    parentUuid: index === 0 ? null : `record-${index - 1}`,
    sessionId: 'live-session',
    timestamp: `2026-07-30T00:00:0${index}.000Z`,
    type,
    provenance: type === 'user' ? 'real_user' : 'assistant_output',
    cwd,
    version: 'test',
    message: {
      role: type === 'user' ? 'user' : 'model',
      parts: [{ text }],
    },
  };
}

afterEach(() => {
  sessionData.clear();
  sessionLists.clear();
  sessionServiceConstructions.length = 0;
  for (const directory of temporaryDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe('buildRealtimeStartupContext', () => {
  it('copies the Codex current-thread, recent-work, workspace, and notes sections', async () => {
    const root = temporaryDirectory();
    const repo = join(root, 'repo');
    const currentCwd = join(repo, 'conversation');
    const home = join(root, 'home');
    mkdirSync(join(repo, '.git'), { recursive: true });
    mkdirSync(join(currentCwd, 'artifacts'), { recursive: true });
    mkdirSync(join(home, 'code'), { recursive: true });
    writeFileSync(join(repo, 'README.md'), 'hello');

    sessionData.set('live-session', {
      conversation: {
        messages: [
          record('user', 'first request', 0, currentCwd),
          record('assistant', 'first response', 1, currentCwd),
          record('user', 'latest request', 2, currentCwd),
          record('assistant', 'latest response', 3, currentCwd),
        ],
      },
    });
    sessionLists.set(repo, {
      items: [
        {
          cwd: currentCwd,
          mtime: Date.parse('2026-07-30T01:00:00.000Z'),
          prompt: 'Inspect the current repository',
          gitBranch: 'main',
        },
      ],
      hasMore: false,
    });
    const runtime = { workspaceCwd: repo } as WorkspaceRuntime;
    const workspaceRegistry = {
      list: () => [runtime],
      listAll: () => [runtime],
    } as unknown as WorkspaceRegistry;

    const context = await buildRealtimeStartupContext({
      runtime,
      workspaceRegistry,
      sessionId: 'live-session',
      currentCwd,
      userRoot: home,
    });

    expect(context).toContain('<startup_context>');
    expect(context).toContain('## Current Thread');
    expect(context).toContain('### Latest turn\nUser:\nlatest request');
    expect(context).toContain('### Previous turn 1\nUser:\nfirst request');
    expect(context).toContain('## Recent Work');
    expect(context).toContain(`### Git repo: ${repo}`);
    expect(context).toContain('Latest branch: main');
    expect(context).toContain('## Machine / Workspace Map');
    expect(context).toContain('- artifacts/');
    expect(context).toContain('User root tree:');
    expect(context).toContain('## Notes');
    expect(context).toContain('This excludes repo memory instructions');
    expect(context).toMatch(/<\/startup_context>$/);
  });

  it('omits startup context when every Codex source is empty', async () => {
    const root = temporaryDirectory();
    const currentCwd = join(root, 'current');
    const home = join(root, 'home');
    mkdirSync(currentCwd);
    mkdirSync(home);
    const runtime = { workspaceCwd: root } as WorkspaceRuntime;
    const workspaceRegistry = {
      list: () => [runtime],
      listAll: () => [runtime],
    } as unknown as WorkspaceRegistry;

    await expect(
      buildRealtimeStartupContext({
        runtime,
        workspaceRegistry,
        sessionId: 'missing',
        currentCwd,
        userRoot: home,
      }),
    ).resolves.toBeUndefined();
  });

  it('keeps Live startup available when the task catalog cannot be read', async () => {
    const root = temporaryDirectory();
    const currentCwd = join(root, 'current');
    const home = join(root, 'home');
    mkdirSync(currentCwd);
    mkdirSync(home);
    writeFileSync(join(currentCwd, 'README.md'), 'available workspace');
    sessionLists.set(root, new Error('catalog unavailable'));
    const runtime = { workspaceCwd: root } as WorkspaceRuntime;
    const workspaceRegistry = {
      list: () => [runtime],
      listAll: () => [runtime],
    } as unknown as WorkspaceRegistry;

    const context = await buildRealtimeStartupContext({
      runtime,
      workspaceRegistry,
      sessionId: 'missing',
      currentCwd,
      userRoot: home,
    });

    expect(context).toContain('## Machine / Workspace Map');
    expect(context).not.toContain('## Recent Work');
  });

  it('reads the current and recent catalogs from each runtime base', async () => {
    const root = temporaryDirectory();
    const currentCwd = join(root, 'current');
    const home = join(root, 'home');
    mkdirSync(currentCwd);
    mkdirSync(home);
    writeFileSync(join(currentCwd, 'README.md'), 'available workspace');
    const primary = {
      workspaceCwd: join(root, 'primary'),
      sessionRuntimeBaseDir: join(root, 'primary-runtime'),
    } as WorkspaceRuntime;
    const internal = {
      workspaceCwd: join(root, 'conversations'),
      sessionRuntimeBaseDir: join(root, 'conversation-runtime'),
      provenance: 'live-conversation',
    } as WorkspaceRuntime;
    const workspaceRegistry = {
      listAll: () => [primary, internal],
    } as unknown as WorkspaceRegistry;

    await buildRealtimeStartupContext({
      runtime: internal,
      workspaceRegistry,
      sessionId: 'missing',
      currentCwd,
      userRoot: home,
    });

    expect(sessionServiceConstructions).toEqual(
      expect.arrayContaining([
        {
          cwd: internal.workspaceCwd,
          runtimeBaseDir: internal.sessionRuntimeBaseDir,
        },
        {
          cwd: primary.workspaceCwd,
          runtimeBaseDir: primary.sessionRuntimeBaseDir,
        },
      ]),
    );
  });

  it('preserves the start and end of an over-budget turn', () => {
    const text = `turn-start ${'middle '.repeat(1_000)} turn-end`;
    const truncated = truncateRealtimeTextToTokenBudget(text, 100);

    expect(truncated).toContain('turn-start');
    expect(truncated).toContain('turn-end');
    expect(truncated).toContain('tokens truncated');
    expect(Buffer.byteLength(truncated, 'utf8')).toBeLessThanOrEqual(400);
  });
});
