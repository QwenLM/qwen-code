/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { promises as fsp } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import express from 'express';
import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { daemonObservedContactsPath } from '../../commands/channel/runtime.js';
import { ObservedChannelContactStore } from '../../commands/channel/observed-contact-store.js';
import {
  createWorkspaceRegistry,
  type WorkspaceRegistry,
  type WorkspaceRuntime,
} from '../workspace-registry.js';
import { registerWorkspaceChannelObservedContactRoutes } from './workspace-channel-observed-contacts.js';

function runtime(
  workspaceId: string,
  workspaceCwd: string,
  trusted = true,
): WorkspaceRuntime {
  return {
    workspaceId,
    workspaceCwd,
    primary: workspaceId === 'primary',
    trusted,
  } as WorkspaceRuntime;
}

function registry(runtimes: WorkspaceRuntime[]): WorkspaceRegistry {
  return createWorkspaceRegistry(runtimes);
}

describe('workspace observed channel contact routes', () => {
  let qwenHome: string;
  let previousQwenHome: string | undefined;

  beforeEach(async () => {
    previousQwenHome = process.env['QWEN_HOME'];
    qwenHome = await fsp.mkdtemp(
      path.join(os.tmpdir(), 'qwen-observed-contact-routes-'),
    );
    process.env['QWEN_HOME'] = qwenHome;
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    if (previousQwenHome === undefined) delete process.env['QWEN_HOME'];
    else process.env['QWEN_HOME'] = previousQwenHome;
    await fsp.rm(qwenHome, { recursive: true, force: true });
  });

  it('returns complete direct users and observed group/topic membership', async () => {
    const primary = runtime('primary', '/work/main');
    const secondary = runtime('secondary', '/work/secondary');
    new ObservedChannelContactStore(
      daemonObservedContactsPath(primary.workspaceCwd),
    ).observe('dingtalk-main', {
      user: { id: 'direct-primary', label: 'Direct Primary' },
    });
    new ObservedChannelContactStore(
      daemonObservedContactsPath(primary.workspaceCwd),
    ).observe('dingtalk-main', {
      user: { id: 'user-primary', label: 'Primary User' },
      group: { id: 'group-primary', label: 'group-primary' },
      topic: { id: 'topic-primary', label: 'topic-primary' },
    });
    new ObservedChannelContactStore(
      daemonObservedContactsPath(secondary.workspaceCwd),
    ).observe('dingtalk-main', {
      user: { id: 'user-secondary', label: 'Secondary User' },
    });
    const app = express();
    registerWorkspaceChannelObservedContactRoutes(app, {
      primaryWorkspace: primary.workspaceCwd,
      workspaceRegistry: registry([primary, secondary]),
    });

    const response = await request(app).get(
      '/workspace/channel/observed-contacts',
    );

    expect(response.status).toBe(200);
    expect(response.headers['cache-control']).toBe('no-store');
    expect(response.body).toEqual({
      users: [
        {
          channelName: 'dingtalk-main',
          id: 'direct-primary',
          label: 'Direct Primary',
          lastObservedAt: expect.any(String),
        },
      ],
      groups: [
        {
          channelName: 'dingtalk-main',
          id: 'group-primary',
          label: 'group-primary',
          lastObservedAt: expect.any(String),
          users: [
            {
              id: 'user-primary',
              label: 'Primary User',
              lastObservedAt: expect.any(String),
            },
          ],
          topics: [
            {
              id: 'topic-primary',
              label: 'topic-primary',
              lastObservedAt: expect.any(String),
              users: [
                {
                  id: 'user-primary',
                  label: 'Primary User',
                  lastObservedAt: expect.any(String),
                },
              ],
            },
          ],
        },
      ],
    });
    expect(JSON.stringify(response.body)).not.toContain('user-secondary');
  });

  it('selects an exact trusted workspace and returns an empty graph for no file', async () => {
    const primary = runtime('primary', '/work/main');
    const secondary = runtime('secondary', '/work/secondary');
    new ObservedChannelContactStore(
      daemonObservedContactsPath(secondary.workspaceCwd),
    ).observe('telegram-team', {
      user: { id: '42', label: 'Ada' },
    });
    const app = express();
    registerWorkspaceChannelObservedContactRoutes(app, {
      primaryWorkspace: primary.workspaceCwd,
      workspaceRegistry: registry([primary, secondary]),
    });

    const selected = await request(app).get(
      '/workspaces/secondary/channel/observed-contacts',
    );
    const empty = await request(app).get(
      '/workspace/channel/observed-contacts',
    );

    expect(selected.status).toBe(200);
    expect(selected.body.users[0]).toMatchObject({
      channelName: 'telegram-team',
      label: 'Ada',
      id: '42',
    });
    expect(empty.body).toEqual({ users: [], groups: [] });
  });

  it('validates freshness bounds and query shape', async () => {
    const primary = runtime('primary', '/work/main');
    const app = express();
    registerWorkspaceChannelObservedContactRoutes(app, {
      primaryWorkspace: primary.workspaceCwd,
      workspaceRegistry: registry([primary]),
    });

    const valid = await request(app).get(
      '/workspace/channel/observed-contacts?freshWithinSeconds=60',
    );
    const zero = await request(app).get(
      '/workspace/channel/observed-contacts?freshWithinSeconds=0',
    );
    const nonNumeric = await request(app).get(
      '/workspace/channel/observed-contacts?freshWithinSeconds=recent',
    );
    const repeated = await request(app).get(
      '/workspace/channel/observed-contacts?freshWithinSeconds=60&freshWithinSeconds=120',
    );
    const tooLarge = await request(app).get(
      '/workspace/channel/observed-contacts?freshWithinSeconds=31536001',
    );

    expect(valid.status).toBe(200);
    for (const invalid of [zero, nonNumeric, repeated, tooLarge]) {
      expect(invalid.status).toBe(400);
      expect(invalid.body.code).toBe('invalid_freshness');
    }
  });

  it('defaults freshness to seven days', async () => {
    const primary = runtime('primary', '/work/main');
    new ObservedChannelContactStore(
      daemonObservedContactsPath(primary.workspaceCwd),
      { now: () => new Date(Date.now() - 8 * 24 * 60 * 60 * 1000) },
    ).observe('telegram', {
      user: { id: 'stale-default-user', label: 'Stale Default User' },
    });
    const app = express();
    registerWorkspaceChannelObservedContactRoutes(app, {
      primaryWorkspace: primary.workspaceCwd,
      workspaceRegistry: registry([primary]),
    });

    const defaultWindow = await request(app).get(
      '/workspace/channel/observed-contacts',
    );
    const widerWindow = await request(app).get(
      '/workspace/channel/observed-contacts?freshWithinSeconds=777600',
    );

    expect(defaultWindow.body.users).toEqual([]);
    expect(widerWindow.body.users[0]?.id).toBe('stale-default-user');
  });

  it('does not fall back for unknown or untrusted workspace selectors', async () => {
    const primary = runtime('primary', '/work/main');
    const untrusted = runtime('untrusted', '/work/untrusted', false);
    const app = express();
    registerWorkspaceChannelObservedContactRoutes(app, {
      primaryWorkspace: primary.workspaceCwd,
      workspaceRegistry: registry([primary, untrusted]),
    });

    const unknown = await request(app).get(
      '/workspaces/missing/channel/observed-contacts',
    );
    const denied = await request(app).get(
      '/workspaces/untrusted/channel/observed-contacts',
    );

    expect(unknown.status).toBe(400);
    expect(unknown.body.code).toBe('workspace_mismatch');
    expect(denied.status).toBe(403);
    expect(denied.body.code).toBe('untrusted_workspace');
  });

  it('returns a sanitized error for malformed registry data', async () => {
    const primary = runtime('primary', '/work/main');
    const filePath = daemonObservedContactsPath(primary.workspaceCwd);
    await fsp.mkdir(path.dirname(filePath), { recursive: true });
    await fsp.writeFile(filePath, '{invalid-json', 'utf8');
    const stderr = vi
      .spyOn(process.stderr, 'write')
      .mockImplementation(() => true);
    const app = express();
    registerWorkspaceChannelObservedContactRoutes(app, {
      primaryWorkspace: primary.workspaceCwd,
      workspaceRegistry: registry([primary]),
    });

    const response = await request(app).get(
      '/workspace/channel/observed-contacts',
    );

    expect(response.status).toBe(500);
    expect(response.body).toEqual({
      error: 'Observed channel contacts are unavailable.',
      code: 'channel_observed_contacts_unavailable',
    });
    expect(JSON.stringify(response.body)).not.toContain(filePath);
    expect(stderr).toHaveBeenCalledWith(
      'qwen serve: observed channel contacts unavailable.\n',
    );
  });
});
