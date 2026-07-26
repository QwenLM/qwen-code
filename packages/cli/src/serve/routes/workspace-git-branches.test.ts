/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import express from 'express';
import request from 'supertest';
import { describe, expect, it } from 'vitest';
import { sendBridgeError } from '../server/error-response.js';
import { registerWorkspaceGitBranchRoutes } from './workspace-git-branches.js';

const passthroughMutate = () =>
  ((_req: unknown, _res: unknown, next: () => void) => next()) as never;

function app() {
  const app = express();
  app.use(express.json());
  registerWorkspaceGitBranchRoutes(app, {
    boundWorkspace: '/work/main',
    sendBridgeError,
    mutate: passthroughMutate,
  });
  return app;
}

describe('workspace Git branch routes', () => {
  it.each(['-evil', '-f', '--output=/tmp/pwn'])(
    'rejects a dash-prefixed branch name %s with 400 invalid_branch_name',
    async (name) => {
      const response = await request(app())
        .post('/workspace/git/branch')
        .send({ name });

      expect(response.status).toBe(400);
      expect(response.body).toEqual({
        error: 'invalid_branch_name',
        message: 'Invalid branch name',
      });
    },
  );

  it('rejects a wrong-typed startPoint with 400', async () => {
    const response = await request(app())
      .post('/workspace/git/branch')
      .send({ name: 'release', startPoint: 1234567 });

    expect(response.status).toBe(400);
    expect(response.body.error).toBe('invalid_start_point');
  });

  it('rejects a wrong-typed fetchOnly with 400', async () => {
    const response = await request(app())
      .post('/workspace/git/pull')
      .send({ fetchOnly: 'true' });

    expect(response.status).toBe(400);
    expect(response.body.error).toBe('invalid_fetch_only');
  });

  it('rejects a wrong-typed rebase with 400', async () => {
    const response = await request(app())
      .post('/workspace/git/pull')
      .send({ rebase: 'yes' });

    expect(response.status).toBe(400);
    expect(response.body.error).toBe('invalid_rebase');
  });
});
