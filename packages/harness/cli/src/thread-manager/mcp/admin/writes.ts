/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Writes to the user-level `mcpServers`: validate, create (batch), update,
 * delete and enable/disable.
 *
 * Every write runs inside the settings file lock and first compares the
 * caller's `expectedVersion` with the `mcpServers` on disk; on a mismatch
 * nothing is written (`VERSION_CONFLICT`). A batch is written all or nothing.
 * Replacing an existing entry needs the `confirmToken` from validation, bound
 * to the version and the exact items.
 *
 * After writing, the pool is synced before the call returns, so a host can
 * query a server's tools right after adding it (bounded wait; a server still
 * connecting by then shows as `connecting`).
 */

import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { isRecord } from '@qwen-code/core';
import type { SettingsMutationEditor } from '@qwen-code/resource';
import type { DaemonMcpContext } from './context.js';
import { DaemonMcpError } from './errors.js';
import { describeUserMcpServer, type McpServerSummary } from './queries.js';
import { parseServerId, userMcpServerId } from './serverIds.js';
import {
  canonicalJson,
  configIssues,
  mcpConfigVersion,
  rawUserMcpServers,
  requireReadable,
} from './userSettings.js';

export const MAX_MCP_WRITE_ITEMS = 100;
const MAX_CONFIG_KEY_LENGTH = 200;
const CONFIRM_TOKEN_TTL_MS = 5 * 60 * 1000;
/** Per process: tokens do not survive a daemon restart. */
const CONFIRM_TOKEN_SECRET = randomBytes(32);

/** A user-level entry: by `serverId`, or by `configKey` for one that does not load. */
export type UserServerTarget =
  | { readonly serverId: string; readonly configKey?: never }
  | { readonly configKey: string; readonly serverId?: never };

export interface McpValidateItem {
  readonly configKey: string;
  readonly config: unknown;
  readonly intent: 'create' | 'update';
}

export interface McpValidateResult {
  readonly valid: boolean;
  readonly configVersion: string;
  readonly items: ReadonlyArray<{
    readonly configKey: string;
    readonly ok: boolean;
    readonly issues: readonly string[];
    readonly preview?: 'create' | 'replace' | 'update';
  }>;
  /** Present when the batch is valid and would replace an existing entry. */
  readonly confirmToken?: string;
}

export interface McpCreateItem {
  readonly configKey: string;
  readonly config: unknown;
  readonly onConflict?: 'reject' | 'replace';
}

export interface McpCreateResult {
  readonly configVersion: string;
  readonly items: ReadonlyArray<{
    readonly configKey: string;
    readonly serverId: string;
    readonly action: 'created' | 'replaced';
  }>;
}

export interface McpUpdateResult {
  readonly configVersion: string;
  readonly serverId: string;
}

export interface McpDeleteResult {
  readonly configVersion: string;
  /** The config key removed. */
  readonly deleted: string;
  readonly credentialsDeleted: boolean;
}

export interface McpSetEnabledResult {
  readonly configVersion: string;
  readonly server: McpServerSummary;
}

/** Clock for confirm-token expiry; tests pin it. */
export type Clock = () => number;

export function validateUserMcpServers(
  context: DaemonMcpContext,
  items: readonly McpValidateItem[],
  now: Clock = Date.now,
): McpValidateResult {
  requireItemCount(items.length);
  const current = rawUserMcpServers(
    requireReadable(context.readUserSettings()),
  );
  const configVersion = mcpConfigVersion(current);
  const seen = new Set<string>();
  const results = items.map((item) => {
    const issues = itemIssues(item, seen);
    const exists = Object.hasOwn(current, item.configKey);
    if (item.intent === 'update' && !exists) {
      issues.push(`MCP server "${item.configKey}" does not exist.`);
    }
    const preview: 'create' | 'replace' | 'update' =
      item.intent === 'update' ? 'update' : exists ? 'replace' : 'create';
    return {
      configKey: item.configKey,
      ok: issues.length === 0,
      issues,
      ...(issues.length === 0 ? { preview } : {}),
    } as const;
  });
  const valid = results.every((result) => result.ok);
  const replaces = results.some((result) => result.preview === 'replace');
  return {
    valid,
    configVersion,
    items: results,
    ...(valid && replaces
      ? {
          confirmToken: issueConfirmToken(
            configVersion,
            items.filter((item) => item.intent === 'create'),
            now(),
          ),
        }
      : {}),
  };
}

export async function createUserMcpServers(
  context: DaemonMcpContext,
  request: {
    readonly expectedVersion: string;
    readonly items: readonly McpCreateItem[];
    readonly confirmToken?: string;
  },
  now: Clock = Date.now,
): Promise<McpCreateResult> {
  requireItemCount(request.items.length);
  const seen = new Set<string>();
  const invalid = request.items
    .map((item) => ({
      config_key: item.configKey,
      issues: itemIssues(item, seen),
    }))
    .filter((item) => item.issues.length > 0);
  if (invalid.length > 0) {
    throw new DaemonMcpError(
      'INVALID_CONFIG',
      'Some MCP server configurations are invalid; nothing was written.',
      { items: invalid },
    );
  }
  if (request.items.some((item) => item.onConflict === 'replace')) {
    verifyConfirmToken(
      request.confirmToken,
      request.expectedVersion,
      request.items,
      now(),
    );
  }

  const items: Array<McpCreateResult['items'][number]> = [];
  const configVersion = await writeUserMcpServers(
    context,
    request.expectedVersion,
    (current, editor) => {
      const conflicts = request.items.filter(
        (item) =>
          Object.hasOwn(current, item.configKey) &&
          item.onConflict !== 'replace',
      );
      if (conflicts.length > 0) {
        return new DaemonMcpError(
          'ALREADY_EXISTS',
          'Some MCP servers already exist; nothing was written.',
          { config_keys: conflicts.map((item) => item.configKey) },
        );
      }
      for (const item of request.items) {
        items.push({
          configKey: item.configKey,
          serverId: userMcpServerId(item.configKey),
          action: Object.hasOwn(current, item.configKey)
            ? 'replaced'
            : 'created',
        });
        editor.set(['mcpServers', item.configKey], item.config);
      }
      return undefined;
    },
  );
  return { configVersion, items };
}

/**
 * `replace` swaps the editable fields and keeps `disabled`; `merge` is a
 * shallow top-level merge (a given `env` replaces the old one). An entry that
 * is not an object can only be replaced.
 */
export async function updateUserMcpServer(
  context: DaemonMcpContext,
  request: UserServerTarget & {
    readonly expectedVersion: string;
    readonly mode: 'replace' | 'merge';
    readonly config: unknown;
  },
): Promise<McpUpdateResult> {
  const configKey = configKeyOf(request);
  const patch = request.config;
  if (!isRecord(patch)) {
    throw invalidConfig(configKey, ['config must be an object.']);
  }
  const configVersion = await writeUserMcpServers(
    context,
    request.expectedVersion,
    (current, editor) => {
      if (!Object.hasOwn(current, configKey)) return notFound(configKey);
      const existing = current[configKey];
      let next: Record<string, unknown>;
      if (request.mode === 'replace') {
        const disabled = isRecord(existing) && existing['disabled'] === true;
        next = { ...patch, ...(disabled ? { disabled: true } : {}) };
      } else if (isRecord(existing)) {
        next = { ...existing, ...patch };
      } else {
        return invalidConfig(configKey, [
          'The entry is not an object; use mode "replace".',
        ]);
      }
      const issues = configIssues(configKey, next);
      if (issues.length > 0) return invalidConfig(configKey, issues);
      editor.set(['mcpServers', configKey], next);
      return undefined;
    },
  );
  return { configVersion, serverId: userMcpServerId(configKey) };
}

/** Removes the entry from settings only; credentials are the caller's. */
export async function deleteUserMcpServer(
  context: DaemonMcpContext,
  request: UserServerTarget & { readonly expectedVersion: string },
): Promise<Omit<McpDeleteResult, 'credentialsDeleted'>> {
  const configKey = configKeyOf(request);
  const configVersion = await writeUserMcpServers(
    context,
    request.expectedVersion,
    (current, editor) => {
      if (!Object.hasOwn(current, configKey)) return notFound(configKey);
      editor.delete(['mcpServers', configKey]);
      return undefined;
    },
  );
  return { configVersion, deleted: configKey };
}

/** Writes only `disabled`; config and credentials are kept. */
export async function setUserMcpServerEnabled(
  context: DaemonMcpContext,
  request: {
    readonly serverId: string;
    readonly enabled: boolean;
    readonly expectedVersion?: string;
  },
): Promise<McpSetEnabledResult> {
  const configKey = configKeyOf(request);
  const configVersion = await writeUserMcpServers(
    context,
    request.expectedVersion,
    (current, editor) => {
      if (!isRecord(current[configKey])) return notFound(configKey);
      if (request.enabled) {
        editor.delete(['mcpServers', configKey, 'disabled']);
      } else {
        editor.set(['mcpServers', configKey, 'disabled'], true);
      }
      return undefined;
    },
  );
  return {
    configVersion,
    server: await describeUserMcpServer(context, configKey),
  };
}

// ── internals ──────────────────────────────────────────────────────────────

/**
 * Runs `apply` inside the settings lock against the `mcpServers` on disk.
 * `apply` must not edit when it returns an error, so a rejected write leaves
 * the file untouched. Then syncs the pool. Returns the new version.
 */
async function writeUserMcpServers(
  context: DaemonMcpContext,
  expectedVersion: string | undefined,
  apply: (
    current: Record<string, unknown>,
    editor: SettingsMutationEditor,
  ) => DaemonMcpError | undefined,
): Promise<string> {
  const settings = requireReadable(context.readUserSettings());
  let failure: DaemonMcpError | undefined;
  const written = settings.mutateScope('user', (editor) => {
    const raw = editor.get(['mcpServers']);
    const current = isRecord(raw) ? raw : {};
    if (
      expectedVersion !== undefined &&
      mcpConfigVersion(current) !== expectedVersion
    ) {
      failure = new DaemonMcpError(
        'VERSION_CONFLICT',
        'MCP settings changed since they were read; reload and try again.',
      );
      return;
    }
    failure = apply(current, editor);
  });
  if (failure) throw failure;
  if (!written) {
    throw new DaemonMcpError(
      'WRITE_FAILED',
      'MCP settings could not be saved.',
    );
  }
  const configVersion = mcpConfigVersion(rawUserMcpServers(settings));
  await context.syncPool();
  return configVersion;
}

/** The config key a write targets; plugin servers are read-only. */
function configKeyOf(target: UserServerTarget): string {
  if (target.configKey !== undefined) return target.configKey;
  const parsed = parseServerId(target.serverId);
  if (parsed?.kind === 'plugin' || parsed?.kind === 'enterprise') {
    throw new DaemonMcpError(
      'NOT_WRITABLE',
      `MCP server "${target.serverId}" comes from a plugin; only user-level servers can be changed here.`,
    );
  }
  if (!parsed) {
    throw new DaemonMcpError(
      'NOT_FOUND',
      `Unknown MCP server "${target.serverId}".`,
    );
  }
  return parsed.configKey;
}

function itemIssues(
  item: { readonly configKey: string; readonly config: unknown },
  seen: Set<string>,
): string[] {
  return [
    ...configKeyIssues(item.configKey, seen),
    ...configIssues(item.configKey, item.config),
  ];
}

function configKeyIssues(configKey: string, seen: Set<string>): string[] {
  if (typeof configKey !== 'string' || configKey.length === 0) {
    return ['config_key must be a non-empty string.'];
  }
  const issues: string[] = [];
  if (configKey.trim() !== configKey) {
    issues.push('config_key must not start or end with whitespace.');
  }
  if (configKey.length > MAX_CONFIG_KEY_LENGTH) {
    issues.push(
      `config_key must be at most ${MAX_CONFIG_KEY_LENGTH} characters.`,
    );
  }
  if (seen.has(configKey)) {
    issues.push(`config_key "${configKey}" appears more than once.`);
  }
  seen.add(configKey);
  return issues;
}

function requireItemCount(count: number): void {
  if (count < 1 || count > MAX_MCP_WRITE_ITEMS) {
    throw new DaemonMcpError(
      'INVALID_CONFIG',
      `items must contain 1 to ${MAX_MCP_WRITE_ITEMS} entries.`,
    );
  }
}

function notFound(configKey: string): DaemonMcpError {
  return new DaemonMcpError(
    'NOT_FOUND',
    `Unknown MCP server "${userMcpServerId(configKey)}".`,
  );
}

function invalidConfig(configKey: string, issues: string[]): DaemonMcpError {
  return new DaemonMcpError(
    'INVALID_CONFIG',
    'The MCP server configuration is invalid; nothing was written.',
    { items: [{ config_key: configKey, issues }] },
  );
}

// ── confirm token ──────────────────────────────────────────────────────────

type TokenItems = ReadonlyArray<{ configKey: string; config: unknown }>;

function tokenSubject(version: string, items: TokenItems, expiresAt: number) {
  const canonicalItems = items
    .map((item) => ({ k: item.configKey, c: item.config }))
    .sort((a, b) => (a.k < b.k ? -1 : a.k > b.k ? 1 : 0));
  return `${version}\n${canonicalJson(canonicalItems)}\n${expiresAt}`;
}

function sign(payload: string): string {
  return createHmac('sha256', CONFIRM_TOKEN_SECRET)
    .update(payload)
    .digest('base64url');
}

function issueConfirmToken(
  version: string,
  items: TokenItems,
  now: number,
): string {
  const expiresAt = now + CONFIRM_TOKEN_TTL_MS;
  return `${expiresAt}.${sign(tokenSubject(version, items, expiresAt))}`;
}

function verifyConfirmToken(
  token: string | undefined,
  version: string,
  items: TokenItems,
  now: number,
): void {
  if (!token) {
    throw new DaemonMcpError(
      'CONFIRM_REQUIRED',
      'Replacing an existing MCP server needs the confirm_token from validate.',
    );
  }
  const [expiresAtText, signature] = token.split('.');
  const expiresAt = Number(expiresAtText);
  const expected = sign(tokenSubject(version, items, expiresAt));
  const matches =
    signature !== undefined &&
    signature.length === expected.length &&
    timingSafeEqual(Buffer.from(signature), Buffer.from(expected));
  if (!matches || !Number.isFinite(expiresAt) || now > expiresAt) {
    throw new DaemonMcpError(
      'CONFIRM_EXPIRED',
      'The confirm_token is expired or does not match these items; validate again.',
    );
  }
}
