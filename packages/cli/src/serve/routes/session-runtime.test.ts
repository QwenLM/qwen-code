/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type { Response } from 'express';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  WorkspaceRegistry,
  WorkspaceRuntime,
} from '../workspace-registry.js';

const telemetryMocks = vi.hoisted(() => ({
  setDaemonTelemetryWorkspace: vi.fn(),
}));

vi.mock('../server/telemetry.js', () => telemetryMocks);

import { requireSessionRuntime } from './session-runtime.js';

function runtime(
  workspaceCwd: string,
  opts: { primary?: boolean; trusted?: boolean } = {},
): WorkspaceRuntime {
  return {
    workspaceCwd,
    workspaceId: workspaceCwd.split('/').at(-1) ?? workspaceCwd,
    primary: opts.primary === true,
    trusted: opts.trusted !== false,
  } as WorkspaceRuntime;
}

function response(): Response {
  const res = {
    statusCode: 200,
    status: vi.fn((statusCode: number) => {
      res.statusCode = statusCode;
      return res;
    }),
    json: vi.fn(() => res),
  };
  return res as unknown as Response;
}

function registry(opts: {
  primary: WorkspaceRuntime;
  runtimes: WorkspaceRuntime[];
  resolution:
    | { kind: 'found'; runtime: WorkspaceRuntime }
    | { kind: 'not_found' }
    | { kind: 'ambiguous'; runtimes: WorkspaceRuntime[] };
}): {
  registry: WorkspaceRegistry;
  resolveLiveSessionOwner: ReturnType<typeof vi.fn>;
} {
  const resolveLiveSessionOwner = vi.fn(() => opts.resolution);
  return {
    registry: {
      primary: opts.primary,
      list: () => opts.runtimes,
      resolveLiveSessionOwner,
    } as unknown as WorkspaceRegistry,
    resolveLiveSessionOwner,
  };
}

describe('requireSessionRuntime telemetry attribution', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('publishes the primary runtime without scanning in single-workspace mode', () => {
    const primary = runtime('/workspace/primary', { primary: true });
    const setup = registry({
      primary,
      runtimes: [primary],
      resolution: { kind: 'not_found' },
    });
    const res = response();

    expect(
      requireSessionRuntime({
        sessionId: 'session-1',
        route: 'POST /session/:id/prompt',
        res,
        workspaceRegistry: setup.registry,
      }),
    ).toBe(primary);
    expect(setup.resolveLiveSessionOwner).not.toHaveBeenCalled();
    expect(telemetryMocks.setDaemonTelemetryWorkspace).toHaveBeenCalledWith(
      res,
      '/workspace/primary',
    );
  });

  it.each([
    'GET /session/:id/rewind/snapshots',
    'POST /session/:id/shell',
    'POST /session/:id/prompt',
  ])('publishes a uniquely resolved secondary runtime once for %s', (route) => {
    const primary = runtime('/workspace/primary', { primary: true });
    const secondary = runtime('/workspace/secondary');
    const setup = registry({
      primary,
      runtimes: [primary, secondary],
      resolution: { kind: 'found', runtime: secondary },
    });
    const res = response();

    expect(
      requireSessionRuntime({
        sessionId: 'session-2',
        route,
        res,
        workspaceRegistry: setup.registry,
      }),
    ).toBe(secondary);
    expect(setup.resolveLiveSessionOwner).toHaveBeenCalledTimes(1);
    expect(telemetryMocks.setDaemonTelemetryWorkspace).toHaveBeenCalledOnce();
    expect(telemetryMocks.setDaemonTelemetryWorkspace).toHaveBeenCalledWith(
      res,
      '/workspace/secondary',
    );
  });

  it('publishes an untrusted unique runtime before rejecting it', () => {
    const primary = runtime('/workspace/primary', { primary: true });
    const secondary = runtime('/workspace/untrusted', { trusted: false });
    const setup = registry({
      primary,
      runtimes: [primary, secondary],
      resolution: { kind: 'found', runtime: secondary },
    });
    const res = response();

    expect(
      requireSessionRuntime({
        sessionId: 'session-3',
        route: 'GET /session/:id/events',
        res,
        workspaceRegistry: setup.registry,
      }),
    ).toBeUndefined();
    expect(res.statusCode).toBe(403);
    expect(telemetryMocks.setDaemonTelemetryWorkspace).toHaveBeenCalledWith(
      res,
      '/workspace/untrusted',
    );
  });

  it.each([
    [{ kind: 'not_found' } as const, 404],
    [
      {
        kind: 'ambiguous',
        runtimes: [] as WorkspaceRuntime[],
      } as const,
      500,
    ],
  ])(
    'does not publish unresolved ownership for %o',
    (resolution, statusCode) => {
      const primary = runtime('/workspace/primary', { primary: true });
      const secondary = runtime('/workspace/secondary');
      const setup = registry({
        primary,
        runtimes: [primary, secondary],
        resolution,
      });
      const res = response();

      expect(
        requireSessionRuntime({
          sessionId: 'missing',
          route: 'POST /session/:id/rewind',
          res,
          workspaceRegistry: setup.registry,
        }),
      ).toBeUndefined();
      expect(res.statusCode).toBe(statusCode);
      expect(telemetryMocks.setDaemonTelemetryWorkspace).not.toHaveBeenCalled();
    },
  );
});
