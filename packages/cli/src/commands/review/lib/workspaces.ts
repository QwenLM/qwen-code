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
  // The owners that came before the current one — where a negation falls back
  // TO. When a negation excludes a NESTED member (`packages/desktop/*` claimed
  // `packages/desktop/src`, then `!packages/desktop/src` excluded it), the
  // still-included outer member keeps owning the file: npm keeps
  // `packages/desktop` in the graph, and its test runner collects `src/**`.
  // Falling back to the previous owner is what lets that suite feel the
  // change instead of the file being declared felt by nothing.
  const previous: Array<string | null> = [];

  for (const glob of workspaceGlobs) {
    const negated = glob.startsWith('!');
    const g = glob.replace(/^!/, '').replace(/^\.\//, '').replace(/\/$/, '');

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
    if (!negated) {
      if (dir !== owner) {
        previous.push(owner);
        owner = dir;
      }
    } else if (dir === owner) {
      // A negation only excludes the file when it excludes the member that
      // currently owns it. `!packages/desktop/*` matches a deeper pseudo-dir
      // than `packages/*` does, and npm keeps the member itself in the graph
      // (a glob with a subpath cannot match a dir with no subpath), so the
      // member's suite can still feel a change there. When the negation DOES
      // exclude the owner, ownership falls back to the previous, outer member
      // — only a negation of THAT one leaves the file owned by nothing. (The
      // pop does not re-check the popped owner against negations already
      // walked past: a contrived ordering like `!packages/desktop` BEFORE
      // `!packages/desktop/src` can resurrect an excluded owner. Realistic
      // orderings — the outer negation written last — are exact.)
      owner = previous.pop() ?? null;
    }
  }
  return owner;
}

/**
 * True when a positive glob claims `filePath` but a negation excludes it from
 * every member.
 *
 * Such a file belongs to a workspace the npm graph does not contain — this
 * repo's `!packages/desktop` is a separate bun workspace with its own
 * lockfile — so no included workspace's tests can feel a change to it, and it
 * must not earn the incomplete-scope caveat a genuinely outside file does. A
 * file whose nested member is negated while an OUTER member survives
 * (`!packages/desktop/src` under `packages/desktop`) is NOT excluded here:
 * `workspaceDirFor` falls back to the outer member, whose suite collects it.
 */
export function isNegationExcluded(
  filePath: string,
  workspaceGlobs: string[],
): boolean {
  if (workspaceDirFor(filePath, workspaceGlobs) !== null) return false;
  const positives = workspaceGlobs.filter((g) => !g.startsWith('!'));
  return workspaceDirFor(filePath, positives) !== null;
}

/**
 * Does the workspace list use a glob shape `workspaceDirFor` does not model?
 *
 * The walker handles exactly two shapes: a literal path, and a single trailing
 * one-segment star (`packages/` then `*`). npm also permits a globstar
 * (`packages/` then `**`), a prefix star (`packages/foo-`then `*`), and a star in
 * the middle of a path — and for those the walker matches nothing, so a diff
 * inside them yields an EMPTY affected set and the report says "no package to
 * build", a confident false green for the one deterministic check a review has.
 * A caller that cannot model the layout should fall back (report `unsupported`)
 * rather than silently pass, so this flags the shapes it must not guess about.
 */
export function hasUnmodeledWorkspaceGlob(globs: string[]): boolean {
  return globs.some((glob) => {
    const g = glob.replace(/^!/, '').replace(/^\.\//, '');
    if (!g.includes('*')) return false; // a literal path — fully modeled
    // The one modeled star shape: a single trailing `/*` and no other star.
    return !/^[^*]+\/\*$/.test(g);
  });
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

/** The root package as a graph node, with the raw script texts the fan-out detector reads. */
export interface RootPackage extends WorkspacePackage {
  scriptsText: Record<string, string>;
}

/**
 * The root package itself, when it defines a build/test script.
 *
 * For a repo with no `workspaces` field — the most common npm shape — this is
 * the whole scope: treating the root as one package (dir `.`) keeps the
 * install, the scoped deadline, and the timeout-as-data semantics, instead of
 * dropping to a fallback that no longer installs. In a workspace monorepo the
 * root is still a package the TEST graph must see: its `test` script is a
 * suite like any other, and its declared dependencies are reverse edges the
 * closure cannot do without. Returns null when the root has no build/test
 * script to run — there is nothing to scope, and the brief's precedence list
 * takes over.
 */
export function readRootPackage(root: string): RootPackage | null {
  let pkg: ManifestLike;
  try {
    pkg = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8'));
  } catch {
    return null;
  }
  // The JSON literal `null` parses to a value with no scripts or name; the
  // reads below would otherwise throw past the try/catch.
  if (pkg === null) return null;
  const scripts = Object.keys(pkg.scripts ?? {});
  if (!scripts.includes('build') && !scripts.includes('test')) return null;
  const scriptsText: Record<string, string> = {};
  for (const [k, v] of Object.entries(pkg.scripts ?? {})) {
    if (typeof v === 'string') scriptsText[k] = v;
  }
  return {
    dir: '.',
    name: typeof pkg.name === 'string' && pkg.name ? pkg.name : 'root',
    scripts,
    deps: declaredDeps(pkg),
    scriptsText,
  };
}

/**
 * Does a script fan out over every workspace?
 *
 * `npm test --workspaces …` (or the same for `build`) at the root is ONE
 * command that repeats the whole monorepo — the exact run that cannot finish
 * inside a single command deadline on a large repo. A fan-out root TEST is
 * skipped by the test scope with a caveat (rather than pretending the scoped
 * run includes it); a fan-out root BUILD is skipped by the build loop because
 * an aggregator produces no artifacts of its own — the scoped loop already
 * builds the members it drives. Detected from the script text: the
 * `--workspaces` flag (and npm's `-ws`/`--ws` shorthands) is the fan-out;
 * `-w`/`--workspace` (singular) deliberately does NOT match, and neither does
 * an explicit opt-OUT like `--workspaces=false` — the flag must stand alone
 * (whitespace or end), not merely prefix-match. Other aggregators (turbo, nx,
 * lerna) are not modeled and run as written.
 */
export function scriptFansOut(text: unknown): boolean {
  return (
    typeof text === 'string' &&
    /(^|\s)(--workspaces(?=\s|$)|--?ws(?=\s|$))/.test(text)
  );
}

/** The manifest fields this module reads. */
interface ManifestLike {
  name?: unknown;
  scripts?: Record<string, unknown>;
  dependencies?: Record<string, unknown>;
  devDependencies?: Record<string, unknown>;
  peerDependencies?: Record<string, unknown>;
  optionalDependencies?: Record<string, unknown>;
}

/**
 * Declared dependency names — every field npm links workspace members from.
 * `optionalDependencies` included: npm links a workspace member listed there
 * exactly like the other fields (the common shape is a platform-conditional
 * sibling package), so an optional-dependent is a dependent the closure must
 * see.
 */
function declaredDeps(pkg: ManifestLike): string[] {
  return [
    ...Object.keys(pkg.dependencies ?? {}),
    ...Object.keys(pkg.devDependencies ?? {}),
    ...Object.keys(pkg.peerDependencies ?? {}),
    ...Object.keys(pkg.optionalDependencies ?? {}),
  ];
}

/**
 * Every directory the positive globs claim, expanded against the tree.
 *
 * The single expansion `readWorkspacePackages` walks: the dirs it returns a
 * package for and the dirs it reports as skipped both come from this list, so
 * a dir one of them saw and the other did not cannot exist.
 */
function workspaceDirCandidates(root: string, globs: string[]): string[] {
  const dirs = new Set<string>();
  for (const glob of globs) {
    if (glob.startsWith('!')) continue; // negations are applied by workspaceDirFor
    const g = glob.replace(/^\.\//, '').replace(/\/$/, '');
    if (g.endsWith('/*')) {
      const base = g.slice(0, -2);
      let entries: string[];
      try {
        // Follow symlinks: Dirent.isDirectory() is false for one, but npm
        // links a symlinked member as a workspace all the same — dropping it
        // here would be a package the dependency graph cannot see. The
        // package.json probe keeps a broken link from becoming a candidate.
        entries = readdirSync(join(root, base), { withFileTypes: true })
          .filter(
            (e) =>
              e.isDirectory() ||
              (e.isSymbolicLink() &&
                existsSync(join(root, base, e.name, 'package.json'))),
          )
          .map((e) => e.name);
      } catch {
        continue;
      }
      for (const e of entries) dirs.add(`${base}/${e}`);
    } else {
      dirs.add(g);
    }
  }
  return [...dirs].sort();
}

/** The workspace graph a tree expands to, and the dirs it could not read. */
export interface WorkspaceGraph {
  packages: WorkspacePackage[];
  /**
   * Dirs npm treats as workspaces but the graph cannot see: the manifest
   * exists yet does not parse, parses to no usable `name` (missing, empty,
   * not a string, or the JSON literal `null`), or sits under a glob ordering
   * the ownership walk cannot model (a literal member listed before a `*`
   * that claims its parent segment — npm includes it, the walker attributes
   * its files to the star's dir). The shapes fail differently, but all leave
   * a dependent the closure may miss. A manifest that parses to no usable
   * `name` is still linked by npm — under its directory name — so its reverse
   * edges are real edges the graph cannot see. A manifest that does not parse
   * fails `npm install` outright (EJSONPARSE) on a cold tree, but on a
   * pre-installed tree the install is skipped and the graph is still blind to
   * it. Either way the test scope treats a non-empty list as "the graph
   * cannot be trusted".
   */
  skipped: string[];
}

/** Expand the globs against the tree: every workspace package that exists. */
export function readWorkspacePackages(root: string): WorkspaceGraph {
  const globs = readWorkspaceGlobs(root);

  const packages: WorkspacePackage[] = [];
  const skipped: string[] = [];
  for (const dir of workspaceDirCandidates(root, globs)) {
    const manifest = join(root, dir, 'package.json');
    if (!existsSync(manifest)) continue;
    if (workspaceDirFor(`${dir}/package.json`, globs) !== dir) {
      // A directory a negation excludes is not a workspace, and its own
      // `package.json` says nothing about that — `packages/desktop` is a
      // separate bun workspace with its own lockfile, and building it from
      // here fails. The tell: the POSITIVE globs alone still make the dir its
      // own owner, so a negation is what took the ownership away.
      const positives = globs.filter((g) => !g.startsWith('!'));
      if (workspaceDirFor(`${dir}/package.json`, positives) === dir) continue;
      // A later POSITIVE glob took the ownership instead — a literal member
      // listed before a `*` that also claims its parent segment
      // (`['packages/foo/nested', 'packages/*']`). npm includes the member
      // under either entry order, but this walker's last-match-wins model
      // attributes its files to the star's dir, so the graph cannot represent
      // it: disclose the dir as unreadable-by-the-graph rather than silently
      // drop a dependent the closure may need.
      skipped.push(dir);
      continue;
    }
    let pkg: ManifestLike;
    try {
      pkg = JSON.parse(readFileSync(manifest, 'utf8'));
    } catch {
      skipped.push(dir);
      continue;
    }
    // The JSON literal `null` parses fine but has no usable `name`; the
    // property read would otherwise throw past the try/catch.
    if (pkg === null || typeof pkg.name !== 'string' || !pkg.name) {
      skipped.push(dir);
      continue;
    }
    packages.push({
      dir,
      name: pkg.name,
      scripts: Object.keys(pkg.scripts ?? {}),
      deps: declaredDeps(pkg),
    });
  }
  packages.sort((a, b) => a.dir.localeCompare(b.dir));
  skipped.sort();
  return { packages, skipped };
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

/** Forward edges for a package list: dir -> the workspace dirs it depends on. */
function dependencyEdges(packages: WorkspacePackage[]): Map<string, string[]> {
  const byName = new Map(packages.map((p) => [p.name, p]));
  const dependsOn = new Map<string, string[]>();
  for (const p of packages) {
    dependsOn.set(
      p.dir,
      p.deps
        .map((d) => byName.get(d)?.dir)
        .filter((d): d is string => !!d && d !== p.dir),
    );
  }
  return dependsOn;
}

/**
 * The affected workspaces plus everything that depends on them, transitively —
 * the set a change can actually break.
 *
 * This is both the reverse half of `buildSetFor` (a consumer's COMPILE is where
 * a breaking API change surfaces) and the test scope build-test runs (a
 * consumer's TESTS are where a breaking behaviour change surfaces — a change to
 * `core` can leave every dependent compiling and still fail their suites). One
 * definition, so the set that gets built and the set that gets tested cannot
 * drift apart.
 *
 * Closure over the AFFECTED set only — never over the set as it grows to
 * include dependencies. Seeding it with the dependency closure instead makes
 * every consumer of every dependency a dependent: a leaf change that merely
 * *uses* `core` would drag in everything else that uses `core`, which is the
 * whole monorepo, which is the full run this exists to avoid.
 */
export function reverseDependencyClosure(
  affected: string[],
  packages: WorkspacePackage[],
): string[] {
  const byDir = new Map(packages.map((p) => [p.dir, p]));
  const dependsOn = dependencyEdges(packages);
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
  return [...consumers].sort();
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
  const dependsOn = dependencyEdges(packages);

  // 1. The affected packages and everything that depends on them, transitively
  //    (see `reverseDependencyClosure` for why the closure is taken over the
  //    affected set only).
  const consumers = reverseDependencyClosure(affected, packages);

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
