/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import process from 'node:process';

const SAFE_KEYS = new Set([
  'APPDATA',
  'COMSPEC',
  'HOME',
  'HTTP_PROXY',
  'HTTPS_PROXY',
  'LANG',
  'LC_ALL',
  'LC_CTYPE',
  'LOCALAPPDATA',
  'NO_PROXY',
  'NODE_EXTRA_CA_CERTS',
  'PATH',
  'PATHEXT',
  'SSL_CERT_DIR',
  'SSL_CERT_FILE',
  'SYSTEMROOT',
  'TEMP',
  'TMP',
  'TMPDIR',
  'TZ',
  'USERPROFILE',
  'WINDIR',
]);

export function dwsProcessEnvironment(
  source: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(source)) {
    const normalizedKey = key.toUpperCase();
    if (
      value !== undefined &&
      (SAFE_KEYS.has(normalizedKey) ||
        normalizedKey.startsWith('DWS_') ||
        normalizedKey.startsWith('XDG_'))
    ) {
      environment[key] = value;
    }
  }
  environment['DWS_AGENT_PRODUCT'] = 'qwen-code';
  environment['NO_COLOR'] = '1';
  return environment;
}
