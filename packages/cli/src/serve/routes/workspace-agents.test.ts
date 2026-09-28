/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import * as fs from 'node:fs/promises';
import * as http from 'node:http';
import * as os from 'node:os';
import * as path from 'node:path';
import express, { type RequestHandler } from 'express';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { Storage } from '@qwen-code/qwen-code-core';
import { getAgentsDir } from '@qwen-code/qwen-code-core/agents/workspace-agents/store.js';
import { publishAgentEvent } from '../workspace-agents/agent-events.js';
import {
  createWorkspaceGenerationGuard,
  createWorkspaceRegistry,
  type WorkspaceRuntime,
} from '../workspace-registry.js';
import { registerWorkspaceAgentRoutes } from './workspace-agents.js';

let runtimeDir: string;

beforeEach(async () => {
  runtimeDir = await fs.mkdtemp(path.join(os.tmpdir(), 'agent-route-events-'));
  Storage.setRuntimeBaseDir(runtimeDir);
});

afterEach(async () => {
  Storage.setRuntimeBaseDir(null);
  await fs.rm(runtimeDir, { recursive: true, force: true });
});

it('answers 404 for a workspace whose settings have not opted in', async () => {
  const on = {
    workspaceId: 'on',
    workspaceCwd: path.join(runtimeDir, 'on'),
    primary: true,
    trusted: true,
  } as WorkspaceRuntime;
  const off = {
    workspaceId: 'off',
    workspaceCwd: path.join(runtimeDir, 'off'),
    primary: false,
    trusted: true,
  } as WorkspaceRuntime;
  const app = express();
  registerWorkspaceAgentRoutes(app, {
    workspaceRegistry: createWorkspaceRegistry([on, off]),
    mutate: () => ((_req, _res, next) => next()) as RequestHandler,
    isAgentCollaborationEnabledFor: (cwd) => cwd === on.workspaceCwd,
  });
  const server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));

  try {
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('No TCP port');
    const disabled = await fetch(
      `http://127.0.0.1:${address.port}/workspaces/off/agent/events`,
    );
    expect(disabled.status).toBe(404);
    await expect(disabled.json()).resolves.toEqual({
      error: 'agent_collaboration_disabled',
    });

    // The enabled workspace answers the same route normally.
    const enabled = await fetch(
      `http://127.0.0.1:${address.port}/workspaces/on/agent/events`,
    );
    expect(enabled.status).toBe(200);
    await enabled.body?.cancel();

    // Recovery visits `on` (creating its store) before `off`; once it has,
    // the opted-out workspace must still have nothing written into it.
    await vi.waitFor(() => fs.stat(getAgentsDir(on.workspaceCwd)));
    await new Promise((resolve) => setTimeout(resolve, 100));
    await expect(fs.stat(getAgentsDir(off.workspaceCwd))).rejects.toThrow();
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});

it('closes an event stream before a replacement runtime can publish to it', async () => {
  const primary = {
    workspaceId: 'primary',
    workspaceCwd: path.join(runtimeDir, 'primary'),
    primary: true,
    trusted: true,
  } as WorkspaceRuntime;
  const guard = createWorkspaceGenerationGuard();
  const secondary = {
    workspaceId: 'secondary',
    workspaceCwd: path.join(runtimeDir, 'secondary'),
    primary: false,
    trusted: true,
    generationGuard: guard,
  } as WorkspaceRuntime;
  const app = express();
  registerWorkspaceAgentRoutes(app, {
    workspaceRegistry: createWorkspaceRegistry([primary, secondary]),
    mutate: () => ((_req, _res, next) => next()) as RequestHandler,
    isAgentCollaborationEnabledFor: () => true,
  });
  const server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));

  try {
    const address = server.address();
    if (!address || typeof address === 'string') throw new Error('No TCP port');
    const response = await fetch(
      `http://127.0.0.1:${address.port}/workspaces/secondary/agent/events`,
    );
    const reader = response.body?.getReader();
    if (!reader) throw new Error('No response body');
    const first = await reader.read();
    expect(new TextDecoder().decode(first.value)).toContain('event: changed');

    guard.close();
    publishAgentEvent(secondary.workspaceCwd, {
      type: 'progress',
      threadId: 'th_replacement',
      runId: 'rn_replacement',
      attempt: 1,
      sessionId: 'replacement',
      stage: 'responding',
      detail: '',
      outputText: 'private replacement output',
      thoughtText: '',
      activityAt: 1,
    });

    await expect(reader.read()).resolves.toMatchObject({ done: true });
  } finally {
    (app.locals['stopWorkspaceAgentRecovery'] as (() => void) | undefined)?.();
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  }
});
