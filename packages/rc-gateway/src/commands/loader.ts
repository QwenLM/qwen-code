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

/** A declared positional-argument constraint (front-matter `args:` element). */
export interface ArgDecl {
  /** Label used in errors/audit; constrains the positional arg at its index. */
  name: string;
  /** Whether an absent (and default-less) value fails the invoke. */
  required: boolean;
  /** Auto-filled into the positional array when the value is absent. */
  default?: string;
}

export interface LoadedCommand {
  name: string;
  /** Clamped to ≤140 chars. */
  description: string;
  /** Declared scope. */
  scope: CommandScope;
  tool?: string;
  /** Default 'required'. Captured for listing; not enforced this slice. */
  sessionScope: string;
  /** Declared positional-argument constraints, or undefined (pass-through). */
  args?: ArgDecl[];
  body: string;
  source: 'workspace' | 'user';
}

const NAME_RE = /^[a-z][a-z0-9_-]{0,31}$/;
const ARG_NAME_RE = /^[a-zA-Z][a-zA-Z0-9_-]{0,31}$/;
const SCOPES: readonly CommandScope[] = ['read', 'write', 'approve'];

function isScope(v: unknown): v is CommandScope {
  return typeof v === 'string' && (SCOPES as readonly string[]).includes(v);
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/**
 * Validate a front-matter `args:` value into `ArgDecl[]`. Returns `undefined`
 * when the field is absent (pass-through) and `null` when present-but-malformed
 * (→ the whole command file is rejected). Each element must be a mapping with a
 * regex-valid string `name`, an optional boolean `required` (default false), and
 * an optional string `default`. Unknown element keys are ignored.
 */
export function parseArgDecls(raw: unknown): ArgDecl[] | null | undefined {
  if (raw === undefined) return undefined;
  if (!Array.isArray(raw)) return null;
  const out: ArgDecl[] = [];
  for (const el of raw) {
    if (!isPlainObject(el)) return null;
    const name = el['name'];
    if (typeof name !== 'string' || !ARG_NAME_RE.test(name)) return null;
    const requiredRaw = el['required'];
    if (requiredRaw !== undefined && typeof requiredRaw !== 'boolean') {
      return null;
    }
    const defaultRaw = el['default'];
    if (defaultRaw !== undefined && typeof defaultRaw !== 'string') return null;
    const decl: ArgDecl = { name, required: requiredRaw === true };
    if (defaultRaw !== undefined) decl.default = defaultRaw;
    out.push(decl);
  }
  return out;
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
      // Only a *user* command being shadowed is the "workspace wins over user"
      // collision the audit names. A workspace file shadowing an earlier
      // workspace file (same name twice in one root) is not that event.
      const shadowed = map.get(cmd.name);
      if (shadowed?.source === 'user' && !this.warnedCollisions.has(cmd.name)) {
        this.warnedCollisions.add(cmd.name);
        void this.audit?.record({
          action: 'command_collision_workspace_wins',
          detail: { name: cmd.name },
        });
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
    } catch {
      // Any unreadable root (ENOENT, ENOTDIR when the path is a regular file,
      // EACCES on a 000 dir, …) → no commands from this root. The palette must
      // never break on filesystem state; load() must not reject into a route
      // handler (express 4 has no error middleware here → the request would
      // hang). One bad root simply contributes nothing.
      return [];
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
      const cmd = this.parseCommandFile(text, source, file);
      if (cmd) out.push(cmd);
    }
    return out;
  }

  private parseCommandFile(
    text: string,
    source: 'workspace' | 'user',
    file: string,
  ): LoadedCommand | null {
    const parsed = parseFrontMatter(text);
    // No front-matter → not a command file at all (e.g. a README.md). Skip it
    // silently; only a front-mattered-but-INVALID file is a "parse failure".
    if (!parsed) return null;
    const fm = parsed.frontMatter;

    // Emit slash_command_parse_failed once and return null. `reason` is a short
    // field token, never file content.
    const reject = (reason: string): null => {
      void this.audit?.record({
        action: 'slash_command_parse_failed',
        detail: { file, source, reason },
      });
      return null;
    };

    const name = fm['name'];
    if (typeof name !== 'string' || !NAME_RE.test(name)) return reject('name');

    const description = fm['description'];
    if (typeof description !== 'string' || description.length === 0) {
      return reject('description');
    }

    const scope = fm['scope'];
    if (!isScope(scope)) return reject('scope');

    const args = parseArgDecls(fm['args']);
    if (args === null) return reject('args');

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
    if (args !== undefined) command.args = args;
    return command;
  }
}
