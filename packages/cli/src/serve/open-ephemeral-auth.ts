/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { randomBytes } from 'node:crypto';
import { writeStderrLine } from '../utils/stdioHelpers.js';
import { isLoopbackBind } from './loopback-binds.js';
import { resolveServeToken } from './serve-token.js';
import type { ServeOptions } from './types.js';
import { resolveWebShellDir } from './web-shell-resolver.js';

type OpenEphemeralAuthOptions = Pick<
  ServeOptions,
  'hostname' | 'serveWebShell' | 'token'
>;

export function applyOpenEphemeralAuth(
  options: OpenEphemeralAuthOptions,
  open: boolean,
  ephemeralAuth: boolean,
  env: Readonly<Record<string, string | undefined>> = process.env,
): boolean {
  if (!ephemeralAuth) return false;
  if (!open) {
    throw new Error('--ephemeral-auth requires --open.');
  }
  if (!isLoopbackBind(options.hostname)) {
    throw new Error('--ephemeral-auth requires a loopback --hostname.');
  }
  if (options.serveWebShell === false) {
    throw new Error('--ephemeral-auth requires the Web Shell; omit --no-web.');
  }
  if (!resolveWebShellDir()) {
    throw new Error('--ephemeral-auth requires built Web Shell assets.');
  }
  if (resolveServeToken(options.token, env)) return false;

  options.token = randomBytes(32).toString('base64url');
  writeStderrLine(
    'qwen serve: temporary bearer authentication enabled for this --open ' +
      'launch; use an explicit shared token for additional clients.',
  );
  return true;
}
