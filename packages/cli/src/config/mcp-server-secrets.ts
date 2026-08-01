/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

export const REDACTED_MCP_SECRET = '__redacted__';

type SecretRecord = Record<string, string>;
type SecretBearingMcpServer = {
  env?: SecretRecord;
  headers?: SecretRecord;
  oauth?: { clientSecret?: string; [key: string]: unknown };
};

function recordOf(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function redactRecord(record: SecretRecord | undefined) {
  return record
    ? Object.fromEntries(
        Object.keys(record).map((key) => [key, REDACTED_MCP_SECRET]),
      )
    : record;
}

function restoreRecord(
  incoming: SecretRecord | undefined,
  prior: unknown,
): SecretRecord | undefined {
  if (!incoming) return incoming;
  const priorRecord = recordOf(prior);
  const result: SecretRecord = {};
  for (const [key, value] of Object.entries(incoming)) {
    if (value !== REDACTED_MCP_SECRET) {
      result[key] = value;
    } else if (typeof priorRecord[key] === 'string') {
      result[key] = priorRecord[key];
    }
  }
  return result;
}

export function redactMcpServerSecrets<T extends SecretBearingMcpServer>(
  server: T,
): T {
  return {
    ...server,
    env: redactRecord(server.env),
    headers: redactRecord(server.headers),
    ...(server.oauth?.clientSecret
      ? {
          oauth: {
            ...server.oauth,
            clientSecret: REDACTED_MCP_SECRET,
          },
        }
      : {}),
  } as T;
}

export function restoreRedactedMcpSecrets<T extends SecretBearingMcpServer>(
  server: T,
  existing: Record<string, unknown>,
): T {
  const existingOauth = recordOf(existing['oauth']);
  const incomingSecret = server.oauth?.clientSecret;
  const restoredSecret =
    incomingSecret === REDACTED_MCP_SECRET
      ? existingOauth['clientSecret']
      : incomingSecret;
  return {
    ...server,
    env: restoreRecord(server.env, existing['env']),
    headers: restoreRecord(server.headers, existing['headers']),
    ...(server.oauth
      ? {
          oauth: {
            ...server.oauth,
            ...(typeof restoredSecret === 'string'
              ? { clientSecret: restoredSecret }
              : { clientSecret: undefined }),
          },
        }
      : {}),
  } as T;
}

export function redactMcpServersSetting(value: unknown): unknown {
  const servers = recordOf(value);
  return Object.fromEntries(
    Object.entries(servers).map(([name, server]) => {
      const record = recordOf(server) as SecretBearingMcpServer &
        Record<string, unknown>;
      return [name, redactMcpServerSecrets(record)];
    }),
  );
}

export function restoreRedactedMcpServersSetting(
  value: unknown,
  existing: unknown,
): unknown {
  const servers = recordOf(value);
  const existingServers = recordOf(existing);
  return Object.fromEntries(
    Object.entries(servers).map(([name, server]) => {
      const record = recordOf(server) as SecretBearingMcpServer &
        Record<string, unknown>;
      return [
        name,
        restoreRedactedMcpSecrets(record, recordOf(existingServers[name])),
      ];
    }),
  );
}
