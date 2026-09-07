/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { homedir } from 'node:os';
import * as path from 'node:path';
import { Storage } from '@qwen-code/qwen-code-core';

export const SESSION_ATTACHMENTS_ROOT_ENV =
  'QWEN_SERVE_SESSION_ATTACHMENTS_ROOT';

export function defaultSessionAttachmentsRoot(
  workspace: string,
  runtimeBaseDir: string,
): string {
  return path.join(
    new Storage(workspace, runtimeBaseDir).getProjectTempDir(),
    'attachments',
  );
}

export function resolveConfiguredSessionAttachmentsRoot(
  configured: string,
): string {
  const expanded =
    configured === '~'
      ? homedir()
      : configured.startsWith('~/') || configured.startsWith('~\\')
        ? path.join(
            homedir(),
            ...configured
              .slice(2)
              .split(/[/\\]+/)
              .filter(Boolean),
          )
        : configured;
  return path.resolve(process.cwd(), expanded);
}

export function sessionAttachmentsRoots(
  workspace: string,
  runtimeBaseDir: string,
): { root: string; fallback?: string } {
  const defaultRoot = defaultSessionAttachmentsRoot(workspace, runtimeBaseDir);
  const configured = process.env[SESSION_ATTACHMENTS_ROOT_ENV]?.trim();
  if (!configured) return { root: defaultRoot };
  const projectHash = path.basename(path.dirname(defaultRoot));
  return {
    root: path.join(
      resolveConfiguredSessionAttachmentsRoot(configured),
      projectHash,
      'attachments',
    ),
    fallback: defaultRoot,
  };
}
