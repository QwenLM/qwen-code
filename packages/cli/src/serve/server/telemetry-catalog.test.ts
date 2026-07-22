/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import express, { type RequestHandler } from 'express';
import { describe, expect, it, vi } from 'vitest';
import { registerA2uiActionRoutes } from '../routes/a2ui-action.js';
import { registerPermissionRoutes } from '../routes/permission.js';
import { registerSessionRoutes } from '../routes/session.js';
import { registerSseEventsRoutes } from '../routes/sse-events.js';
import { legacySessionTelemetryRoutes } from './telemetry.js';

interface RouterLayer {
  route?: {
    path?: unknown;
    methods?: Record<string, boolean>;
  };
  handle?: {
    stack?: RouterLayer[];
  };
}

function collectExplicitRoutes(layers: RouterLayer[]): string[] {
  const routes: string[] = [];
  for (const layer of layers) {
    const routePath = layer.route?.path;
    const paths =
      typeof routePath === 'string'
        ? [routePath]
        : Array.isArray(routePath)
          ? routePath.filter((path): path is string => typeof path === 'string')
          : [];
    for (const [method, enabled] of Object.entries(
      layer.route?.methods ?? {},
    )) {
      if (!enabled) continue;
      for (const path of paths) {
        if (/^\/(session|sessions|permission)(?:\/|$)/.test(path)) {
          routes.push(`${method.toUpperCase()} ${path}`);
        }
      }
    }
    if (layer.handle?.stack) {
      routes.push(...collectExplicitRoutes(layer.handle.stack));
    }
  }
  return routes;
}

describe('legacy session telemetry route drift guard', () => {
  it('matches the explicit Express route registrations in both directions', () => {
    const app = express();
    const pass: RequestHandler = (_req, _res, next) => next();
    const mutate = () => pass;

    registerSessionRoutes(app, {
      boundWorkspace: '/workspace/primary',
      bridge: {} as Parameters<typeof registerSessionRoutes>[1]['bridge'],
      workspaceRegistry: {} as Parameters<
        typeof registerSessionRoutes
      >[1]['workspaceRegistry'],
      archiveCoordinator: {} as Parameters<
        typeof registerSessionRoutes
      >[1]['archiveCoordinator'],
      mutate,
      sendBridgeError: vi.fn(),
      sessionShellCommandEnabled: true,
      languageCodes: [],
    });
    registerPermissionRoutes(app, {
      bridge: {} as Parameters<typeof registerPermissionRoutes>[1]['bridge'],
      workspaceRegistry: {} as Parameters<
        typeof registerPermissionRoutes
      >[1]['workspaceRegistry'],
      mutate,
      sendPermissionVoteError: vi.fn(),
    });
    registerSseEventsRoutes(app, {
      bridge: {} as Parameters<typeof registerSseEventsRoutes>[1]['bridge'],
      workspaceRegistry: {} as Parameters<
        typeof registerSseEventsRoutes
      >[1]['workspaceRegistry'],
      sendBridgeError: vi.fn(),
    });
    registerA2uiActionRoutes(app, {
      boundWorkspace: '/workspace/primary',
      mutate,
      safeBody: () => ({}),
      getMcpServers: async () => [],
    });

    const router = (app as unknown as { router: { stack: RouterLayer[] } })
      .router;
    const registered = collectExplicitRoutes(router.stack).sort();
    const catalog = legacySessionTelemetryRoutes
      .map(({ method, path }) => `${method} ${path}`)
      .sort();

    expect(registered).toHaveLength(52);
    expect(registered).toEqual(catalog);
  });
});
