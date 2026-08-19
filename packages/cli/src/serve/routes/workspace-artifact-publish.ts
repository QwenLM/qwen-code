/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type { Application, Request, Response } from 'express';
import {
  OssPublisher,
  artifactIdFromPath,
  ossCredentialsFromEnv,
  type ArtifactOssConfig,
} from '@qwen-code/qwen-code-core';
import { loadSettings } from '../../config/settings.js';
import { getNestedProperty } from '../../utils/settingsUtils.js';
import type { SendBridgeError } from '../server/error-response.js';
import {
  MAX_READ_BYTES,
  type ResolvedPath,
  type WorkspaceFileSystem,
  type WorkspaceFileSystemFactory,
} from '../fs/index.js';
import type {
  WorkspaceRegistry,
  WorkspaceRuntime,
} from '../workspace-registry.js';
import {
  getWorkspaceRouteContext,
  requireTrustedWorkspaceRuntime,
  resolveWorkspaceRuntimeFromParam,
  setWorkspaceRouteContext,
} from '../workspace-route-runtime.js';
import { applyReadHeaders } from './workspace-file-read.js';

/**
 * Cap on the document handed to the publisher. Matches the artifact tool's own
 * ceiling so a page the model could publish is also one that can be shared.
 */
const MAX_PUBLISH_BYTES = 16 * 1024 * 1024;

/** Budget for the post-publish reachability probe. */
const REACHABILITY_TIMEOUT_MS = 5_000;

interface OssDestination {
  endpoint: string;
  bucket: string;
  keyPrefix: string;
  publicBaseUrl: string;
}

interface OssCredentialPair {
  accessKeyId: string;
  accessKeySecret: string;
}

interface RememberedTarget {
  destination: Partial<OssDestination>;
  credentials?: OssCredentialPair;
}

/**
 * Targets the user chose not to persist. Deliberately process-local and never
 * written anywhere: closing the daemon forgets them, which is the whole point
 * of the "this run only" choice in the share dialog.
 */
const rememberedTargets = new Map<string, RememberedTarget>();

/** Test seam — the route holds process-global state across requests. */
export function clearRememberedShareTargets(): void {
  rememberedTargets.clear();
}

/**
 * Existing `artifact.oss.*` settings seed the dialog, so a user who already
 * configured the artifact tool does not retype the destination. Credentials are
 * never read from settings — they come from this process or the environment.
 */
function readSettingsDestination(workspaceCwd: string): {
  publisher: string;
  destination: OssDestination;
} {
  const loaded = loadSettings(workspaceCwd, { skipLoadEnvironment: true });
  const merged = loaded.merged as Record<string, unknown>;
  const str = (key: string): string => {
    const value = getNestedProperty(merged, key);
    return typeof value === 'string' ? value.trim() : '';
  };
  return {
    publisher: str('artifact.publisher') || 'local',
    destination: {
      endpoint: str('artifact.oss.endpoint'),
      bucket: str('artifact.oss.bucket'),
      keyPrefix: str('artifact.oss.keyPrefix') || 'artifacts',
      publicBaseUrl: str('artifact.oss.publicBaseUrl'),
    },
  };
}

type CredentialSource = 'request' | 'memory' | 'env' | 'none';

function resolveCredentials(
  workspaceCwd: string,
  fromRequest: OssCredentialPair | undefined,
): { credentials?: OssCredentialPair; source: CredentialSource } {
  if (fromRequest) return { credentials: fromRequest, source: 'request' };
  const remembered = rememberedTargets.get(workspaceCwd)?.credentials;
  if (remembered) return { credentials: remembered, source: 'memory' };
  const env = ossCredentialsFromEnv();
  if (env) {
    return {
      credentials: {
        accessKeyId: env.accessKeyId,
        accessKeySecret: env.accessKeySecret,
      },
      source: 'env',
    };
  }
  return { source: 'none' };
}

function mergeDestination(
  workspaceCwd: string,
  fromSettings: OssDestination,
  fromRequest: Partial<OssDestination>,
): OssDestination {
  const remembered = rememberedTargets.get(workspaceCwd)?.destination ?? {};
  const pick = (key: keyof OssDestination): string =>
    fromRequest[key]?.trim() || remembered[key]?.trim() || fromSettings[key];
  return {
    endpoint: pick('endpoint'),
    bucket: pick('bucket'),
    keyPrefix: pick('keyPrefix') || 'artifacts',
    publicBaseUrl: pick('publicBaseUrl'),
  };
}

function handleConfig(
  res: Response,
  workspaceCwd: string,
  sendBridgeError: SendBridgeError,
  route: string,
): void {
  try {
    applyReadHeaders(res);
    const settings = readSettingsDestination(workspaceCwd);
    const destination = mergeDestination(
      workspaceCwd,
      settings.destination,
      {},
    );
    const { source } = resolveCredentials(workspaceCwd, undefined);
    res.status(200).json({
      v: 1,
      workspaceCwd,
      publisher: settings.publisher,
      endpoint: destination.endpoint,
      bucket: destination.bucket,
      keyPrefix: destination.keyPrefix,
      publicBaseUrl: destination.publicBaseUrl,
      // Only where a usable credential was found — never the credential.
      credentialsSource: source,
    });
  } catch (err) {
    sendBridgeError(res, err, { route });
  }
}

/**
 * A workspace-qualified request carries its own runtime, whose filesystem is
 * scoped to that workspace; only the primary route falls back to the app-level
 * factory.
 */
function getFsFactory(req: Request): WorkspaceFileSystemFactory | undefined {
  const context = getWorkspaceRouteContext(req);
  if (context) return context.runtime.routeFileSystemFactory;
  return (req.app.locals as { fsFactory?: WorkspaceFileSystemFactory })
    .fsFactory;
}

function readString(source: Record<string, unknown>, key: string): string {
  const value = source[key];
  return typeof value === 'string' ? value.trim() : '';
}

/**
 * Reads the whole file. A single read is capped at `MAX_READ_BYTES`, so a page
 * larger than that has to be walked window by window; returns null once the
 * file turns out to be past the publish limit.
 */
async function readWholeFile(
  fs: Pick<WorkspaceFileSystem, 'readBytesWindow'>,
  resolved: ResolvedPath,
): Promise<string | null> {
  const chunks: Buffer[] = [];
  let offset = 0;
  for (;;) {
    const out = await fs.readBytesWindow(resolved, {
      offset,
      maxBytes: MAX_READ_BYTES,
    });
    if (out.sizeBytes > MAX_PUBLISH_BYTES) return null;
    chunks.push(out.buffer);
    offset = out.offset + out.returnedBytes;
    if (offset >= out.sizeBytes) break;
    // A window that returns nothing would spin forever; treat it as the end.
    if (out.returnedBytes <= 0) break;
  }
  return Buffer.concat(chunks).toString('utf8');
}

/**
 * A `public-read` object ACL still 403s when the bucket blocks public access,
 * which the upload itself reports as success. Probing the returned URL is the
 * only way to tell the user their link actually works.
 */
async function probeReachable(
  url: string,
): Promise<{ reachable: boolean | null; reachableStatus?: number }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REACHABILITY_TIMEOUT_MS);
  try {
    const res = await fetch(url, {
      method: 'HEAD',
      signal: controller.signal,
      redirect: 'follow',
    });
    return { reachable: res.ok, reachableStatus: res.status };
  } catch {
    // Network failure or timeout says nothing about the object's visibility.
    return { reachable: null };
  } finally {
    clearTimeout(timer);
  }
}

async function handlePublish(
  req: Request,
  res: Response,
  workspaceCwd: string,
  sendBridgeError: SendBridgeError,
  route: string,
): Promise<void> {
  const body = (req.body ?? {}) as Record<string, unknown>;
  const filePath = readString(body, 'path');
  if (!filePath) {
    res
      .status(400)
      .json({ error: '`path` is required', code: 'invalid_request' });
    return;
  }

  const requestConfig = (
    typeof body['config'] === 'object' && body['config'] !== null
      ? body['config']
      : {}
  ) as Record<string, unknown>;
  const requestAccessKeyId = readString(requestConfig, 'accessKeyId');
  const requestAccessKeySecret = readString(requestConfig, 'accessKeySecret');
  const requestCredentials =
    requestAccessKeyId && requestAccessKeySecret
      ? {
          accessKeyId: requestAccessKeyId,
          accessKeySecret: requestAccessKeySecret,
        }
      : undefined;

  // `artifact.publisher` selects the backend for the artifact *tool*; sharing
  // is its own action and always uploads to OSS. Requiring the tool to be
  // switched over would force a user who wants local artifacts to give that up
  // just to share one page.
  const settings = readSettingsDestination(workspaceCwd);
  const destination = mergeDestination(workspaceCwd, settings.destination, {
    endpoint: readString(requestConfig, 'endpoint'),
    bucket: readString(requestConfig, 'bucket'),
    keyPrefix: readString(requestConfig, 'keyPrefix'),
    publicBaseUrl: readString(requestConfig, 'publicBaseUrl'),
  });
  if (!destination.bucket || !destination.endpoint) {
    res.status(400).json({
      error: 'An OSS bucket and endpoint are required before sharing.',
      code: 'oss_not_configured',
    });
    return;
  }

  const { credentials } = resolveCredentials(workspaceCwd, requestCredentials);
  if (!credentials) {
    res.status(400).json({
      error:
        'No OSS credentials available. Enter them in the share dialog, or set OSS_ACCESS_KEY_ID / OSS_ACCESS_KEY_SECRET in the daemon environment.',
      code: 'oss_credentials_missing',
    });
    return;
  }

  const factory = getFsFactory(req);
  if (!factory) {
    res.status(500).json({
      error: 'workspace filesystem factory is not configured',
      code: 'internal_error',
    });
    return;
  }

  try {
    const fs = factory.forRequest({ route });
    const resolved = await fs.resolve(filePath, 'read');
    const html = await readWholeFile(fs, resolved);
    if (html === null) {
      res.status(400).json({
        error: `Artifact is larger than the ${MAX_PUBLISH_BYTES} byte publish limit.`,
        code: 'artifact_too_large',
      });
      return;
    }

    const config: ArtifactOssConfig = {
      bucket: destination.bucket,
      endpoint: destination.endpoint,
      keyPrefix: destination.keyPrefix,
      ...(destination.publicBaseUrl
        ? { publicBaseUrl: destination.publicBaseUrl }
        : {}),
    };
    const title =
      readString(body, 'title') || resolved.split(/[\\/]/).pop() || 'artifact';

    // The document is published byte-for-byte. The artifact tool's
    // self-contained check and wrapper are deliberately skipped: sharing
    // targets a complete page the agent already wrote, not a fragment.
    const published = await new OssPublisher(config, {
      credentials: () => credentials,
    }).publish({
      id: artifactIdFromPath(resolved),
      title,
      html,
    });

    // Only remember once the target is known to work.
    if (readString(body, 'remember') === 'memory') {
      rememberedTargets.set(workspaceCwd, {
        destination,
        ...(requestCredentials ? { credentials: requestCredentials } : {}),
      });
    }

    const reachability = await probeReachable(published.url);
    applyReadHeaders(res);
    res.status(200).json({
      v: 1,
      workspaceCwd,
      id: published.id,
      url: published.url,
      ...reachability,
    });
  } catch (err) {
    sendBridgeError(res, err, { route });
  }
}

export function registerWorkspaceArtifactPublishRoutes(
  app: Application,
  deps: { boundWorkspace: string; sendBridgeError: SendBridgeError },
): void {
  app.get('/workspace/artifact/publish-config', (_req, res) => {
    handleConfig(
      res,
      deps.boundWorkspace,
      deps.sendBridgeError,
      'GET /workspace/artifact/publish-config',
    );
  });
  app.post('/workspace/artifact/publish', (req, res) => {
    void handlePublish(
      req,
      res,
      deps.boundWorkspace,
      deps.sendBridgeError,
      'POST /workspace/artifact/publish',
    );
  });
}

function resolveTrustedRuntime(
  registry: WorkspaceRegistry,
  req: Request,
  res: Response,
): WorkspaceRuntime | null {
  const runtime = resolveWorkspaceRuntimeFromParam(registry, req, res);
  if (!runtime) return null;
  return requireTrustedWorkspaceRuntime(runtime, res) ? runtime : null;
}

export function registerWorkspaceQualifiedArtifactPublishRoutes(
  app: Application,
  deps: {
    workspaceRegistry: WorkspaceRegistry;
    sendBridgeError: SendBridgeError;
  },
): void {
  app.get('/workspaces/:workspace/artifact/publish-config', (req, res) => {
    const runtime = resolveTrustedRuntime(deps.workspaceRegistry, req, res);
    if (!runtime) return;
    setWorkspaceRouteContext(req, {
      runtime,
      routePrefix: 'GET /workspaces/:workspace',
    });
    handleConfig(
      res,
      runtime.workspaceCwd,
      deps.sendBridgeError,
      'GET /workspaces/:workspace/artifact/publish-config',
    );
  });
  app.post('/workspaces/:workspace/artifact/publish', (req, res) => {
    const runtime = resolveTrustedRuntime(deps.workspaceRegistry, req, res);
    if (!runtime) return;
    setWorkspaceRouteContext(req, {
      runtime,
      routePrefix: 'POST /workspaces/:workspace',
    });
    void handlePublish(
      req,
      res,
      runtime.workspaceCwd,
      deps.sendBridgeError,
      'POST /workspaces/:workspace/artifact/publish',
    );
  });
}
