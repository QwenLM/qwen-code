/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type { Application, RequestHandler } from 'express';
import { ALL_PROVIDERS } from '@qwen-code/qwen-code-core';
import { writeStderrLine } from '../../utils/stdioHelpers.js';
import {
  TooManyActiveDeviceFlowsError,
  UnsupportedDeviceFlowProviderError,
  UpstreamDeviceFlowError,
  type DeviceFlowProviderId,
  type DeviceFlowPublicView,
  type DeviceFlowRegistry,
} from '../auth/device-flow.js';
import { isServeDebugMode } from '../debug-mode.js';
import {
  buildAuthProviderCatalog,
  parseAuthProviderInstallRequest,
} from '../server/auth-provider-helpers.js';
import type { SendBridgeError } from '../server/error-response.js';
import { parseClientIdHeader, safeBody } from '../server/request-helpers.js';
import type {
  ServeAuthProviderInstallRequest,
  ServeAuthProviderInstallResult,
} from '../types.js';

interface RegisterWorkspaceAuthRoutesDeps {
  mutate: (opts?: { strict?: boolean }) => RequestHandler;
  deviceFlowRegistry: DeviceFlowRegistry;
  getSupportedDeviceFlowProviders: () => DeviceFlowProviderId[];
  sendBridgeError: SendBridgeError;
  boundWorkspace: string;
  allowPrivateAuthBaseUrl: boolean;
  installAuthProvider?: (
    req: ServeAuthProviderInstallRequest,
  ) => Promise<ServeAuthProviderInstallResult>;
}

/**
 * Returns true iff the GET / POST caller is the same client that
 * originally started the device flow. Both-undefined is treated as a
 * match (anonymous-start -> anonymous-reattach is the legitimate case).
 *
 * **Threat model:** this is BEST-EFFORT ATTRIBUTION, not authentication.
 * `X-Qwen-Client-Id` is a syntactic header, not bound to a server-
 * validated identity — the bearer token IS the auth boundary. This gate
 * prevents accidental cross-client reads in well-behaved multi-SDK setups.
 */
function callerIsDeviceFlowInitiator(
  view: Pick<DeviceFlowPublicView, 'initiatorClientId'>,
  callerClientId: string | undefined,
): boolean {
  return (
    (view.initiatorClientId === undefined && callerClientId === undefined) ||
    (view.initiatorClientId !== undefined &&
      callerClientId !== undefined &&
      callerClientId === view.initiatorClientId)
  );
}

/**
 * Translate the registry's redacted `DeviceFlowPublicView` into the
 * wire shape for start responses. Splitting "start response" from
 * "state body" preserves the `attached` field without polluting GET.
 */
function toDeviceFlowStartResponseBody(
  view: DeviceFlowPublicView,
  attached: boolean,
  callerClientId?: string,
): Record<string, unknown> {
  const body: Record<string, unknown> = {
    deviceFlowId: view.deviceFlowId,
    providerId: view.providerId,
    status: view.status,
    expiresAt: view.expiresAt ?? 0,
    intervalMs: view.intervalMs ?? 0,
    attached,
  };
  // Only the original starter sees the verification material.
  if (callerIsDeviceFlowInitiator(view, callerClientId)) {
    body['userCode'] = view.userCode ?? '';
    body['verificationUri'] = view.verificationUri ?? '';
    if (view.verificationUriComplete) {
      body['verificationUriComplete'] = view.verificationUriComplete;
    }
  }
  // Only echo `initiatorClientId` back when the caller matches.
  if (
    view.initiatorClientId &&
    callerClientId !== undefined &&
    callerClientId === view.initiatorClientId
  ) {
    body['initiatorClientId'] = view.initiatorClientId;
  }
  return body;
}

function toDeviceFlowStateBody(
  view: DeviceFlowPublicView,
  callerClientId?: string,
): Record<string, unknown> {
  const body: Record<string, unknown> = {
    deviceFlowId: view.deviceFlowId,
    providerId: view.providerId,
    status: view.status,
    createdAt: view.createdAt,
  };
  if (view.errorKind) body['errorKind'] = view.errorKind;
  if (view.hint) body['hint'] = view.hint;
  if (view.expiresAt !== undefined) body['expiresAt'] = view.expiresAt;
  if (view.intervalMs !== undefined) body['intervalMs'] = view.intervalMs;
  if (view.lastPolledAt !== undefined) body['lastPolledAt'] = view.lastPolledAt;
  // Only echo verification fields to the original starter.
  if (callerIsDeviceFlowInitiator(view, callerClientId)) {
    if (view.userCode) body['userCode'] = view.userCode;
    if (view.verificationUri) body['verificationUri'] = view.verificationUri;
    if (view.verificationUriComplete) {
      body['verificationUriComplete'] = view.verificationUriComplete;
    }
    if (view.initiatorClientId) {
      body['initiatorClientId'] = view.initiatorClientId;
    }
  }
  return body;
}

export function registerWorkspaceAuthRoutes(
  app: Application,
  deps: RegisterWorkspaceAuthRoutesDeps,
): void {
  const {
    mutate,
    deviceFlowRegistry,
    getSupportedDeviceFlowProviders,
    sendBridgeError,
    boundWorkspace,
    allowPrivateAuthBaseUrl,
    installAuthProvider,
  } = deps;

  app.post(
    '/workspace/auth/device-flow',
    mutate({ strict: true }),
    async (req, res) => {
      const body = safeBody(req);
      const providerIdRaw = body['providerId'];
      if (typeof providerIdRaw !== 'string' || providerIdRaw.length === 0) {
        res.status(400).json({
          error: '`providerId` must be a non-empty string',
          code: 'invalid_request',
        });
        return;
      }
      // Validate against the runtime provider map (not the static
      // tuple) so injected providers are accepted.
      const supportedProviders = getSupportedDeviceFlowProviders();
      if (!supportedProviders.includes(providerIdRaw as DeviceFlowProviderId)) {
        res.status(400).json({
          error: `Unsupported device-flow provider: ${providerIdRaw}`,
          code: 'unsupported_provider',
          supportedProviders,
        });
        return;
      }
      const providerId = providerIdRaw as DeviceFlowProviderId;
      const clientId = parseClientIdHeader(req, res);
      if (clientId === null) return;
      try {
        const { view, attached } = await deviceFlowRegistry.start({
          providerId,
          ...(clientId !== undefined ? { initiatorClientId: clientId } : {}),
        });
        // Idempotent take-over → 200 with `attached: true`. Fresh start →
        // 201 + `attached: false`. The registry is the source of truth on
        // which branch fired (it's the one that decided not to call
        // `provider.start()` again).
        res
          .status(attached ? 200 : 201)
          .json(toDeviceFlowStartResponseBody(view, attached, clientId));
      } catch (err) {
        if (err instanceof UnsupportedDeviceFlowProviderError) {
          res
            .status(400)
            .json({ error: err.message, code: 'unsupported_provider' });
          return;
        }
        if (err instanceof TooManyActiveDeviceFlowsError) {
          res
            .status(409)
            .json({ error: err.message, code: 'too_many_active_flows' });
          return;
        }
        if (err instanceof UpstreamDeviceFlowError) {
          // IdP-side failure (network / parse / non-2xx). 502 distinguishes
          // "the upstream we depend on misbehaved" from a daemon bug (5xx
          // generic) so SDK clients can branch on retry strategy.
          res.status(502).json({ error: err.message, code: 'upstream_error' });
          return;
        }
        sendBridgeError(res, err, {
          route: 'POST /workspace/auth/device-flow',
        });
      }
    },
  );

  // GET surfaces verification material; strict-gated + caller-identity
  // check so only the original initiator sees `userCode` etc.
  app.get(
    '/workspace/auth/device-flow/:id',
    mutate({ strict: true }),
    async (req, res) => {
      const id = req.params['id'];
      if (!id) {
        res.status(404).json({
          error: 'Device-flow id required',
          code: 'device_flow_not_found',
        });
        return;
      }
      const view = deviceFlowRegistry.get(id);
      if (!view) {
        res.status(404).json({
          error: `Device-flow ${id} not found`,
          code: 'device_flow_not_found',
        });
        return;
      }
      const clientId = parseClientIdHeader(req, res);
      if (clientId === null) return;
      // Debug-mode breadcrumb when verification fields are redacted
      // due to caller-clientId mismatch.
      if (!callerIsDeviceFlowInitiator(view, clientId) && isServeDebugMode()) {
        writeStderrLine(
          `qwen serve debug: GET /workspace/auth/device-flow/${id} redacted verification fields — caller-clientId mismatch (initiator=${view.initiatorClientId ?? 'anonymous'}, caller=${clientId ?? 'anonymous'})`,
        );
      }
      res.status(200).json(toDeviceFlowStateBody(view, clientId));
    },
  );

  app.delete(
    '/workspace/auth/device-flow/:id',
    mutate({ strict: true }),
    (req, res) => {
      const id = req.params['id'];
      if (!id) {
        res.status(404).json({
          error: 'Device-flow id required',
          code: 'device_flow_not_found',
        });
        return;
      }
      const clientId = parseClientIdHeader(req, res);
      if (clientId === null) return;
      const result = deviceFlowRegistry.cancel(id, clientId);
      if (result === undefined) {
        res.status(404).json({
          error: `Device-flow ${id} not found`,
          code: 'device_flow_not_found',
        });
        return;
      }
      // Both freshly-cancelled and already-terminal are 204 (idempotent).
      res.status(204).end();
    },
  );

  app.get('/workspace/auth/status', (_req, res) => {
    const pending = deviceFlowRegistry.listPending();
    res.status(200).json({
      v: 1,
      workspaceCwd: boundWorkspace,
      providers: [],
      pendingDeviceFlows: pending.map((view) => ({
        deviceFlowId: view.deviceFlowId,
        providerId: view.providerId,
        ...(view.expiresAt !== undefined ? { expiresAt: view.expiresAt } : {}),
      })),
      // Derive from runtime provider map (single source of truth).
      supportedDeviceFlowProviders: getSupportedDeviceFlowProviders(),
    });
  });

  app.get('/workspace/auth/providers', (_req, res) => {
    res.status(200).json(buildAuthProviderCatalog(boundWorkspace));
  });

  app.post(
    '/workspace/auth/provider',
    mutate({ strict: true }),
    async (req, res) => {
      if (!installAuthProvider) {
        res.status(501).json({
          error: 'Auth provider installation is not implemented by this daemon',
          code: 'not_implemented',
        });
        return;
      }
      const parsed = parseAuthProviderInstallRequest(safeBody(req), {
        allowPrivateBaseUrl: allowPrivateAuthBaseUrl,
      });
      if (!parsed.ok) {
        res.status(400).json({
          error: parsed.error,
          code: parsed.code,
        });
        return;
      }
      const installRequest = parsed.value;
      const knownProvider = ALL_PROVIDERS.find(
        (provider) => provider.id === installRequest.providerId,
      );
      if (!knownProvider) {
        res.status(400).json({
          error: `Unsupported auth provider: ${installRequest.providerId}`,
          code: 'unsupported_provider',
        });
        return;
      }
      if (installRequest.protocol) {
        const allowedProtocols =
          knownProvider.protocolOptions && knownProvider.protocolOptions.length
            ? knownProvider.protocolOptions
            : [knownProvider.protocol];
        if (!allowedProtocols.includes(installRequest.protocol)) {
          res.status(400).json({
            error: `protocol must be one of: ${allowedProtocols.join(', ')}`,
            code: 'unsupported_protocol',
          });
          return;
        }
      }
      try {
        res.status(200).json(await installAuthProvider(installRequest));
      } catch (err) {
        sendBridgeError(res, err, {
          route: 'POST /workspace/auth/provider',
          providerId: installRequest.providerId,
        });
      }
    },
  );
}
