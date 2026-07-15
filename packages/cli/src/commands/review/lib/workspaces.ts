/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

// Which packages a diff actually touches, and what a review must therefore build.
//
// Agent 7 was told, in prose, to run `npm run build` and then `npm test`, each
// with a 120-second timeout. Measured against the harness's own subagent
// transcripts: **139 command timeouts across 89 review sessions, 71 of them
// `npm run build`**. On this repo the full build takes 98 seconds with a warm
// tree and longer from the cold one a review works in, so the command the skill
// mandates is one that cannot finish inside the deadline the skill sets. Every
// high-effort review spent two minutes on it, learned nothing, and then spent
// several more model turns discovering the timeout, deciding it was
// "environmental", and improvising a narrower command — which is the command it
// should have been handed.
//
// A two-file PR in one package does not need the other fifteen built. The plan
// report already names every changed file and the root `package.json` already
// names the workspaces, so the scope is *derivable*. It is derived here, in code,
// rather than left to an agent to rediscover under a deadline it cannot meet.
//
// Scope is deliberately widened in one direction: a changed workspace's
// **dependents** are built too. A change to a package everything imports can only
// break its consumers at their compile, and a build that skipped them would
// report a green compile for code it never compiled. Narrowing to the changed
// package alone would be fast and wrong; that is the trade this module refuses.

import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

/** One workspace package, as its own `package.json` describes it. */
export interface WorkspacePackage {
  /** Repo-relative directory, e.g. `packages/cli`. */
  dir: string;
  /** The npm package name, e.g. `@qwen-code/cli`. */
  name: string;
  /** Script names it defines (`build`, `test`, …). */
  scripts: string[];
  /** The names of the other workspace packages it depends on. */
  deps: string[];
}

/**
 * Does `npm test --workspaces` reach this file?
 *
 * A test outside every workspace glob is collected by nothing. This is the whole
 * of the #6486 unreachability finding, and it needs no execution at all — just
 * the root `package.json`.
 *
 * Globs here are npm workspace globs, not full minimatch: a trailing `/*` means
 * "one path segment", a leading `!` excludes. Anything fancier is treated as a
 * literal prefix, which errs toward calling a file REACHABLE — the safe
 * direction, since a false "unreachable" finding would be posted to a PR.
 */
export function isWorkspaceMember(
  filePath: string,
  workspaceGlobs: string[],
): boolean {
  return workspaceDirFor(filePath, workspaceGlobs) !== null;
}

/**
 * The workspace directory that owns `filePath`, or null when none does.
 *
 * npm evaluates the globs IN ORDER and the last match wins — a positive glob
 * listed after a negation re-includes what the negation excluded. Walking them in
 * order is what lets `packages/*` own `packages/cli` while an explicitly-listed
 * `packages/channels/base` still wins over it for its own subtree: both match,
 * and the later, more specific entry is the one that decides. A two-pass filter
 * (all negations, then all positives) would let a negation win wherever it sat.
 */
export function workspaceDirFor(
  filePath: string,
  workspaceGlobs: string[],
): string | null {
  const norm = filePath.replace(/^\.\//, '');
  let owner: string | null = null;

  for (const glob of workspaceGlobs) {
    const negated = glob.startsWith('!');
    const g = glob.replace(/^!/, '').replace(/\/$/, '');

    let dir: string | null = null;
    if (g.endsWith('/*')) {
      const base = g.slice(0, -2);
      if (norm.startsWith(`${base}/`)) {
        // `packages/*` owns `packages/cli/**` — one path segment past the base.
        const seg = norm.slice(base.length + 1).split('/')[0];
        if (seg) dir = `${base}/${seg}`;
      }
    } else if (norm === g || norm.startsWith(`${g}/`)) {
      dir = g;
    }

    if (dir === null) continue;
    owner = negated ? null : dir;
  }
  return owner;
}

/** The `workspaces` globs from a repo root's `package.json` (empty when none). */
export function readWorkspaceGlobs(root: string): string[] {
  try {
    const pkg = JSON.parse(
      readFileSync(join(root, 'package.json'), 'utf8'),
    ) as { workspaces?: unknown };
    const ws = pkg.workspaces;
    // npm also accepts `{ "workspaces": { "packages": [...] } }`.
    const globs = Array.isArray(ws)
      ? ws
      : Array.isArray((ws as { packages?: unknown })?.packages)
        ? (ws as { packages: unknown[] }).packages
        : [];
    return globs.filter((g): g is string => typeof g === 'string');
  } catch {
    return [];
  }
}

/** Expand the globs against the tree: every workspace package that exists. */
export function readWorkspacePackages(root: string): WorkspacePackage[] {
  const globs = readWorkspaceGlobs(root);
  const dirs = new Set<string>();

  for (const glob of globs) {
    if (glob.startsWith('!')) continue; // handled by workspaceDirFor, below
    const g = glob.replace(/\/$/, '');
    if (g.endsWith('/*')) {
      const base = g.slice(0, -2);
      let entries: string[];
      try {
        entries = readdirSync(join(root, base), { withFileTypes: true })
          .filter((e) => e.isDirectory())
          .map((e) => e.name);
      } catch {
        continue;
      }
      for (const e of entries) dirs.add(`${base}/${e}`);
    } else {
      dirs.add(g);
    }
  }

  const pkgs: WorkspacePackage[] = [];
  for (const dir of dirs) {
    // A directory a negation excludes is not a workspace, and its own
    // `package.json` says nothing about that — `packages/desktop` is a separate
    // bun workspace with its own lockfile, and building it from here fails.
    if (workspaceDirFor(`${dir}/package.json`, globs) !== dir) continue;
    const manifest = join(root, dir, 'package.json');
    if (!existsSync(manifest)) continue;
    let pkg: {
      name?: unknown;
      scripts?: Record<string, unknown>;
      dependencies?: Record<string, unknown>;
      devDependencies?: Record<string, unknown>;
      peerDependencies?: Record<string, unknown>;
    };
    try {
      pkg = JSON.parse(readFileSync(manifest, 'utf8'));
    } catch {
      continue;
    }
    if (typeof pkg.name !== 'string' || !pkg.name) continue;
    pkgs.push({
      dir,
      name: pkg.name,
      scripts: Object.keys(pkg.scripts ?? {}),
      deps: [
        ...Object.keys(pkg.dependencies ?? {}),
        ...Object.keys(pkg.devDependencies ?? {}),
        ...Object.keys(pkg.peerDependencies ?? {}),
      ],
    });
  }
  return pkgs.sort((a, b) => a.dir.localeCompare(b.dir));
}

/** The workspace dirs a change set touches, in stable order. */
export function affectedWorkspaces(
  changedFiles: string[],
  workspaceGlobs: string[],
): string[] {
  const dirs = new Set<string>();
  for (const f of changedFiles) {
    const d = workspaceDirFor(f, workspaceGlobs);
    if (d) dirs.add(d);
  }
  return [...dirs].sort();
}

/**
 * The build set: every affected workspace, everything it depends on, and
 * everything that depends on it — ordered dependencies-first.
 *
 * Dependents are in the set on purpose. A package's consumers compile against its
 * built types, so a breaking API change surfaces at *their* compile and nowhere
 * else. A build scoped to the changed package alone would come back green and
 * have compiled none of the code the change can actually break.
 *
 * `alsoBuild` is for packages the **compiler** asked for — the ones the declared
 * graph did not predict (see `build-test`'s widening loop). They are dependencies,
 * not changed code, and the distinction is the whole of this parameter: feeding
 * one back in as `affected` makes its consumers "dependents of a changed package"
 * and drags them in too. Measured on PR #6866: widening with `web-templates` that
 * way took the build set from 6 packages to 15 and built the CLI, which the PR
 * does not touch.
 */
export function buildSetFor(
  affected: string[],
  packages: WorkspacePackage[],
  alsoBuild: string[] = [],
): string[] {
  const byDir = new Map(packages.map((p) => [p.dir, p]));
  const byName = new Map(packages.map((p) => [p.name, p]));

  // Forward edges: dir -> the workspace dirs it depends on.
  const dependsOn = new Map<string, string[]>();
  for (const p of packages) {
    dependsOn.set(
      p.dir,
      p.deps
        .map((d) => byName.get(d)?.dir)
        .filter((d): d is string => !!d && d !== p.dir),
    );
  }

  // 1. The affected packages and everything that depends on them, transitively.
  //
  // Reverse-closure over the AFFECTED set only — never over the set as it grows
  // to include dependencies. Seeding it with the dependency closure instead makes
  // every consumer of every dependency a dependent: a leaf change that merely
  // *uses* `core` would drag in everything else that uses `core`, which is the
  // whole monorepo, which is the full build this exists to avoid.
  const consumers = new Set<string>(affected.filter((a) => byDir.has(a)));
  let grew = true;
  while (grew) {
    grew = false;
    for (const p of packages) {
      if (consumers.has(p.dir)) continue;
      if ((dependsOn.get(p.dir) ?? []).some((d) => consumers.has(d))) {
        consumers.add(p.dir);
        grew = true;
      }
    }
  }

  // 2. Those, plus everything they compile against — and plus anything the
  //    compiler explicitly asked for, with its own dependencies. `alsoBuild` joins
  //    HERE, after the reverse closure has been taken, so it brings its
  //    dependencies and not its consumers.
  const wanted = new Set<string>();
  const addDeps = (dir: string): void => {
    if (wanted.has(dir)) return;
    wanted.add(dir);
    for (const d of dependsOn.get(dir) ?? []) addDeps(d);
  };
  for (const c of consumers) addDeps(c);
  for (const extra of alsoBuild) if (byDir.has(extra)) addDeps(extra);

  // Dependencies first. A cycle (npm permits one between workspaces) must not
  // hang or drop a package: the visited set makes the walk terminate, and a
  // package already on the stack is emitted by whichever branch finishes first.
  const order: string[] = [];
  const seen = new Set<string>();
  const visit = (dir: string): void => {
    if (seen.has(dir)) return;
    seen.add(dir);
    for (const d of dependsOn.get(dir) ?? []) {
      if (wanted.has(d)) visit(d);
    }
    order.push(dir);
  };

  // `alsoBuild` is seeded FIRST, and it has to be. The compiler asked for those
  // packages precisely because no declared edge points at them — which is also why
  // the topological sort cannot place them: it has no edge to order them by, so it
  // falls back on the alphabet. On PR #6866 that put `web-templates` *after* the
  // package that needed it, the retry rebuilt the same failure, and the widening
  // that had correctly diagnosed the gap could not close it. A dependency nothing
  // declares is still a dependency; build it before the code that turned out to
  // need it.
  for (const dir of alsoBuild.filter((d) => wanted.has(d)).sort()) visit(dir);
  for (const dir of [...wanted].sort()) visit(dir);
  return order;
}
