/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import express from 'express';
import request from 'supertest';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  fetchGitHubPullRequestInbox,
  fetchGitHubPullRequestDetail,
} from '@qwen-code/qwen-code-core/utils/github-code-review.js';
import { registerGitHubCodeReviewRoutes } from './github-code-review.js';
import { sendBridgeError } from '../server/error-response.js';

vi.mock('@qwen-code/qwen-code-core/utils/github-code-review.js', () => ({
  fetchGitHubPullRequestInbox: vi.fn(),
  fetchGitHubPullRequestDetail: vi.fn(),
}));

const inbox = {
  account: { host: 'github.com', login: 'operator' },
  authored: [],
  needsMyReview: [],
  page: 1,
  limit: 50 as const,
  hasMore: { authored: false, needsMyReview: false },
  search: Object.fromEntries(
    ['authored', 'reviewRequested', 'assigned'].map((key) => [
      key,
      { totalCount: 0, incompleteResults: false, searchLimitReached: false },
    ]),
  ) as {
    authored: {
      totalCount: number;
      incompleteResults: boolean;
      searchLimitReached: boolean;
    };
    reviewRequested: {
      totalCount: number;
      incompleteResults: boolean;
      searchLimitReached: boolean;
    };
    assigned: {
      totalCount: number;
      incompleteResults: boolean;
      searchLimitReached: boolean;
    };
  },
};

describe('account GitHub Code Review routes', () => {
  let root: string;
  let env: NodeJS.ProcessEnv;
  let userSettings: string;
  const mount = (accountEnv: Readonly<NodeJS.ProcessEnv> | undefined = env) => {
    const app = express();
    app.use(express.json());
    registerGitHubCodeReviewRoutes(app, {
      accountEnv,
      sendBridgeError,
      mutate: () => (_req, _res, next) => next(),
    });
    return app;
  };
  const enable = (enabled = true) =>
    writeFileSync(
      userSettings,
      JSON.stringify({ experimental: { codeReview: enabled } }),
    );

  beforeEach(() => {
    vi.resetAllMocks();
    root = mkdtempSync(path.join(tmpdir(), 'github-account-'));
    const settingsHome = path.join(root, 'operator-config');
    mkdirSync(settingsHome);
    userSettings = path.join(settingsHome, 'settings.json');
    env = {
      HOME: root,
      QWEN_HOME: settingsHome,
      GH_TOKEN: 'operator-token',
      QWEN_CODE_SYSTEM_SETTINGS_PATH: path.join(root, 'system.json'),
      QWEN_CODE_SYSTEM_DEFAULTS_PATH: path.join(root, 'defaults.json'),
    };
    writeFileSync(userSettings, '{}');
    vi.mocked(fetchGitHubPullRequestInbox).mockResolvedValue({
      kind: 'ok',
      data: inbox,
    });
    vi.mocked(fetchGitHubPullRequestDetail).mockResolvedValue({
      kind: 'not_found',
    });
  });
  afterEach(() => {
    vi.unstubAllEnvs();
    rmSync(root, { recursive: true, force: true });
  });

  it('defaults off and does not read GitHub while disabled', async () => {
    const app = mount();
    const settings = await request(app).get('/github/prs/settings');
    expect(settings.status).toBe(200);
    expect(settings.body).toEqual({
      v: 1,
      enabled: false,
      userEnabled: null,
      locked: false,
    });
    expect((await request(app).get('/github/prs/inbox')).body.code).toBe(
      'feature_disabled',
    );
    expect(fetchGitHubPullRequestInbox).not.toHaveBeenCalled();
  });

  it('writes only user settings, returns the effective value, and preserves unrelated settings', async () => {
    writeFileSync(userSettings, JSON.stringify({ ui: { theme: 'existing' } }));
    const app = mount();
    const response = await request(app)
      .post('/github/prs/settings')
      .send({ enabled: true });
    expect(response.status).toBe(200);
    expect(response.body).toEqual({
      v: 1,
      enabled: true,
      userEnabled: true,
      locked: false,
    });
    expect(JSON.parse(readFileSync(userSettings, 'utf8'))).toMatchObject({
      experimental: { codeReview: true },
      ui: { theme: 'existing' },
    });
    expect((await request(app).get('/github/prs/settings')).body.enabled).toBe(
      true,
    );
  });

  it.each([false, true])(
    'keeps settings in the captured operator home with explicit QWEN_HOME=%s',
    async (explicitQwenHome) => {
      if (!explicitQwenHome) {
        delete env['QWEN_HOME'];
        mkdirSync(path.join(root, '.qwen'));
        userSettings = path.join(root, '.qwen', 'settings.json');
      }
      enable(false);
      const ambientHome = path.join(root, 'ambient-home');
      const ambientQwenHome = path.join(ambientHome, '.qwen');
      mkdirSync(ambientQwenHome, { recursive: true });
      const ambientSettings = path.join(ambientQwenHome, 'settings.json');
      const ambientContent = JSON.stringify({
        experimental: { codeReview: true },
        ui: { theme: 'ambient' },
      });
      writeFileSync(ambientSettings, ambientContent);
      vi.stubEnv('HOME', ambientHome);
      vi.stubEnv('USERPROFILE', ambientHome);
      vi.stubEnv('QWEN_HOME', ambientQwenHome);
      vi.stubEnv('GH_TOKEN', 'ambient-token');
      const app = mount();

      const settings = await request(app).get('/github/prs/settings');
      expect(settings.status).toBe(200);
      expect(settings.body.enabled).toBe(false);
      const updated = await request(app)
        .post('/github/prs/settings')
        .send({ enabled: true });
      expect(updated.status).toBe(200);
      expect(updated.body.enabled).toBe(true);
      expect(
        JSON.parse(readFileSync(userSettings, 'utf8')).experimental.codeReview,
      ).toBe(true);
      expect(readFileSync(ambientSettings, 'utf8')).toBe(ambientContent);
      expect((await request(app).get('/github/prs/inbox')).status).toBe(200);
      expect(fetchGitHubPullRequestInbox).toHaveBeenCalledWith(
        root,
        env,
        1,
        expect.any(Function),
      );
      expect(process.env['HOME']).toBe(ambientHome);
      expect(process.env['QWEN_HOME']).toBe(ambientQwenHome);
    },
  );

  it('ignores workspace settings and keeps process environment credentials out', async () => {
    mkdirSync(path.join(root, '.qwen'));
    writeFileSync(
      path.join(root, '.qwen', 'settings.json'),
      JSON.stringify({
        experimental: { codeReview: true },
        env: { GH_TOKEN: 'workspace-token' },
      }),
    );
    const app = mount();
    expect((await request(app).get('/github/prs/settings')).body.enabled).toBe(
      false,
    );
    enable();
    const response = await request(app).get('/github/prs/inbox?page=2');
    expect(response.status).toBe(200);
    expect(response.body.scope).toBe('account');
    expect(response.body).not.toHaveProperty('workspaceCwd');
    expect(fetchGitHubPullRequestInbox).toHaveBeenCalledWith(
      root,
      expect.objectContaining({ GH_TOKEN: 'operator-token' }),
      2,
      expect.any(Function),
    );
  });

  it('reports system overrides and refuses a user toggle while locked', async () => {
    writeFileSync(
      env['QWEN_CODE_SYSTEM_SETTINGS_PATH']!,
      JSON.stringify({ experimental: { codeReview: false } }),
    );
    enable();
    const app = mount();
    expect((await request(app).get('/github/prs/settings')).body).toEqual({
      v: 1,
      enabled: false,
      userEnabled: true,
      locked: true,
    });
    expect(
      (await request(app).post('/github/prs/settings').send({ enabled: false }))
        .body.code,
    ).toBe('github_setting_locked');
    expect(
      JSON.parse(readFileSync(userSettings, 'utf8')).experimental.codeReview,
    ).toBe(true);
  });

  it('fails closed when the operator environment is not supplied', async () => {
    const app = express();
    registerGitHubCodeReviewRoutes(app, {
      sendBridgeError,
      mutate: () => (_req, _res, next) => next(),
    });
    const response = await request(app).get('/github/prs/inbox');
    expect(response.status).toBe(503);
    expect(response.body.code).toBe('github_account_unavailable');
    expect(fetchGitHubPullRequestInbox).not.toHaveBeenCalled();
  });

  it('reports malformed user settings without changing them', async () => {
    writeFileSync(userSettings, '{broken');
    const response = await request(mount()).get('/github/prs/settings');
    expect(response.status).toBe(503);
    expect(response.body.code).toBe('github_settings_unavailable');
    expect(readFileSync(userSettings, 'utf8')).toBe('{broken');
  });

  it.each([
    '/github/prs/inbox?workspace=missing',
    '/github/prs/inbox?cwd=/foreign',
    '/github/prs/detail?url=x&workspace=primary',
    '/github/prs/settings?cwd=/foreign',
  ])('refuses workspace selectors on %s', async (url) => {
    enable();
    const response = await request(mount()).get(url);
    expect({
      status: response.status,
      body: response.body,
      text: response.text,
    }).toMatchObject({ status: 400, body: { code: 'invalid_github_request' } });
    expect(fetchGitHubPullRequestInbox).not.toHaveBeenCalled();
    expect(fetchGitHubPullRequestDetail).not.toHaveBeenCalled();
  });

  it.each(['0', '21', '1.5', '-1', 'abc'])(
    'rejects search page %s',
    async (page) => {
      enable();
      expect(
        (await request(mount()).get(`/github/prs/inbox?page=${page}`)).body
          .code,
      ).toBe('invalid_github_page');
      expect(fetchGitHubPullRequestInbox).not.toHaveBeenCalled();
    },
  );

  it.each([
    { enabled: 'true' },
    { enabled: true, workspace: '/foreign' },
    {},
    [],
  ])('rejects invalid settings body %j', async (body) => {
    expect(
      (await request(mount()).post('/github/prs/settings').send(body)).status,
    ).toBe(400);
    expect(readFileSync(userSettings, 'utf8')).toBe('{}');
  });

  it('passes complete URLs without a workspace binding and preserves read errors', async () => {
    enable();
    const url = 'https://github.com/other/repo/pull/42';
    const response = await request(mount())
      .get('/github/prs/detail')
      .query({ url });
    expect(response.status).toBe(404);
    expect(response.body.code).toBe('github_pr_not_found');
    expect(fetchGitHubPullRequestDetail).toHaveBeenCalledWith(
      root,
      url,
      env,
      expect.any(Function),
    );
  });

  it('does not publish an in-flight result after the user disables the feature', async () => {
    enable();
    vi.mocked(fetchGitHubPullRequestInbox).mockImplementation(async () => {
      enable(false);
      return { kind: 'ok', data: inbox };
    });
    const response = await request(mount()).get('/github/prs/inbox');
    expect(response.status).toBe(404);
    expect(response.body.code).toBe('feature_disabled');
    expect(response.body).not.toHaveProperty('authored');
  });
});
