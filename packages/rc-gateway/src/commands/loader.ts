/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { AuditRecorder } from '../auditLog.js';
import { parseFrontMatter } from './parse.js';

export type CommandScope = 'read' | 'write' | 'approve';

export interface LoadedCommand {
  name: string;
  /** Clamped to ≤140 chars. */
  description: string;
  /** Declared scope. */
  scope: CommandScope;
  tool?: string;
  /** Default 'required'. Captured for listing; not enforced this slice. */
  sessionScope: string;
  body: string;
  source: 'workspace' | 'user';
}

const NAME_RE = /^[a-z][a-z0-9_-]{0,31}$/;
const SCOPES: readonly CommandScope[] = ['read', 'write', 'approve'];

function isScope(v: unknown): v is CommandScope {
  return typeof v === 'string' && (SCOPES as readonly string[]).includes(v);
}

/**
 * Reads repo-tracked + user slash-command definitions from two roots on every
 * `load()` (no watcher; always fresh). Workspace commands shadow user commands
 * of the same name; the first such collision per name is audited once for the
 * loader's lifetime, then suppressed.
 */
export class CommandLoader {
  private readonly warnedCollisions = new Set<string>();

  constructor(
    private readonly resolveWorkspaceCwd: () => Promise<string | undefined>,
    private readonly userCommandsDir: string,
    private readonly audit?: AuditRecorder,
  ) {}

  async load(): Promise<LoadedCommand[]> {
    const userCmds = await this.readDir(this.userCommandsDir, 'user');

    const cwd = await this.resolveWorkspaceCwd();
    const workspaceCmds =
      typeof cwd === 'string' && cwd.length > 0
        ? await this.readDir(join(cwd, '.qwen', 'commands'), 'workspace')
        : [];

    const map = new Map<string, LoadedCommand>();
    for (const cmd of userCmds) map.set(cmd.name, cmd);
    for (const cmd of workspaceCmds) {
      if (map.has(cmd.name)) {
        if (!this.warnedCollisions.has(cmd.name)) {
          this.warnedCollisions.add(cmd.name);
          void this.audit?.record({
            action: 'command_collision_workspace_wins',
            detail: { name: cmd.name },
          });
        }
      }
      map.set(cmd.name, cmd);
    }

    return [...map.values()].sort((a, b) => a.name.localeCompare(b.name));
  }

  private async readDir(
    dir: string,
    source: 'workspace' | 'user',
  ): Promise<LoadedCommand[]> {
    let names: string[];
    try {
      names = await readdir(dir);
    } catch (err) {
      if ((err as NodeJS.ErrnoException)?.code === 'ENOENT') return [];
      throw err;
    }
    const out: LoadedCommand[] = [];
    for (const file of names) {
      if (!file.endsWith('.md')) continue;
      let text: string;
      try {
        text = await readFile(join(dir, file), 'utf8');
      } catch {
        continue;
      }
      const cmd = this.parseCommandFile(text, source);
      if (cmd) out.push(cmd);
    }
    return out;
  }

  private parseCommandFile(
    text: string,
    source: 'workspace' | 'user',
  ): LoadedCommand | null {
    const parsed = parseFrontMatter(text);
    if (!parsed) return null;
    const fm = parsed.frontMatter;

    const name = fm['name'];
    if (typeof name !== 'string' || !NAME_RE.test(name)) return null;

    const description = fm['description'];
    if (typeof description !== 'string' || description.length === 0) {
      return null;
    }

    const scope = fm['scope'];
    if (!isScope(scope)) return null;

    const command: LoadedCommand = {
      name,
      description: description.slice(0, 140),
      scope,
      sessionScope:
        typeof fm['sessionScope'] === 'string'
          ? fm['sessionScope']
          : 'required',
      body: parsed.body,
      source,
    };
    if (typeof fm['tool'] === 'string') command.tool = fm['tool'];
    return command;
  }
}
