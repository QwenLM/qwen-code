/**
 * npm registry support for extension installation and updates.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import * as https from 'node:https';
import * as http from 'node:http';
import * as tar from 'tar';
import type { ExtensionInstallMetadata } from '../config/config.js';
import { ExtensionUpdateState } from './extensionManager.js';
import { createDebugLogger } from '../utils/debugLogger.js';

const debugLogger = createDebugLogger('EXT_NPM');

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
    throw new Error(`Invalid scoped npm package source: ${source}`);
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

/**
 * Fetch JSON from a URL, handling both https and http.
 */
function fetchNpmJson<T>(url: string, authToken?: string): Promise<T> {
  const headers: Record<string, string> = {
    Accept: 'application/json',
  };
  if (authToken) {
    headers['Authorization'] = `Bearer ${authToken}`;
  }

  const client = url.startsWith('https://') ? https : http;

  return new Promise((resolve, reject) => {
    client
      .get(url, { headers }, (res) => {
        if (res.statusCode === 301 || res.statusCode === 302) {
          if (res.headers.location) {
            // Strip auth token when redirected to a different host
            const originalHost = new URL(url).host;
            const redirectHost = new URL(res.headers.location).host;
            const redirectToken =
              redirectHost === originalHost ? authToken : undefined;
            fetchNpmJson<T>(res.headers.location, redirectToken)
              .then(resolve)
              .catch(reject);
            return;
          }
        }
        if (res.statusCode !== 200) {
          return reject(
            new Error(
              `npm registry request failed with status ${res.statusCode}: ${url}`,
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
      .on('error', reject);
  });
}

/**
 * Download a file from a URL, following redirects.
 */
function downloadNpmFile(
  url: string,
  dest: string,
  authToken?: string,
): Promise<void> {
  const headers: Record<string, string> = {};
  if (authToken) {
    headers['Authorization'] = `Bearer ${authToken}`;
  }

  const client = url.startsWith('https://') ? https : http;

  return new Promise((resolve, reject) => {
    client
      .get(url, { headers }, (res) => {
        if (res.statusCode === 301 || res.statusCode === 302) {
          if (res.headers.location) {
            // Strip auth token when redirected to a different host
            const originalHost = new URL(url).host;
            const redirectHost = new URL(res.headers.location).host;
            const redirectToken =
              redirectHost === originalHost ? authToken : undefined;
            downloadNpmFile(res.headers.location, dest, redirectToken)
              .then(resolve)
              .catch(reject);
            return;
          }
        }
        if (res.statusCode !== 200) {
          return reject(
            new Error(
              `Failed to download npm tarball: status ${res.statusCode}`,
            ),
          );
        }
        const file = fs.createWriteStream(dest);
        res.pipe(file);
        file.on('finish', () => file.close(resolve as () => void));
      })
      .on('error', reject);
  });
}

/**
 * Download and extract an extension from an npm registry.
 */
export async function downloadFromNpmRegistry(
  installMetadata: ExtensionInstallMetadata,
  destination: string,
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
  debugLogger.debug(`Fetching npm package metadata from ${metadataUrl}`);

  const metadata = await fetchNpmJson<NpmPackageMetadata>(
    metadataUrl,
    authToken,
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
    `Downloading ${name}@${resolvedVersion} from ${tarballUrl}`,
  );

  // Only send auth token if the tarball is hosted on the same registry host.
  // Private registries often point dist.tarball at a CDN on a different domain;
  // forwarding the registry token there would leak credentials.
  const registryHost = new URL(registryUrl).host;
  const tarballHost = new URL(tarballUrl).host;
  const tarballAuthToken = tarballHost === registryHost ? authToken : undefined;

  // Download tarball
  const tarballPath = path.join(destination, 'package.tgz');
  await downloadNpmFile(tarballUrl, tarballPath, tarballAuthToken);

  // Extract tarball
  await tar.x({
    file: tarballPath,
    cwd: destination,
  });

  // npm tarballs contain a `package/` wrapper directory — flatten it
  const packageDir = path.join(destination, 'package');
  if (fs.existsSync(packageDir)) {
    const entries = await fs.promises.readdir(packageDir);
    for (const entry of entries) {
      await fs.promises.rename(
        path.join(packageDir, entry),
        path.join(destination, entry),
      );
    }
    await fs.promises.rmdir(packageDir);
  }

  // Clean up tarball
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
    debugLogger.error(
      `Failed to check npm update for "${installMetadata.source}": ${error}`,
    );
    return ExtensionUpdateState.ERROR;
  }
}
