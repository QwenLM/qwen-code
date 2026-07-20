/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type { Application, Request, Response } from 'express';
import { daemonObservedContactsPath } from '../../commands/channel/runtime.js';
import {
  OBSERVED_CONTACT_MAX_FRESH_WITHIN_SECONDS,
  ObservedChannelContactStore,
} from '../../commands/channel/observed-contact-store.js';
import {
  requireTrustedWorkspaceRuntime,
  resolveWorkspaceRuntimeFromParam,
  sendGenerationClosedError,
  sendUntrustedWorkspaceResponse,
} from '../workspace-route-runtime.js';
import type { WorkspaceRegistry } from '../workspace-registry.js';

interface RegisterWorkspaceChannelObservedContactRoutesDeps {
  primaryWorkspace: string;
  workspaceRegistry: WorkspaceRegistry;
  isWorkspaceTrusted?: () => boolean;
  captureGenerationAssertion?: () => (() => void) | undefined;
}

const DEFAULT_FRESH_WITHIN_SECONDS = 7 * 24 * 60 * 60;

function parseFreshWithinSeconds(req: Request): number | undefined {
  const raw = req.query['freshWithinSeconds'];
  if (raw === undefined) return DEFAULT_FRESH_WITHIN_SECONDS;
  if (typeof raw !== 'string' || !/^\d+$/u.test(raw)) return undefined;
  const value = Number(raw);
  if (
    !Number.isSafeInteger(value) ||
    value < 1 ||
    value > OBSERVED_CONTACT_MAX_FRESH_WITHIN_SECONDS
  ) {
    return undefined;
  }
  return value;
}

function sendContacts(
  req: Request,
  res: Response,
  workspaceCwd: string,
  assertGenerationOpen?: () => void,
): void {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  const freshWithinSeconds = parseFreshWithinSeconds(req);
  if (freshWithinSeconds === undefined) {
    res.status(400).json({
      error: `freshWithinSeconds must be an integer from 1 to ${OBSERVED_CONTACT_MAX_FRESH_WITHIN_SECONDS}.`,
      code: 'invalid_freshness',
    });
    return;
  }
  try {
    assertGenerationOpen?.();
    const store = new ObservedChannelContactStore(
      daemonObservedContactsPath(workspaceCwd),
    );
    const contacts = store.list({ freshWithinSeconds });
    assertGenerationOpen?.();
    res.status(200).json(contacts);
  } catch (error) {
    if (sendGenerationClosedError(res, error)) return;
    process.stderr.write(
      'qwen serve: observed channel contacts unavailable.\n',
    );
    res.status(500).json({
      error: 'Observed channel contacts are unavailable.',
      code: 'channel_observed_contacts_unavailable',
    });
  }
}

export function registerWorkspaceChannelObservedContactRoutes(
  app: Application,
  deps: RegisterWorkspaceChannelObservedContactRoutesDeps,
): void {
  app.get('/workspace/channel/observed-contacts', (req, res) => {
    if (deps.isWorkspaceTrusted?.() === false) {
      sendUntrustedWorkspaceResponse(res);
      return;
    }
    sendContacts(
      req,
      res,
      deps.primaryWorkspace,
      deps.captureGenerationAssertion?.(),
    );
  });

  app.get('/workspaces/:workspace/channel/observed-contacts', (req, res) => {
    const runtime = resolveWorkspaceRuntimeFromParam(
      deps.workspaceRegistry,
      req,
      res,
    );
    if (!runtime || !requireTrustedWorkspaceRuntime(runtime, res)) return;
    sendContacts(req, res, runtime.workspaceCwd, () =>
      runtime.generationGuard?.assertOpen(),
    );
  });
}
