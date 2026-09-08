/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import express from 'express';
import type { Application, Request, Response } from 'express';
import {
  enrollAgentHost,
  heartbeatAgentHost,
} from '@qwen-code/qwen-code-core';
import type { WorkspaceRegistry } from '../workspace-registry.js';

function body(req: Request): Record<string, unknown> {
  return typeof req.body === 'object' && req.body !== null ? req.body : {};
}

function runtimeFor(
  registry: WorkspaceRegistry,
  workspaceId: string,
) {
  return registry
    .listAll()
    .find((runtime) => runtime.workspaceId === workspaceId);
}

function hostSecret(req: Request): string | undefined {
  const match = /^AgentHost ([A-Za-z0-9_-]{32,})$/.exec(
    req.get('authorization') ?? '',
  );
  return match?.[1];
}

export function registerAgentHostTransportRoutes(
  app: Application,
  workspaceRegistry: WorkspaceRegistry,
): void {
  const json = express.json({ limit: '16kb' });

  app.post('/agent-hosts/enroll', json, async (req: Request, res: Response) => {
    const input = body(req);
    const workspaceId = input['workspaceId'];
    const token = input['token'];
    const name = input['name'];
    const workspaceCwd = input['workspaceCwd'];
    const providers = input['providers'];
    if (
      typeof workspaceId !== 'string' ||
      typeof token !== 'string' ||
      typeof name !== 'string' ||
      typeof workspaceCwd !== 'string' ||
      !Array.isArray(providers) ||
      !providers.every((provider) => typeof provider === 'string')
    ) {
      res.status(400).json({ error: 'Invalid Agent Host enrollment.' });
      return;
    }
    const runtime = runtimeFor(workspaceRegistry, workspaceId);
    if (!runtime) {
      res.status(404).json({ error: 'Workspace not found.' });
      return;
    }
    if (!runtime.primary && !runtime.trusted) {
      res.status(403).json({ error: 'Workspace is not trusted.' });
      return;
    }
    try {
      const enrolled = await enrollAgentHost(runtime.workspaceCwd, {
        token,
        name,
        workspaceCwd,
        providers,
      });
      res.status(201).json(enrolled);
    } catch (error) {
      res.status(401).json({
        error: error instanceof Error ? error.message : String(error),
      });
    }
  });

  app.post(
    '/agent-hosts/:workspaceId/:hostId/heartbeat',
    json,
    async (req: Request, res: Response) => {
      const workspaceId = req.params['workspaceId'];
      const hostId = req.params['hostId'];
      const secret = hostSecret(req);
      const input = body(req);
      const workspaceCwd = input['workspaceCwd'];
      const providers = input['providers'];
      if (
        !workspaceId ||
        !hostId ||
        !secret ||
        typeof workspaceCwd !== 'string' ||
        !Array.isArray(providers) ||
        !providers.every((provider) => typeof provider === 'string')
      ) {
        res.status(401).json({ error: 'Invalid Agent Host credential.' });
        return;
      }
      const runtime = runtimeFor(workspaceRegistry, workspaceId);
      if (!runtime || (!runtime.primary && !runtime.trusted)) {
        res.status(404).json({ error: 'Workspace not found.' });
        return;
      }
      try {
        const host = await heartbeatAgentHost(
          runtime.workspaceCwd,
          hostId,
          secret,
          { workspaceCwd, providers },
        );
        if (!host) {
          res.status(401).json({ error: 'Invalid Agent Host credential.' });
          return;
        }
        res.json({ host });
      } catch (error) {
        res.status(400).json({
          error: error instanceof Error ? error.message : String(error),
        });
      }
    },
  );
}
