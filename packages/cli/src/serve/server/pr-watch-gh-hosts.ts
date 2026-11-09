/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import * as path from 'node:path';
import { parse } from 'yaml';
import { readRegularFile } from '../../commands/autofix-pr/state.js';
import { HOSTNAME_RE } from '../../commands/review/lib/gh.js';
import { normalizeWatchHost } from './pr-watch-observation.js';

/**
 * gh's own config directory, in go-gh's precedence order: `GH_CONFIG_DIR`,
 * `XDG_CONFIG_HOME/gh`, `%AppData%\GitHub CLI` on Windows, `HOME/.config/gh`.
 * The adapter documents the same order when it names the directory in an
 * auth failure; this is the read side of it.
 */
export function ghConfigDir(
  env: Readonly<Record<string, string | undefined>>,
): string | undefined {
  const explicit = env['GH_CONFIG_DIR'];
  if (explicit) return explicit;
  const xdg = env['XDG_CONFIG_HOME'];
  if (xdg) return path.join(xdg, 'gh');
  if (process.platform === 'win32') {
    const appData = env['APPDATA'];
    if (appData) return path.join(appData, 'GitHub CLI');
  }
  const home = env['HOME'];
  return home ? path.join(home, '.config', 'gh') : undefined;
}

/**
 * The hosts the daemon's own `gh` configuration lists, normalised for the
 * watch's allowed-host comparison. Only the mapping's KEYS are read: the
 * values carry oauth tokens and must never be returned or logged.
 *
 * A port is dropped because the watch identity comes from `pullRequestKey`,
 * which drops it too — keeping it here would make an enterprise host with a
 * port never match. An absent file yields an empty set silently (gh is simply
 * not logged in anywhere); an unreadable, non-regular or malformed one yields
 * an empty set with a log line. The caller composes the final allowed set and
 * always includes `github.com`, so a failure here can never silently disable
 * every view.
 */
export function readGhConfiguredHosts(
  env: Readonly<Record<string, string | undefined>>,
  log: (message: string) => void = () => {},
): ReadonlySet<string> {
  const dir = ghConfigDir(env);
  if (!dir) return new Set();
  const filePath = path.join(dir, 'hosts.yml');
  let text: string | null;
  try {
    // Guarded open: a FIFO planted under the name would block the refresh
    // thread, and a link is no config gh wrote.
    text = readRegularFile(filePath);
  } catch (error) {
    log(
      `PR watch: cannot read gh hosts ${filePath}; using the default allowed hosts: ${String(error)}`,
    );
    return new Set();
  }
  if (text === null) return new Set();
  let parsed: unknown;
  try {
    parsed = parse(text);
  } catch (error) {
    // A YAML parse error quotes the offending source line, and a hosts.yml
    // line carries an oauth token. Log only the non-echoing code and line
    // number, never the message.
    const detail = error as {
      code?: unknown;
      linePos?: Array<{ line: number }>;
    };
    const code = typeof detail.code === 'string' ? detail.code : 'unknown';
    const line = detail.linePos?.[0]?.line;
    log(
      `PR watch: cannot parse gh hosts ${filePath} (${code}${
        line !== undefined ? ` at line ${line}` : ''
      }); using the default allowed hosts`,
    );
    return new Set();
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return new Set();
  }
  const hosts = new Set<string>();
  for (const key of Object.keys(parsed)) {
    if (!HOSTNAME_RE.test(key)) continue;
    const withoutPort = key.replace(/:\d+$/, '');
    hosts.add(normalizeWatchHost(withoutPort));
  }
  return hosts;
}
