/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import express, { type RequestHandler } from 'express';
import request from 'supertest';
import { describe, expect, it, vi } from 'vitest';
import { FatalConfigError } from '@qwen-code/qwen-code-core';
import { WorkspaceTrustGrantIneffectiveError } from '../workspace-service/types.js';
import type { WorkspaceRuntimeProvenance } from '../managed-scratch-workspace.js';
import {
  createWorkspaceRegistry,
  type WorkspaceRuntime,
} from '../workspace-registry.js';
import {
  registerWorkspaceQualifiedTrustRoutes,
  registerWorkspaceTrustRoutes,
} from './workspace-trust.js';

function runtime(
  provenance: WorkspaceRuntimeProvenance,
  primary = false,
): WorkspaceRuntime {
  return {
    workspaceId: `id-${provenance}-${primary ? 'primary' : 'secondary'}`,
    workspaceCwd: `/workspace/${provenance}-${primary ? 'primary' : 'secondary'}`,
    primary,
    trusted: true,
    provenance,
    env: { mode: 'parent-process', overlayKeys: [] },
    bridge: {},
    workspaceService: {
      getWorkspaceTrustStatus: vi.fn(),
      requestWorkspaceTrustChange: vi.fn(),
      grantWorkspaceTrust: vi.fn(),
    },
    routeFileSystemFactory: {},
    clientMcpSenderRegistry: {},
  } as unknown as WorkspaceRuntime;
}

/** Passes the mutation gate; authority itself is covered by auth.test.ts. */
const allowMutation = () => ((_req, _res, next) => next()) as RequestHandler;

describe('workspace trust routes', () => {
  it.each([
    [
      'managed-scratch',
      409,
      'managed_scratch_trust_fixed',
      'Managed scratch workspace trust cannot be changed',
    ],
    [
      'live-conversation',
      400,
      'workspace_mismatch',
      '`:workspace` must decode to a workspace id or absolute path',
    ],
  ] as const)(
    'rejects manual trust changes for %s provenance',
    async (provenance, status, code, error) => {
      const selected = runtime(provenance);
      const primary = runtime('existing', true);
      const app = express();
      app.use(express.json());
      registerWorkspaceQualifiedTrustRoutes(app, {
        workspaceRegistry: createWorkspaceRegistry([primary, selected]),
        mutate: allowMutation,
        safeBody: (req) => req.body as Record<string, unknown>,
      });

      const response = await request(app)
        .post(
          `/workspaces/${encodeURIComponent(selected.workspaceId)}/trust/request`,
        )
        .send({ desiredState: 'untrusted' });

      expect(response.status).toBe(status);
      expect(response.body).toEqual({ code, error });
      expect(
        selected.workspaceService.requestWorkspaceTrustChange,
      ).not.toHaveBeenCalled();
      expect(
        selected.workspaceService.grantWorkspaceTrust,
      ).not.toHaveBeenCalled();

      const grantResponse = await request(app).post(
        `/workspaces/${encodeURIComponent(selected.workspaceId)}/trust/grant`,
      );

      expect(grantResponse.status).toBe(status);
      expect(grantResponse.body).toEqual({ code, error });
      expect(
        selected.workspaceService.grantWorkspaceTrust,
      ).not.toHaveBeenCalled();
    },
  );
});

describe('workspace trust grant', () => {
  const grantedStatus = {
    v: 1 as const,
    workspaceCwd: '/workspace/existing-primary',
    folderTrustEnabled: true,
    effective: { state: 'trusted' as const, source: 'file' as const },
    explicitTrustLevel: 'TRUST_FOLDER',
    requiresDaemonRestartForChanges: false,
  };

  function primaryApp(primary: WorkspaceRuntime) {
    const app = express();
    app.use(express.json());
    registerWorkspaceTrustRoutes(app, {
      boundWorkspace: primary.workspaceCwd,
      workspace: primary.workspaceService,
      mutate: allowMutation,
      safeBody: (req) => req.body as Record<string, unknown>,
      parseAndValidateClientId: () => undefined,
      workspaceRegistry: createWorkspaceRegistry([primary]),
    });
    return app;
  }

  it('records the folder decision for the bound workspace', async () => {
    const primary = runtime('existing', true);
    vi.mocked(
      primary.workspaceService.getWorkspaceTrustStatus,
    ).mockResolvedValue({ folderTrustEnabled: true } as never);
    vi.mocked(primary.workspaceService.grantWorkspaceTrust).mockResolvedValue(
      grantedStatus as never,
    );

    const response = await request(primaryApp(primary)).post(
      '/workspace/trust/grant',
    );

    expect(response.status).toBe(200);
    expect(response.body).toEqual(grantedStatus);
    expect(primary.workspaceService.grantWorkspaceTrust).toHaveBeenCalledWith({
      route: 'POST /workspace/trust/grant',
      workspaceCwd: primary.workspaceCwd,
    });
    expect(
      primary.workspaceService.requestWorkspaceTrustChange,
    ).not.toHaveBeenCalled();
  });

  it('refuses to record trust while folder trust is disabled', async () => {
    const primary = runtime('existing', true);
    vi.mocked(
      primary.workspaceService.getWorkspaceTrustStatus,
    ).mockResolvedValue({ folderTrustEnabled: false } as never);

    const response = await request(primaryApp(primary)).post(
      '/workspace/trust/grant',
    );

    expect(response.status).toBe(409);
    expect(response.body).toEqual({
      code: 'folder_trust_disabled',
      error: 'Folder trust is disabled for this workspace',
    });
    expect(primary.workspaceService.grantWorkspaceTrust).not.toHaveBeenCalled();
  });

  it('answers 409 trust_grant_ineffective when the grant does not take', async () => {
    const primary = runtime('existing', true);
    vi.mocked(
      primary.workspaceService.getWorkspaceTrustStatus,
    ).mockResolvedValue({ folderTrustEnabled: true } as never);
    vi.mocked(primary.workspaceService.grantWorkspaceTrust).mockRejectedValue(
      new WorkspaceTrustGrantIneffectiveError('untrusted', 'file'),
    );

    const response = await request(primaryApp(primary)).post(
      '/workspace/trust/grant',
    );

    expect(response.status).toBe(409);
    expect(response.body).toMatchObject({
      code: 'trust_grant_ineffective',
    });
  });

  it('reports an unreadable trust file instead of granting', async () => {
    const primary = runtime('existing', true);
    vi.mocked(
      primary.workspaceService.getWorkspaceTrustStatus,
    ).mockResolvedValue({ folderTrustEnabled: true } as never);
    vi.mocked(primary.workspaceService.grantWorkspaceTrust).mockRejectedValue(
      new FatalConfigError('Invalid trusted folders file'),
    );

    const response = await request(primaryApp(primary)).post(
      '/workspace/trust/grant',
    );

    expect(response.status).toBe(500);
    expect(response.body).toEqual({
      code: 'trusted_folders_invalid',
      error: 'Failed to load trusted folders',
    });
  });

  it('records the decision through the workspace-qualified route', async () => {
    const selected = runtime('existing');
    const primary = runtime('existing', true);
    const app = express();
    app.use(express.json());
    registerWorkspaceQualifiedTrustRoutes(app, {
      workspaceRegistry: createWorkspaceRegistry([primary, selected]),
      mutate: allowMutation,
      safeBody: (req) => req.body as Record<string, unknown>,
    });
    vi.mocked(
      selected.workspaceService.getWorkspaceTrustStatus,
    ).mockResolvedValue({ folderTrustEnabled: true } as never);
    vi.mocked(selected.workspaceService.grantWorkspaceTrust).mockResolvedValue(
      grantedStatus as never,
    );

    const response = await request(app).post(
      `/workspaces/${encodeURIComponent(selected.workspaceId)}/trust/grant`,
    );

    expect(response.status).toBe(200);
    expect(response.body).toEqual(grantedStatus);
    expect(selected.workspaceService.grantWorkspaceTrust).toHaveBeenCalledWith({
      route: 'POST /workspaces/:workspace/trust/grant',
      workspaceCwd: selected.workspaceCwd,
    });
  });

  it('refuses both grant routes with 503 while the runtime is not active', async () => {
    const selected = runtime('existing');
    const primary = runtime('existing', true);
    const registry = createWorkspaceRegistry([primary, selected]);
    const app = express();
    app.use(express.json());
    registerWorkspaceTrustRoutes(app, {
      boundWorkspace: primary.workspaceCwd,
      workspace: primary.workspaceService,
      mutate: allowMutation,
      safeBody: (req) => req.body as Record<string, unknown>,
      parseAndValidateClientId: () => undefined,
      workspaceRegistry: registry,
    });
    registerWorkspaceQualifiedTrustRoutes(app, {
      workspaceRegistry: registry,
      mutate: allowMutation,
      safeBody: (req) => req.body as Record<string, unknown>,
    });

    // Primary mid-rebuild (transitioning) and secondary draining.
    registry.beginReplacement(registry.primaryEntry, 'rev-2');
    registry.beginDrain(selected);

    const primaryResponse = await request(app).post('/workspace/trust/grant');
    expect(primaryResponse.status).toBe(503);
    expect(primaryResponse.body).toEqual({
      code: 'workspace_runtime_unavailable',
      error: 'Workspace runtime is not active',
    });
    expect(primaryResponse.headers['retry-after']).toBe('1');
    expect(primary.workspaceService.grantWorkspaceTrust).not.toHaveBeenCalled();

    const qualifiedResponse = await request(app).post(
      `/workspaces/${encodeURIComponent(selected.workspaceId)}/trust/grant`,
    );
    expect(qualifiedResponse.status).toBe(503);
    expect(qualifiedResponse.body).toEqual({
      code: 'workspace_runtime_unavailable',
      error: 'Workspace runtime is not active',
    });
    expect(qualifiedResponse.headers['retry-after']).toBe('1');
    expect(
      selected.workspaceService.grantWorkspaceTrust,
    ).not.toHaveBeenCalled();
  });
});
