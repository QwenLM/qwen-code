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

type OpenWithAuthOptions = Pick<
  ServeOptions,
  'hostname' | 'serveWebShell' | 'token'
> & {
  requireWebShell?: boolean;
};

export function applyOpenWithAuth(options: OpenWithAuthOptions): void {
  if (!isLoopbackBind(options.hostname)) {
    throw new Error('--open-with-auth requires a loopback --hostname.');
  }
  if (options.serveWebShell === false) {
    throw new Error('--open-with-auth requires the Web Shell; omit --no-web.');
  }
  if (!resolveWebShellDir()) {
    throw new Error('--open-with-auth requires built Web Shell assets.');
  }
  options.requireWebShell = true;

  const configuredToken = resolveServeToken(options.token);
  if (configuredToken) {
    options.token = configuredToken;
    return;
  }

  options.token = randomBytes(32).toString('base64url');
  writeStderrLine(
    'qwen serve: temporary bearer authentication enabled for this Web Shell ' +
      'launch; use an explicit shared token for additional clients.',
  );
}
