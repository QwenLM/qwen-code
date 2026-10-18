/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { userInfo } from 'node:os';
import path from 'node:path';
import type { Application, Request, RequestHandler } from 'express';
import {
  fetchGitHubPullRequestInbox,
  fetchGitHubPullRequestDetail,
} from '@qwen-code/qwen-code-core/utils/github-code-review.js';
import { GITHUB_PR_ERROR_MESSAGE_MAX } from '@qwen-code/qwen-code-core/utils/github-prs.js';
import { readSettingsSnapshot, SettingScope } from '../../config/settings.js';
import type { SendBridgeError } from '../server/error-response.js';
import { applyReadHeaders } from './workspace-file-read.js';

function routeError(status: number, code: string, message: string): Error {
  return Object.assign(new Error(message), { status, code });
}

function validateQuery(req: Request, allowed: string[]): void {
  if (Object.keys(req.query).some((key) => !allowed.includes(key))) {
    throw routeError(
      400,
      'invalid_github_request',
      'This account route does not accept workspace selectors or other query parameters.',
    );
  }
}

/** Process-global GitHub account reads; credentials never come from a workspace. */
export function registerGitHubCodeReviewRoutes(
  app: Application,
  deps: {
    accountEnv?: Readonly<NodeJS.ProcessEnv>;
    sendBridgeError: SendBridgeError;
    mutate: (opts?: { strict?: boolean }) => RequestHandler;
  },
): void {
  const env = deps.accountEnv
    ? Object.freeze({ ...deps.accountEnv })
    : undefined;
  const context = () => {
    if (!env)
      throw routeError(
        503,
        'github_account_unavailable',
        'The daemon GitHub account environment is unavailable.',
      );
    const cwd = env['HOME'] ?? env['USERPROFILE'] ?? userInfo().homedir;
    if (!path.isAbsolute(cwd))
      throw routeError(
        503,
        'github_account_unavailable',
        'The daemon GitHub account home is unavailable.',
      );
    return { env, cwd };
  };
  const readSettings = () => {
    const { env, cwd } = context();
    try {
      return readSettingsSnapshot(cwd, {
        environment: {
          ...env,
          // The snapshot path helper otherwise defaults to the ambient home.
          QWEN_HOME: env['QWEN_HOME'] || path.join(cwd, '.qwen'),
        },
        workspaceTrusted: false,
      });
    } catch {
      throw routeError(
        503,
        'github_settings_unavailable',
        'The GitHub workbench user settings could not be read.',
      );
    }
  };
  const settingsResponse = () => {
    const settings = readSettings();
    const userValue = settings.user.settings.experimental?.codeReview;
    return {
      v: 1,
      enabled: settings.merged.experimental?.codeReview === true,
      userEnabled: typeof userValue === 'boolean' ? userValue : null,
      locked:
        typeof settings.system.settings.experimental?.codeReview === 'boolean',
    };
  };
  const assertEnabled = () => {
    if (readSettings().merged.experimental?.codeReview !== true)
      throw routeError(404, 'feature_disabled', 'Code Review is disabled.');
  };
  const sendError = (
    res: import('express').Response,
    error: unknown,
    route: string,
  ) => {
    const failure = error as {
      status?: number;
      code?: string;
      message?: string;
    };
    if (failure.status && failure.code) {
      res
        .status(failure.status)
        .json({ code: failure.code, error: failure.message });
      return;
    }
    deps.sendBridgeError(res, error, { route });
  };

  app.get('/github/prs/settings', (req, res) => {
    applyReadHeaders(res);
    try {
      validateQuery(req, []);
      res.json(settingsResponse());
    } catch (error) {
      sendError(res, error, 'GET /github/prs/settings');
    }
  });
  app.post(
    '/github/prs/settings',
    deps.mutate({ strict: true }),
    (req, res) => {
      applyReadHeaders(res);
      try {
        validateQuery(req, []);
        const body = req.body as unknown;
        if (
          !body ||
          typeof body !== 'object' ||
          Array.isArray(body) ||
          Object.keys(body).length !== 1 ||
          typeof (body as Record<string, unknown>)['enabled'] !== 'boolean'
        )
          throw routeError(
            400,
            'invalid_github_request',
            'Expected only an enabled boolean.',
          );
        const settings = readSettings();
        if (
          typeof settings.system.settings.experimental?.codeReview === 'boolean'
        )
          throw routeError(
            409,
            'github_setting_locked',
            'Code Review is controlled by system settings.',
          );
        settings.setValue(
          SettingScope.User,
          'experimental.codeReview',
          (body as { enabled: boolean }).enabled,
          undefined,
          { throwOnWriteFailure: true },
        );
        res.json(settingsResponse());
      } catch (error) {
        sendError(res, error, 'POST /github/prs/settings');
      }
    },
  );

  for (const view of ['inbox', 'detail'] as const) {
    const route = `/github/prs/${view}`;
    app.get(route, async (req, res) => {
      applyReadHeaders(res);
      try {
        validateQuery(req, view === 'inbox' ? ['page'] : ['url']);
        const pageValue = req.query['page'];
        const page =
          pageValue === undefined
            ? 1
            : typeof pageValue === 'string' && /^[1-9]\d*$/.test(pageValue)
              ? Number(pageValue)
              : NaN;
        if (
          view === 'inbox' &&
          (!Number.isInteger(page) || page < 1 || page > 20)
        )
          throw routeError(
            400,
            'invalid_github_page',
            'The search page must be between 1 and 20.',
          );
        const { env, cwd } = context();
        assertEnabled();
        const result =
          view === 'inbox'
            ? await fetchGitHubPullRequestInbox(cwd, env, page, assertEnabled)
            : await fetchGitHubPullRequestDetail(
                cwd,
                typeof req.query['url'] === 'string' ? req.query['url'] : '',
                env,
                assertEnabled,
              );
        assertEnabled();
        if (result.kind === 'ok') {
          res.json({ v: 1, scope: 'account', ...result.data });
          return;
        }
        const failures = {
          invalid_ref: [
            400,
            'invalid_pull_request_ref',
            'Enter a complete GitHub PR URL.',
          ],
          invalid_page: [
            400,
            'invalid_github_page',
            'The search page must be between 1 and 20.',
          ],
          host_mismatch: [
            400,
            'github_host_mismatch',
            'The PR URL must use the configured GitHub account host.',
          ],
          not_found: [
            404,
            'github_pr_not_found',
            'The PR was not found or is not accessible.',
          ],
          cli_unavailable: [
            502,
            'github_cli_unavailable',
            'Install the GitHub CLI on the daemon host and run gh auth login.',
          ],
          failed: [
            502,
            'github_pr_read_failed',
            'Could not read GitHub pull requests.',
          ],
        } as const;
        const [status, code, fallback] = failures[result.kind];
        const message =
          result.kind === 'failed'
            ? result.message
                .split(cwd)
                .join('<home>')
                .slice(0, GITHUB_PR_ERROR_MESSAGE_MAX)
            : fallback;
        res.status(status).json({ code, error: message });
      } catch (error) {
        sendError(res, error, `GET ${route}`);
      }
    });
  }
}
