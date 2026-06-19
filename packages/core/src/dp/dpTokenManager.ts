import * as fs from 'node:fs';
import * as path from 'node:path';

import {
  BLAZE_DP_JWT_ENV,
  BLAZE_DP_TOKEN_ENV,
  getDpCredentialsPath,
  getLegacyNessyCredentialsPath,
  LEGACY_DP_TOKEN_ENV,
  LEGACY_NESSY_DP_AUTH_TOKEN_ENV,
} from './dpConfig.js';
import { exchangeDpToken } from './dpTokenExchangeClient.js';
import { decodeJwt, getJwtExpiryMs } from './jwtDecoder.js';

const EXPIRY_SKEW_MS = 60_000;

export interface DpCredentials {
  jwt: string;
  expiresAt: number;
  username: string;
  userId: string;
}

export interface ResolvedDpCredentials extends DpCredentials {
  source: 'explicit-jwt' | 'env-jwt' | 'cache' | 'legacy-cache' | 'dp-token';
  sourceEnvKey?: string;
}

let cachedCredentials: DpCredentials | null = null;
let cachedCredentialsPath: string | null = null;

function isValid(
  credentials: DpCredentials | null,
): credentials is DpCredentials {
  return Boolean(
    credentials &&
      credentials.jwt &&
      credentials.expiresAt > Date.now() + EXPIRY_SKEW_MS,
  );
}

function credentialsFromJwt(
  jwt: string,
  source: ResolvedDpCredentials['source'],
  sourceEnvKey?: string,
): ResolvedDpCredentials {
  const payload = decodeJwt(jwt);
  const expiresAt = getJwtExpiryMs(jwt);
  if (expiresAt <= Date.now() + EXPIRY_SKEW_MS) {
    throw new Error(
      `${sourceEnvKey || 'DP JWT'} is expired or too close to expiry`,
    );
  }
  return {
    jwt,
    expiresAt,
    username:
      payload.preferred_username ||
      payload.email ||
      (typeof payload.sub === 'string' ? payload.sub : ''),
    userId: typeof payload.sub === 'string' ? payload.sub : '',
    source,
    ...(sourceEnvKey ? { sourceEnvKey } : {}),
  };
}

function parseCredentialsFile(filePath: string): DpCredentials | null {
  if (!fs.existsSync(filePath)) {
    return null;
  }
  try {
    const parsed = JSON.parse(
      fs.readFileSync(filePath, 'utf-8'),
    ) as Partial<DpCredentials>;
    if (
      typeof parsed.jwt === 'string' &&
      typeof parsed.expiresAt === 'number'
    ) {
      return {
        jwt: parsed.jwt,
        expiresAt: parsed.expiresAt,
        username: typeof parsed.username === 'string' ? parsed.username : '',
        userId: typeof parsed.userId === 'string' ? parsed.userId : '',
      };
    }
  } catch {
    return null;
  }
  return null;
}

export function loadCachedCredentials(): ResolvedDpCredentials | null {
  const primaryPath = getDpCredentialsPath();
  if (isValid(cachedCredentials) && cachedCredentialsPath === primaryPath) {
    return { ...cachedCredentials, source: 'cache' };
  }

  const primary = parseCredentialsFile(primaryPath);
  if (isValid(primary)) {
    cachedCredentials = primary;
    cachedCredentialsPath = primaryPath;
    return { ...primary, source: 'cache' };
  }

  const legacyPath = getLegacyNessyCredentialsPath();
  const legacy = parseCredentialsFile(legacyPath);
  if (isValid(legacy)) {
    cachedCredentials = legacy;
    cachedCredentialsPath = legacyPath;
    return { ...legacy, source: 'legacy-cache' };
  }

  return null;
}

export function saveCredentials(credentials: DpCredentials): void {
  cachedCredentials = credentials;
  const filePath = getDpCredentialsPath();
  cachedCredentialsPath = filePath;
  fs.mkdirSync(path.dirname(filePath), { recursive: true, mode: 0o700 });
  fs.writeFileSync(filePath, JSON.stringify(credentials, null, 2), {
    encoding: 'utf-8',
    mode: 0o600,
  });
}

export function hasDpAuthCredentials(): boolean {
  if (
    process.env[BLAZE_DP_JWT_ENV] ||
    process.env[LEGACY_NESSY_DP_AUTH_TOKEN_ENV]
  ) {
    return true;
  }
  if (process.env[BLAZE_DP_TOKEN_ENV] || process.env[LEGACY_DP_TOKEN_ENV]) {
    return true;
  }
  return Boolean(loadCachedCredentials());
}

export async function resolveDpCredentials(
  explicitJwt?: string,
  options: { forceExchange?: boolean } = {},
): Promise<ResolvedDpCredentials> {
  if (explicitJwt) {
    return credentialsFromJwt(explicitJwt, 'explicit-jwt');
  }

  const envJwt = process.env[BLAZE_DP_JWT_ENV];
  if (envJwt) {
    return credentialsFromJwt(envJwt, 'env-jwt', BLAZE_DP_JWT_ENV);
  }

  const legacyEnvJwt = process.env[LEGACY_NESSY_DP_AUTH_TOKEN_ENV];
  if (legacyEnvJwt) {
    return credentialsFromJwt(
      legacyEnvJwt,
      'env-jwt',
      LEGACY_NESSY_DP_AUTH_TOKEN_ENV,
    );
  }

  if (!options.forceExchange) {
    const cached = loadCachedCredentials();
    if (cached) {
      return cached;
    }
  }

  const dpToken =
    process.env[BLAZE_DP_TOKEN_ENV] || process.env[LEGACY_DP_TOKEN_ENV];
  if (dpToken) {
    const response = await exchangeDpToken(dpToken);
    const credentials = credentialsFromJwt(response.jwt, 'dp-token');
    saveCredentials(credentials);
    return credentials;
  }

  throw new Error(
    `DP auth credentials not found. Set ${BLAZE_DP_TOKEN_ENV} or ${LEGACY_DP_TOKEN_ENV} for token exchange, ` +
      `set ${BLAZE_DP_JWT_ENV} or ${LEGACY_NESSY_DP_AUTH_TOKEN_ENV} with a delegated JWT, ` +
      `or provide a valid cache at ${getDpCredentialsPath()}.`,
  );
}

export async function refreshDpCredentials(): Promise<ResolvedDpCredentials> {
  return resolveDpCredentials(undefined, { forceExchange: true });
}
