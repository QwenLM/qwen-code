/**
 * npm registry support for extension installation and updates.
 */

import * as fs from 'node:fs';
import type { ClientRequest, IncomingMessage } from 'node:http';
import * as path from 'node:path';
import * as os from 'node:os';
import * as tar from 'tar';
import type { ExtensionInstallMetadata } from '../config/config.js';
import { ExtensionUpdateState } from './extensionManager.js';
import { createDebugLogger } from '../utils/debugLogger.js';
import { redactUrlCredentials } from './redaction.js';
import { clientForUrl } from './http-client.js';
import { assertTarArchiveHasNoLinks } from './archive-safety.js';

const debugLogger = createDebugLogger('EXT_NPM');
const NPM_ARCHIVE_DOWNLOAD_TIMEOUT_MS = 120_000;
const NPM_ARCHIVE_DOWNLOAD_MAX_BYTES = 100 * 1024 * 1024;

export interface NpmDownloadResult {
  version: string;
  type: 'npm';
}

interface NpmPackageMetadata {
  'dist-tags': Record<string, string>;
  versions: Record<
    string,
    {
      dist: {
        tarball: string;
        shasum?: string;
      };
    }
  >;
}

function resolveNpmRedirectUrl(currentUrl: string, location: string): URL {
  try {
    return new URL(location, currentUrl);
  } catch {
    throw new Error(
      `Invalid npm redirect URL: ${redactUrlCredentials(location)}`,
    );
  }
}

/**
 * Parse a scoped npm package source string into name and optional version.
 * Examples:
 *   "@ali/openclaw-tmcp-dingtalk" → { name: "@ali/openclaw-tmcp-dingtalk" }
 *   "@ali/openclaw-tmcp-dingtalk@1.2.0" → { name: "@ali/openclaw-tmcp-dingtalk", version: "1.2.0" }
 *   "@ali/openclaw-tmcp-dingtalk@latest" → { name: "@ali/openclaw-tmcp-dingtalk", version: "latest" }
 */
export function parseNpmPackageSource(source: string): {
  name: string;
  version?: string;
} {
  // Scoped package: @scope/name[@version]
  // First @ is the scope prefix, last @ (after scope/) is the version delimiter
  const match = source.match(/^(@[^/]+\/[^@]+)(?:@(.+))?$/);
  if (!match) {
    throw new Error(
      `Invalid scoped npm package source: ${redactUrlCredentials(source)}`,
    );
  }
  return {
    name: match[1],
    version: match[2],
  };
}

/**
 * Check if a string looks like a scoped npm package.
 */
export function isScopedNpmPackage(source: string): boolean {
  return /^@[a-zA-Z0-9_.-]+\/[a-zA-Z0-9_.-]+(@.+)?$/.test(source);
}

/**
 * Resolve the npm registry URL for a scoped package.
 *
 * Priority:
 * 1. Explicit CLI override (registryOverride parameter)
 * 2. Scoped registry from .npmrc (e.g. @ali:registry=https://...)
 * 3. Default registry from .npmrc
 * 4. Fallback: https://registry.npmjs.org/
 */
export function resolveNpmRegistry(
  scope: string,
  registryOverride?: string,
): string {
  if (registryOverride) {
    return registryOverride.replace(/\/$/, '');
  }

  const npmrcPaths = [
    path.join(process.cwd(), '.npmrc'),
    path.join(os.homedir(), '.npmrc'),
  ];

  let scopedRegistry: string | undefined;
  let defaultRegistry: string | undefined;

  for (const npmrcPath of npmrcPaths) {
    try {
      const content = fs.readFileSync(npmrcPath, 'utf-8');
      const lines = content.split('\n');
      for (const line of lines) {
        const trimmed = line.trim();
        // Scoped registry: @scope:registry=https://...
        const scopeMatch = trimmed.match(
          new RegExp(
            `^${scope.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}:registry\\s*=\\s*(.+)`,
          ),
        );
        if (scopeMatch && !scopedRegistry) {
          scopedRegistry = scopeMatch[1].trim().replace(/\/$/, '');
        }
        // Default registry: registry=https://...
        const defaultMatch = trimmed.match(/^registry\s*=\s*(.+)/);
        if (defaultMatch && !defaultRegistry) {
          defaultRegistry = defaultMatch[1].trim().replace(/\/$/, '');
        }
      }
    } catch {
      // .npmrc doesn't exist at this path, continue
    }
  }

  return scopedRegistry || defaultRegistry || 'https://registry.npmjs.org';
}

/**
 * Get npm auth token for a registry.
 *
 * Priority:
 * 1. NPM_TOKEN environment variable
 * 2. Registry-specific _authToken from .npmrc
 */
function getNpmAuthToken(registryUrl: string): string | undefined {
  const envToken = process.env['NPM_TOKEN'];
  if (envToken) {
    return envToken;
  }

  const npmrcPaths = [
    path.join(process.cwd(), '.npmrc'),
    path.join(os.homedir(), '.npmrc'),
  ];

  // Build candidate prefixes from the registry URL to match against .npmrc
  // entries. For "https://host/path/to/registry/", we try:
  //   //host/path/to/registry/
  //   //host/path/to/
  //   //host/path/
  //   //host/
  // This handles both host-only entries (//registry.npmjs.org/:_authToken=...)
  // and path-scoped entries (//pkgs.dev.azure.com/org/_packaging/feed/npm/registry/:_authToken=...)
  const parsed = new URL(registryUrl);
  const registryPrefixes: string[] = [];
  const pathSegments = parsed.pathname
    .replace(/\/$/, '')
    .split('/')
    .filter(Boolean);
  for (let i = pathSegments.length; i >= 0; i--) {
    const prefix = pathSegments.slice(0, i).join('/');
    registryPrefixes.push(`${parsed.host}${prefix ? `/${prefix}` : ''}`);
  }

  for (const npmrcPath of npmrcPaths) {
    try {
      const content = fs.readFileSync(npmrcPath, 'utf-8');
      const lines = content.split('\n');
      for (const line of lines) {
        const trimmed = line.trim();
        // Format: //host[/path]/:_authToken=TOKEN
        const match = trimmed.match(/^\/\/(.+?)\/:_authToken\s*=\s*(.+)/);
        if (match) {
          const entryPrefix = match[1].replace(/\/$/, '');
          if (registryPrefixes.includes(entryPrefix)) {
            return match[2].trim();
          }
        }
      }
    } catch {
      // .npmrc doesn't exist at this path, continue
    }
  }

  return undefined;
}

function fetchNpmJson<T>(
  url: string,
  authToken?: string,
  signal?: AbortSignal,
): Promise<T> {
  signal?.throwIfAborted();
  const headers: Record<string, string> = {
    Accept: 'application/json',
  };
  if (authToken) {
    headers['Authorization'] = `Bearer ${authToken}`;
  }

  const client = clientForUrl(url);

  return new Promise((resolve, reject) => {
    client
      .get(url, { headers, signal }, (res) => {
        if (res.statusCode === 301 || res.statusCode === 302) {
          if (res.headers.location) {
            let redirectUrl: URL;
            try {
              redirectUrl = resolveNpmRedirectUrl(url, res.headers.location);
            } catch (error) {
              res.resume();
              reject(error);
              return;
            }
            res.resume();
            const originalOrigin = new URL(url).origin;
            const redirectToken =
              redirectUrl.origin === originalOrigin ? authToken : undefined;
            fetchNpmJson<T>(redirectUrl.toString(), redirectToken, signal)
              .then(resolve)
              .catch(reject);
            return;
          }
        }
        if (res.statusCode !== 200) {
          return reject(
            new Error(
              `npm registry request failed with status ${res.statusCode}: ${redactUrlCredentials(url)}`,
            ),
          );
        }
        const chunks: Buffer[] = [];
        res.on('data', (chunk) => chunks.push(chunk));
        res.on('end', () => {
          try {
            resolve(JSON.parse(Buffer.concat(chunks).toString()) as T);
          } catch (e) {
            reject(new Error(`Failed to parse npm registry response: ${e}`));
          }
        });
      })
      .on('error', (error) => {
        reject(signal?.aborted ? signal.reason : error);
      });
  });
}

/**
 * Download a file from a URL, following redirects.
 */
interface NpmDownloadContext {
  activeRequest?: ClientRequest;
  activeResponse?: IncomingMessage;
  activeFile?: fs.WriteStream;
  requestGeneration: number;
  timedOut: boolean;
}

function downloadNpmFileRedirect(
  url: string,
  dest: string,
  context: NpmDownloadContext,
  authToken?: string,
  signal?: AbortSignal,
): Promise<void> {
  const headers: Record<string, string> = {};
  if (authToken) {
    headers['Authorization'] = `Bearer ${authToken}`;
  }

  const client = clientForUrl(url);

  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      resolve();
    };
    const fail = (error: unknown) => {
      if (settled) return;
      settled = true;
      reject(error);
    };
    signal?.throwIfAborted();
    const requestGeneration = ++context.requestGeneration;
    const req = client
      .get(url, { headers, signal }, (res) => {
        if (context.timedOut) {
          res.destroy();
          return;
        }
        context.activeResponse = res;
        if (res.statusCode === 301 || res.statusCode === 302) {
          if (res.headers.location) {
            let redirectUrl: URL;
            try {
              redirectUrl = resolveNpmRedirectUrl(url, res.headers.location);
            } catch (error) {
              res.destroy();
              context.activeResponse = undefined;
              fail(error);
              return;
            }
            const originalOrigin = new URL(url).origin;
            const redirectToken =
              redirectUrl.origin === originalOrigin ? authToken : undefined;
            res.destroy();
            context.activeResponse = undefined;
            downloadNpmFileRedirect(
              redirectUrl.toString(),
              dest,
              context,
              redirectToken,
              signal,
            )
              .then(finish)
              .catch(fail);
            return;
          }
        }
        if (res.statusCode !== 200) {
          fail(
            new Error(
              `Failed to download npm tarball: status ${res.statusCode}`,
            ),
          );
          return;
        }
        const file = fs.createWriteStream(dest);
        context.activeFile = file;
        let bytesWritten = 0;
        res.on('data', (chunk: Buffer) => {
          bytesWritten += chunk.length;
          if (bytesWritten > NPM_ARCHIVE_DOWNLOAD_MAX_BYTES) {
            res.destroy();
            file.destroy();
            fail(
              new Error(
                `npm extension archive download exceeded maximum size of ${NPM_ARCHIVE_DOWNLOAD_MAX_BYTES} bytes`,
              ),
            );
            return;
          }
        });
        res.on('error', (error) => {
          file.destroy();
          fail(error);
        });
        file.on('error', (error) => {
          res.destroy();
          fail(error);
        });
        res.pipe(file);
        file.on('finish', () => file.close(finish));
      })
      .on('error', (error) => {
        fail(signal?.aborted ? signal.reason : error);
      });
    if (requestGeneration === context.requestGeneration) {
      context.activeRequest = req;
    }
  });
}

function downloadNpmFile(
  url: string,
  dest: string,
  authToken?: string,
  signal?: AbortSignal,
): Promise<void> {
  const context: NpmDownloadContext = {
    requestGeneration: 0,
    timedOut: false,
  };
  return new Promise((resolve, reject) => {
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      clearTimeout(hardDeadline);
      resolve();
    };
    const fail = (error: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(hardDeadline);
      reject(error);
    };
    const hardDeadline = setTimeout(() => {
      context.timedOut = true;
      const error = new Error(
        `npm tarball download timed out after ${NPM_ARCHIVE_DOWNLOAD_TIMEOUT_MS}ms`,
      );
      fail(error);
      context.activeRequest?.destroy();
      context.activeResponse?.destroy();
      context.activeFile?.destroy();
    }, NPM_ARCHIVE_DOWNLOAD_TIMEOUT_MS);
    hardDeadline.unref();
    downloadNpmFileRedirect(url, dest, context, authToken, signal)
      .then(finish)
      .catch(fail);
  });
}

/**
 * Download and extract an extension from an npm registry.
 */
export async function downloadFromNpmRegistry(
  installMetadata: ExtensionInstallMetadata,
  destination: string,
  signal?: AbortSignal,
): Promise<NpmDownloadResult> {
  const { name, version: requestedVersion } = parseNpmPackageSource(
    installMetadata.source,
  );
  const scope = name.split('/')[0];
  const registryUrl =
    installMetadata.registryUrl || resolveNpmRegistry(scope, undefined);

  // Store resolved registry for future update checks
  installMetadata.registryUrl = registryUrl;

  const authToken = getNpmAuthToken(registryUrl);

  // Fetch package metadata
  const encodedName = name.replaceAll('/', '%2f');
  const metadataUrl = `${registryUrl}/${encodedName}`;
  debugLogger.debug(
    `Fetching npm package metadata from ${redactUrlCredentials(metadataUrl)}`,
  );

  const metadata = await fetchNpmJson<NpmPackageMetadata>(
    metadataUrl,
    authToken,
    signal,
  );

  // Resolve version
  let resolvedVersion: string;
  if (requestedVersion && requestedVersion !== 'latest') {
    if (metadata.versions[requestedVersion]) {
      resolvedVersion = requestedVersion;
    } else if (metadata['dist-tags'][requestedVersion]) {
      resolvedVersion = metadata['dist-tags'][requestedVersion];
    } else {
      throw new Error(
        `Version "${requestedVersion}" not found for package ${name}`,
      );
    }
  } else {
    resolvedVersion = metadata['dist-tags']['latest'];
    if (!resolvedVersion) {
      throw new Error(`No "latest" dist-tag found for package ${name}`);
    }
  }

  const versionData = metadata.versions[resolvedVersion];
  if (!versionData) {
    throw new Error(
      `Version data for "${resolvedVersion}" not found for package ${name}`,
    );
  }

  const tarballUrl = versionData.dist.tarball;
  debugLogger.debug(
    `Downloading ${name}@${resolvedVersion} from ${redactUrlCredentials(tarballUrl)}`,
  );

  // Only send auth token if the tarball is hosted on the same registry host.
  // Private registries often point dist.tarball at a CDN on a different domain;
  // forwarding the registry token there would leak credentials.
  const registryHost = new URL(registryUrl).host;
  const tarballHost = new URL(tarballUrl).host;
  const tarballAuthToken = tarballHost === registryHost ? authToken : undefined;

  // Download tarball
  const tarballPath = path.join(destination, 'package.tgz');
  await downloadNpmFile(tarballUrl, tarballPath, tarballAuthToken, signal);
  signal?.throwIfAborted();

  // Extract tarball
  await assertTarArchiveHasNoLinks(tarballPath);
  signal?.throwIfAborted();
  await tar.x({
    file: tarballPath,
    cwd: destination,
  });
  signal?.throwIfAborted();

  // npm tarballs contain a `package/` wrapper directory — flatten it
  const packageDir = path.join(destination, 'package');
  if (fs.existsSync(packageDir)) {
    const entries = await fs.promises.readdir(packageDir);
    for (const entry of entries) {
      signal?.throwIfAborted();
      await fs.promises.rename(
        path.join(packageDir, entry),
        path.join(destination, entry),
      );
    }
    signal?.throwIfAborted();
    await fs.promises.rmdir(packageDir);
  }

  // Clean up tarball
  signal?.throwIfAborted();
  await fs.promises.unlink(tarballPath);

  debugLogger.debug(
    `Successfully extracted ${name}@${resolvedVersion} to ${destination}`,
  );

  return {
    version: resolvedVersion,
    type: 'npm',
  };
}

/**
 * Check if an npm-installed extension has an update available.
 */
export async function checkNpmUpdate(
  installMetadata: ExtensionInstallMetadata,
  signal?: AbortSignal,
): Promise<ExtensionUpdateState> {
  try {
    const { name } = parseNpmPackageSource(installMetadata.source);
    const scope = name.split('/')[0];
    const registryUrl =
      installMetadata.registryUrl || resolveNpmRegistry(scope, undefined);
    const authToken = getNpmAuthToken(registryUrl);

    const encodedName = name.replaceAll('/', '%2f');
    const metadataUrl = `${registryUrl}/${encodedName}`;
    const metadata = await fetchNpmJson<NpmPackageMetadata>(
      metadataUrl,
      authToken,
      signal,
    );

    const { version: requestedVersion } = parseNpmPackageSource(
      installMetadata.source,
    );

    // If pinned to an exact version, it's always up-to-date
    if (
      requestedVersion &&
      requestedVersion !== 'latest' &&
      !metadata['dist-tags'][requestedVersion]
    ) {
      return ExtensionUpdateState.UP_TO_DATE;
    }

    // Resolve the target dist-tag (default: "latest")
    const targetTag =
      requestedVersion && metadata['dist-tags'][requestedVersion]
        ? requestedVersion
        : 'latest';
    const targetVersion = metadata['dist-tags'][targetTag];
    if (!targetVersion) {
      debugLogger.error(`No "${targetTag}" dist-tag found for package ${name}`);
      return ExtensionUpdateState.ERROR;
    }

    if (targetVersion !== installMetadata.releaseTag) {
      return ExtensionUpdateState.UPDATE_AVAILABLE;
    }
    return ExtensionUpdateState.UP_TO_DATE;
  } catch (error) {
    signal?.throwIfAborted();
    debugLogger.error(
      `Failed to check npm update for "${redactUrlCredentials(installMetadata.source)}": ${redactUrlCredentials(String(error))}`,
    );
    return ExtensionUpdateState.ERROR;
  }
}
