/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import * as fs from 'node:fs';
import path from 'node:path';
import stripJsonComments from 'strip-json-comments';
import {
  getGlobalQwenDirLite,
  getSystemDefaultsPath,
  getSystemSettingsPath,
} from './storage-paths-lite.js';

export interface ExecutionSandboxSettings {
  backend?: 'auto' | 'bwrap';
  filesystem: 'read-only' | 'workspace-write';
  network: 'open' | 'closed';
}

export class InvalidExecutionSandboxConfigError extends Error {}

export function stripUtf8Bom(content: string): string {
  return content.startsWith('\uFEFF') ? content.slice(1) : content;
}

export const BWRAP_MIGRATION_MESSAGE =
  'Whole-CLI bwrap has been removed. Replace tools.sandbox: "bwrap" / QWEN_SANDBOX=bwrap with tools.executionSandbox: {"backend":"auto","filesystem":"workspace-write","network":"closed"} in User or System settings; remove inherited SANDBOX=bwrap and restart outside the old sandbox.';

export function parseExecutionSandboxSettings(
  value: unknown,
): ExecutionSandboxSettings | undefined {
  if (value === undefined) return undefined;
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    Object.keys(value).some(
      (key) => !['backend', 'filesystem', 'network'].includes(key),
    ) ||
    !('filesystem' in value) ||
    !['read-only', 'workspace-write'].includes(String(value.filesystem)) ||
    !('network' in value) ||
    !['open', 'closed'].includes(String(value.network)) ||
    ('backend' in value &&
      value.backend !== 'auto' &&
      value.backend !== 'bwrap') ||
    typeof value.filesystem !== 'string' ||
    typeof value.network !== 'string'
  ) {
    throw new InvalidExecutionSandboxConfigError(
      'tools.executionSandbox requires literal filesystem (read-only | workspace-write), network (open | closed), and optional backend (auto | bwrap). Unknown fields and environment interpolation are not supported.',
    );
  }
  return { ...(value as ExecutionSandboxSettings) };
}

type SandboxSettingsInput = {
  tools?: { executionSandbox?: unknown; sandbox?: unknown };
};

export function selectOperatorExecutionSandbox(
  ...scopes: SandboxSettingsInput[]
): ExecutionSandboxSettings | undefined {
  let selected: ExecutionSandboxSettings | undefined;
  for (const scope of scopes) {
    const policy = parseExecutionSandboxSettings(scope.tools?.executionSandbox);
    if (policy !== undefined) selected = policy;
  }
  return selected;
}

/** Bare mode still honors operator confinement without loading project/env data. */
export function readOperatorSandboxSettings(): SandboxSettingsInput {
  const userSettingsPath = path.join(getGlobalQwenDirLite(), 'settings.json');
  const scopes = [
    getSystemDefaultsPath(),
    userSettingsPath,
    getSystemSettingsPath(),
  ].map((file) => {
    if (!fs.existsSync(file)) return {};
    let source: string;
    try {
      source = fs.readFileSync(file, 'utf8');
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return {};
      throw new InvalidExecutionSandboxConfigError(
        `Cannot read operator sandbox policy from ${file}: ${String(error)}`,
      );
    }
    try {
      const parsed: unknown = JSON.parse(
        stripJsonComments(stripUtf8Bom(source)),
      );
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        throw new Error('Expected a settings object.');
      }
      return parsed as SandboxSettingsInput;
    } catch (error) {
      let backupPath: string | undefined;
      if (file === userSettingsPath) {
        try {
          backupPath = `${file}.corrupted`;
          fs.copyFileSync(file, backupPath);
        } catch {
          backupPath = undefined;
        }
      }
      throw new InvalidExecutionSandboxConfigError(
        `Cannot read operator sandbox policy from ${file}: ${String(error)}${backupPath ? `. A copy was saved to ${backupPath}` : ''}`,
      );
    }
  });
  const executionSandbox = selectOperatorExecutionSandbox(...scopes);
  const sandbox = scopes.reduce<unknown>(
    (current, scope) => scope.tools?.sandbox ?? current,
    undefined,
  );
  return { tools: { executionSandbox, sandbox } };
}

export function validateExecutionSandboxSelection(
  settings: SandboxSettingsInput,
  args: { sandbox?: boolean | string } = {},
): ExecutionSandboxSettings | undefined {
  const policy = parseExecutionSandboxSettings(
    settings.tools?.executionSandbox,
  );
  const envSelection = process.env['QWEN_SANDBOX']?.trim().toLowerCase();
  const legacy = envSelection || (args.sandbox ?? settings.tools?.sandbox);
  if (
    legacy === 'bwrap' ||
    process.env['SANDBOX']?.trim().toLowerCase() === 'bwrap'
  ) {
    throw new InvalidExecutionSandboxConfigError(BWRAP_MIGRATION_MESSAGE);
  }
  if (
    policy &&
    ((legacy && ![false, '0', 'false'].includes(legacy as string | boolean)) ||
      process.env['SANDBOX']?.trim() ||
      process.env['QWEN_SANDBOX_NET']?.trim() ||
      process.env['QWEN_SANDBOX_PROXY_COMMAND']?.trim())
  ) {
    throw new InvalidExecutionSandboxConfigError(
      'tools.executionSandbox cannot be combined with a whole-CLI sandbox, SANDBOX marker, QWEN_SANDBOX_NET or QWEN_SANDBOX_PROXY_COMMAND. Remove the legacy configuration and restart.',
    );
  }
  return policy;
}

export function assertExecutionSandboxSupported(
  settings: SandboxSettingsInput,
  surface: string,
): void {
  if (validateExecutionSandboxSelection(settings)) {
    throw new InvalidExecutionSandboxConfigError(
      `tools.executionSandbox does not yet support ${surface}. Use the ordinary CLI or terminal UI.`,
    );
  }
}
