/**
 * @license
 * Copyright 2026 Alibaba Inc.
 * SPDX-License-Identifier: Apache-2.0
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

function npmrcValue(raw: string): string {
  const value = raw.trim();
  if (value.startsWith('"') && value.endsWith('"')) {
    try {
      const parsed: unknown = JSON.parse(value);
      if (typeof parsed === 'string') return parsed;
    } catch {
      return value;
    }
  }
  if (value.startsWith("'") && value.endsWith("'")) return value.slice(1, -1);
  return value
    .replace(
      /\\([\\;#])|[;#].*$/g,
      (_match, escaped: string | undefined) => escaped ?? '',
    )
    .trim();
}

function expandEnv(value: string): string {
  return value.replace(
    /(\\*)\$\{([^}]+)\}/g,
    (match, escapes: string, name: string) => {
      if (escapes.length % 2) return match.slice(1);
      return escapes + (process.env[name] ?? `\${${name}}`);
    },
  );
}

function readNpmrc(filename: string): Map<string, string> {
  let content: string;
  try {
    content = fs.readFileSync(filename, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return new Map();
    throw new Error('Unable to read npm registry configuration');
  }
  const config = new Map<string, string>();
  let inSection = false;
  for (const line of content.split(/\r?\n/)) {
    if (/^\s*\[/.test(line)) inSection = true;
    if (inSection || /^\s*[;#]/.test(line)) continue;
    const match = line.match(/^\s*([^=]+?)\s*=(.*)$/);
    if (!match) continue;
    config.set(
      expandEnv(npmrcValue(match[1])),
      expandEnv(npmrcValue(match[2])),
    );
  }
  return config;
}

export function getGlobalNpmRegistryConfig(packageName: string): {
  registry: URL;
  authorization?: string;
} {
  const env = new Map<string, string>();
  for (const [key, value] of Object.entries(process.env)) {
    if (!/^npm_config_/i.test(key) || !value) continue;
    const suffix = key.slice('npm_config_'.length);
    const name = suffix.startsWith('//')
      ? suffix
      : suffix.toLowerCase().replace(/(?!^)_/g, '-');
    env.set(expandEnv(name), expandEnv(value.trim()));
  }
  const home = os.homedir();
  const configPath = (value: string) => {
    if (/^~(?=\/|$)/.test(value)) {
      if (!path.isAbsolute(home)) {
        throw new Error(
          'Cannot resolve npm configuration without an absolute home directory',
        );
      }
      value = value.replace(/^~/, home);
    }
    return path.resolve(value);
  };
  // Use only the npm shipped beside this interpreter, as the old npm view did.
  const builtin = readNpmrc(
    path.join(
      path.dirname(process.execPath),
      ...(process.platform === 'win32'
        ? ['node_modules', 'npm', 'npmrc']
        : ['..', 'lib', 'node_modules', 'npm', 'npmrc']),
    ),
  );
  const userConfig =
    env.get('userconfig') ??
    builtin.get('userconfig') ??
    (path.isAbsolute(home) ? path.join(home, '.npmrc') : undefined);
  const user = userConfig
    ? readNpmrc(configPath(userConfig))
    : new Map<string, string>();
  let defaultPrefix = path.dirname(process.execPath);
  if (process.platform !== 'win32') {
    defaultPrefix = path.dirname(defaultPrefix);
    if (process.env['DESTDIR']) {
      defaultPrefix = path.join(process.env['DESTDIR'], defaultPrefix);
    }
  }
  if (process.env['PREFIX']) defaultPrefix = process.env['PREFIX'];
  const prefix =
    env.get('prefix') ??
    user.get('prefix') ??
    builtin.get('prefix') ??
    defaultPrefix;
  const global = readNpmrc(
    configPath(
      env.get('globalconfig') ??
        user.get('globalconfig') ??
        builtin.get('globalconfig') ??
        path.join(prefix, 'etc', 'npmrc'),
    ),
  );
  // Match the previous `npm view --global`: project .npmrc is not loaded.
  const config = new Map([...builtin, ...global, ...user, ...env]);
  const scope = packageName.startsWith('@')
    ? packageName.split('/')[0]
    : undefined;
  let registry: URL;
  try {
    registry = new URL(
      (scope && config.get(`${scope}:registry`)) ||
        config.get('registry') ||
        'https://registry.npmjs.org/',
    );
  } catch {
    throw new Error('Invalid npm registry configuration');
  }
  if (
    !['https:', 'http:'].includes(registry.protocol) ||
    registry.username ||
    registry.password
  ) {
    throw new Error('Invalid npm registry configuration');
  }
  if (!registry.pathname.endsWith('/')) registry.pathname += '/';
  registry.search = '';
  registry.hash = '';
  let authPath = registry.pathname;
  for (;;) {
    const key = `//${registry.host}${authPath}:`;
    const token = config.get(`${key}_authToken`);
    const auth = config.get(`${key}_auth`);
    const username = config.get(`${key}username`);
    const password = config.get(`${key}_password`);
    let authorization: string | undefined;
    if (token) authorization = `Bearer ${token}`;
    else if (auth) authorization = `Basic ${auth}`;
    else if (username && password) {
      const decodedPassword = Buffer.from(password, 'base64').toString('utf8');
      authorization = `Basic ${Buffer.from(`${username}:${decodedPassword}`).toString('base64')}`;
    }
    if (authorization) {
      try {
        new Headers({ Authorization: authorization });
      } catch {
        throw new Error('Invalid npm registry authentication configuration');
      }
      return { registry, authorization };
    }
    if (authPath === '') break;
    authPath = authPath.replace(/([^/]+|\/)$/, '');
  }
  return { registry };
}
