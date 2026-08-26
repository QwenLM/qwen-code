/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

// Provision a review worktree's dependencies from a host-level cache, so a
// probe can run a test without anyone paying for an install.
//
// The worktree `fetch-pr` builds is a bare checkout: no `node_modules`, no
// built workspace `dist`. On a laptop that is fine — Agent 7's `build-test`
// installs once and everything after it reuses the tree. In CI it is not:
// a full `npm ci` plus the prepare build does not fit inside one agent's
// tool budget, so every probe or chunk agent that decides the right evidence
// is "run the test" burned its budget on a doomed install and the round
// downgraded to a read-only audit with a "tool budget reached" disclosure —
// PR #9729 rounds 13 and 15, PR #9940's own review, and issue #10108, which
// this module closes. The persistent runners can hold a host cache; what was
// missing is the wiring from that cache into the worktree.
//
// The wiring is a link farm, not a copy and not an install: the cache entry
// holds a real `npm ci` result (root and nested `node_modules`, every
// workspace's built `dist`, keyed by the lockfile that produced them), and
// this module mirrors it into the worktree the way `exposeDependencies`
// mirrors the worktree into a scratch tree — entry-wise symlinks, seconds of
// wall clock. Three deliberate differences from that sibling farm:
//
//   - **Workspace self-links point at the WORKTREE's members, never the
//     cache's.** npm's `@scope/pkg -> ../../packages/pkg` links are what make
//     a package import its sibling BY NAME, and mirrored from the cache they
//     would resolve to the BASE's copy of every sibling — so a probe of code
//     that imports a changed sibling would quietly test the code the PR is a
//     change TO. The self-links are therefore re-derived from the worktree's
//     own manifest, and the cache's are skipped.
//   - **`dist` is copied, not linked.** The rebuilt `dist` of a changed
//     package must be writable in place (Agent 7's scoped build overwrites
//     it), and a write through a link would land in the shared cache.
//   - **npm's completeness marker is placed only on a clean farm.**
//     `build-test` gates its install on `node_modules/.package-lock.json`,
//     so the marker is what makes the provisioned tree count as installed —
//     and a farm that dropped packages must NOT claim that, or the missing
//     module surfaces later as a defect in the diff. A partial farm stays
//     markerless and `npm ci` repairs it on the old path.
//
// Everything here is best-effort and fail-open toward today's behaviour: a
// cold cache, a diverged lockfile, a farm that could not complete — each is a
// recorded reason in the plan report, never a thrown error, because the
// fallback (a disclosed read-only round) is exactly what every review did
// before this module existed.

import {
  copyFileSync,
  cpSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import type { Dirent } from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { readWorkspacePackages } from './workspaces.js';

/**
 * The file the CI population step writes LAST into a cache entry (the stage
 * directory is renamed into place atomically, so the marker's presence means
 * the whole entry landed). An entry without it is a torn or in-progress
 * snapshot and is never farmed from.
 */
export const DEPS_COMPLETE_MARKER = '.qwen-review-deps-complete';

/**
 * The provenance file this farm writes into the worktree's `node_modules`,
 * naming the cache entry it links into. Deliberately the same name
 * `exposeDependencies`' own farms use, because it answers the same question —
 * "who built this directory, and from where" — and `provisionSourceOf` reads
 * it back so the scratch-tree farm can treat links into the cache as the
 * borrowed dependencies they are rather than as escapes.
 */
export const PROVISION_MARKER = '.qwen-review-farm';

/** The environment variable naming the host cache root, set by CI. */
export const DEPS_CACHE_ENV = 'QWEN_REVIEW_DEPS_CACHE';

/** What provisioning did to the worktree, recorded in the plan report. */
export interface WorktreeDependencyProvision {
  /**
   * True only when the farm completed with nothing dropped: every package
   * linked, every prebuilt `dist` copied, npm's completeness marker in place
   * so `build-test` skips its install. Anything less is false with a
   * `reason`, because a probe told "your dependencies are there" about a tree
   * missing one package reports the hole as a defect in the diff.
   */
  provisioned: boolean;
  /** The resolved cache entry the farm links into; null when none matched. */
  source: string | null;
  /** Why the worktree was NOT provisioned (absent when `provisioned`). */
  reason?: string;
  /** Packages symlinked in from the cache entry. */
  linked: number;
  /** Entries that could not be linked or copied — disclosed, never dropped. */
  failed: number;
  /**
   * Workspace members whose package name now resolves to the worktree's own
   * directory — the self-links re-derived from the worktree manifest.
   */
  selfLinked: number;
  /** Member `dist/` trees copied in from the cache's prebuilt outputs. */
  distCopied: number;
}

const fallback = (
  reason: string,
  partial?: Partial<WorktreeDependencyProvision>,
): WorktreeDependencyProvision => ({
  provisioned: false,
  source: null,
  reason,
  linked: 0,
  failed: 0,
  selfLinked: 0,
  distCopied: 0,
  ...partial,
});

/**
 * Farm a matching cache entry's install into the worktree.
 *
 * The entry is selected by the WORKTREE's lockfile — hashed to name the
 * entry, then byte-compared against the copy the entry carries — so a PR
 * that changes `package-lock.json` never gets an install that does not match
 * its own manifest: it falls back to the disclosed read-only behaviour, which
 * is the pre-#10108 status quo, not a regression.
 *
 * Never throws. Every filesystem step is guarded and counted; the caller
 * writes the result into the plan report and the review reads it as data.
 */
export function provisionWorktreeDependencies(
  worktree: string,
  cacheRoot: string,
): WorktreeDependencyProvision {
  let lockBytes: Buffer;
  try {
    lockBytes = readFileSync(join(worktree, 'package-lock.json'));
  } catch {
    // Not an npm repo (or the PR deleted the lockfile): there is no key to
    // select an entry by, and `npm ci` could not have installed it either.
    return fallback('the worktree has no package-lock.json to key the cache');
  }
  const hash = createHash('sha256').update(lockBytes).digest('hex');
  let entry: string;
  try {
    entry = realpathSync(join(cacheRoot, hash));
  } catch {
    return fallback(
      `no cache entry for lockfile ${hash.slice(0, 12)} (cold cache, or the PR changed the lockfile)`,
    );
  }
  if (!existsSync(join(entry, DEPS_COMPLETE_MARKER))) {
    // The population step renames a fully-staged directory into place, so a
    // markerless entry is a torn write or a foreign directory — either way
    // not an install this farm may claim.
    return fallback(`cache entry ${entry} carries no completeness marker`);
  }
  try {
    // Byte-compare, not hash-compare: the entry's name already came from a
    // hash, and re-deriving the same hash from the entry's copy would only
    // re-check the arithmetic. What this guards is the entry itself — a
    // snapshot whose lockfile does not match the name it sits under was
    // staged wrong, and farming it links packages some OTHER lockfile chose.
    if (!lockBytes.equals(readFileSync(join(entry, 'package-lock.json')))) {
      return fallback(`cache entry ${entry} holds a different lockfile`);
    }
  } catch {
    return fallback(`cache entry ${entry} has no readable lockfile copy`);
  }
  const entryNpmMarker = join(entry, 'node_modules', '.package-lock.json');
  if (!existsSync(entryNpmMarker)) {
    // Without npm's own completeness marker to hand the worktree, the farm
    // could link every package and `build-test` would still `npm ci` over it
    // — the install this module exists to remove. Refuse up front rather
    // than discover it after building the farm.
    return fallback(
      `cache entry ${entry} has no node_modules/.package-lock.json`,
    );
  }
  // `lstatSync`, not `existsSync`: a committed DANGLING symlink at
  // `node_modules` reads as absent to existsSync and the farm's mkdir then
  // dies EEXIST — the same shape `exposeDependencies` guards against.
  try {
    lstatSync(join(worktree, 'node_modules'));
    // Present at all — a committed `node_modules` (force-add defeats
    // gitignore) is PR content, and farming over it would both destroy what
    // the commit ships and mix cache links into a tree the PR controls.
    return fallback(
      'the worktree already carries a node_modules; refusing to farm over PR content',
    );
  } catch {
    // Absent: the normal fresh-worktree shape.
  }

  let entryReal: string;
  let worktreeReal: string;
  try {
    entryReal = realpathSync(entry);
    worktreeReal = realpathSync(worktree);
  } catch {
    return fallback('the worktree or cache entry cannot be resolved');
  }

  const tally = { linked: 0, failed: 0, selfLinked: 0, distCopied: 0 };

  // The root farm, plus the entry's provenance marker as the FIRST write:
  // even a farm that then fails halfway names its source, so the scratch
  // tree's containment can read where the links it finds are supposed to go.
  if (
    !farmFromEntry(
      join(entryReal, 'node_modules'),
      join(worktreeReal, 'node_modules'),
      entryReal,
      tally,
    )
  ) {
    return fallback('could not create the worktree node_modules farm', {
      ...tally,
      source: entryReal,
    });
  }
  try {
    writeFileSync(
      join(worktreeReal, 'node_modules', PROVISION_MARKER),
      `${entryReal}\n`,
    );
  } catch {
    tally.failed++;
  }

  // The members: nested installs, self-links, prebuilt dist. All three walk
  // the WORKTREE's own workspace graph — the code under review decides what
  // its members are, and a package the PR adds or removes is handled by
  // construction (an added member gets a self-link and simply has no cache
  // `dist`; a removed one is never linked at all).
  let memberDirs: string[] = [];
  let members: Array<{ dir: string; name: string }> = [];
  try {
    const graph = readWorkspacePackages(worktreeReal);
    members = graph.packages.map((p) => ({ dir: p.dir, name: p.name }));
    // `skipped` dirs are real directories npm links whose manifests the graph
    // cannot model; they still deserve their nested install and dist.
    memberDirs = [...graph.packages.map((p) => p.dir), ...graph.skipped];
  } catch {
    // No graph, no members: the root farm alone is still an install for a
    // single-package repo, and for a workspace repo the missing self-links
    // surface below as provisioned: false via the linked-vs-expected check —
    // but only failures are counted, so record one for the unreadable graph.
    tally.failed++;
  }

  for (const dir of memberDirs) {
    // Resolved-containment on BOTH sides, exactly like `exposeDependencies`'
    // member loop: the member list comes from the worktree's root manifest,
    // which is PR content, and this loop creates directories and links at the
    // paths it names.
    const source = containedIn(entryReal, dir);
    const target = containedIn(worktreeReal, dir);
    if (target === null || !existsSync(target)) continue;
    if (source !== null && existsSync(join(source, 'node_modules'))) {
      try {
        lstatSync(join(target, 'node_modules'));
        // A committed member-level node_modules: same refusal as the root,
        // scoped to the member — counted, and the member keeps what its
        // commit ships.
        tally.failed++;
      } catch {
        if (
          !farmFromEntry(
            join(source, 'node_modules'),
            join(target, 'node_modules'),
            entryReal,
            tally,
          )
        ) {
          tally.failed++;
        }
      }
    }
    // Prebuilt dist: only when the checkout does not already carry one — a
    // committed dist is PR content and stays. A COPY, never a link: Agent 7's
    // scoped build overwrites the changed packages' dist in place, and a
    // write through a link would corrupt the shared cache entry.
    if (source !== null && existsSync(join(source, 'dist'))) {
      let hasDist = true;
      try {
        lstatSync(join(target, 'dist'));
      } catch {
        hasDist = false;
      }
      if (!hasDist) {
        try {
          cpSync(join(source, 'dist'), join(target, 'dist'), {
            recursive: true,
          });
          tally.distCopied++;
        } catch {
          tally.failed++;
        }
      }
    }
  }

  // The self-links, re-derived from the worktree manifest (see the module
  // comment for why the cache's own are skipped). npm creates one per member
  // so an import BY NAME resolves to the sibling's working copy.
  for (const { dir, name } of members) {
    const memberDir = containedIn(worktreeReal, dir);
    if (memberDir === null) {
      tally.failed++;
      continue;
    }
    // The NAME is PR content too, and it becomes a path under node_modules:
    // reject anything that would escape (`..`, absolute, empty segments)
    // by resolving the joined path and requiring containment.
    const linkPath = resolve(join(worktreeReal, 'node_modules'), name);
    if (!insideDir(join(worktreeReal, 'node_modules'), linkPath)) {
      tally.failed++;
      continue;
    }
    try {
      mkdirSync(join(linkPath, '..'), { recursive: true });
      try {
        lstatSync(linkPath);
        // Occupied: a cache package shares the member's name. npm resolves
        // the workspace member; so does this farm — replace the link.
        rmSync(linkPath, { recursive: true, force: true });
      } catch {
        // Free: the normal case.
      }
      symlinkSync(
        memberDir,
        linkPath,
        process.platform === 'win32' ? 'junction' : 'dir',
      );
      tally.selfLinked++;
      tally.linked++;
    } catch {
      tally.failed++;
    }
  }

  if (tally.failed > 0 || tally.linked === 0) {
    return fallback(
      tally.linked === 0
        ? 'the cache entry held nothing linkable'
        : `${tally.failed} entr${tally.failed === 1 ? 'y' : 'ies'} could not be provisioned`,
      { ...tally, source: entryReal },
    );
  }
  // npm's completeness marker, LAST: it is what `build-test` reads as "this
  // tree is installed", so it lands only once everything above did.
  try {
    copyFileSync(
      entryNpmMarker,
      join(worktreeReal, 'node_modules', '.package-lock.json'),
    );
  } catch {
    tally.failed++;
    return fallback('could not place the npm completeness marker', {
      ...tally,
      source: entryReal,
    });
  }
  return { provisioned: true, source: entryReal, ...tally };
}

/**
 * The cache entry a provisioned dependency root's farm links into, or null.
 *
 * Read by `exposeDependencies`' containment: a scratch tree farmed FROM a
 * provisioned worktree finds entries that resolve into the cache — outside
 * every `node_modules` the containment knows — and without this they all
 * count as escapes and the scratch tree gets no dependencies at all.
 *
 * The marker is a file inside a gitignored directory, but a PR can force-add
 * exactly that path, so what it names is validated rather than believed:
 * the recorded path must be absolute, must resolve, must sit OUTSIDE the
 * dependency root (a PR cannot create files outside its own checkout, and a
 * genuine cache entry never lives inside the worktree), and must carry both
 * the completeness marker and a real `node_modules` — the shape only the
 * population step produces. A marker that fails any of it is ignored, which
 * restores exactly the pre-provisioning containment.
 */
export function provisionSourceOf(dependencyRoot: string): string | null {
  let recorded: string;
  try {
    recorded = readFileSync(
      join(dependencyRoot, 'node_modules', PROVISION_MARKER),
      'utf8',
    ).trim();
  } catch {
    return null;
  }
  if (!recorded || !isAbsolute(recorded)) return null;
  let real: string;
  let rootReal: string;
  try {
    real = realpathSync(recorded);
    rootReal = realpathSync(dependencyRoot);
  } catch {
    return null;
  }
  if (insideDir(rootReal, real)) return null;
  if (!existsSync(join(real, DEPS_COMPLETE_MARKER))) return null;
  try {
    if (!lstatSync(join(real, 'node_modules')).isDirectory()) return null;
  } catch {
    return null;
  }
  return real;
}

/**
 * Mirror one `node_modules` from the cache entry into the worktree.
 *
 * Returns false only when the farm directory itself could not be created;
 * per-entry faults are counted in the tally, exactly the best-effort contract
 * `farmNodeModules` keeps for the scratch-tree farm.
 *
 * The containment rule is the inverse of that sibling's: an entry that is a
 * symlink is mirrored only when it resolves inside a `node_modules` UNDER THE
 * CACHE ENTRY (pnpm-style store links). One that resolves inside the entry
 * but outside every `node_modules` is npm's workspace self-link — skipped,
 * because the worktree gets its own (see the module comment) — and one that
 * resolves outside the entry entirely is counted: the cache is
 * operator-provisioned, so that shape is a broken snapshot, and mirroring it
 * would hand the worktree a link to an unvouched path.
 */
function farmFromEntry(
  sourceNm: string,
  targetNm: string,
  entryReal: string,
  tally: {
    linked: number;
    failed: number;
    selfLinked: number;
    distCopied: number;
  },
): boolean {
  let entries: Dirent[];
  try {
    entries = readdirSync(sourceNm, { withFileTypes: true });
  } catch {
    return false;
  }
  try {
    mkdirSync(targetNm, { recursive: true });
  } catch {
    return false;
  }
  const linkType = process.platform === 'win32' ? 'junction' : 'dir';
  const place = (source: string, target: string): void => {
    try {
      symlinkSync(source, target, linkType);
      tally.linked++;
    } catch {
      tally.failed++;
    }
  };
  const verdict = (path: string): 'mirror' | 'self' | 'escape' => {
    let real: string;
    try {
      real = realpathSync(path);
    } catch {
      // Dangling. The population step snapshots only installs and `dist`, so
      // a member with neither leaves its self-link in the entry pointing at a
      // directory the snapshot never materialised — resolve the link
      // textually, and a target still inside the entry is that self-link
      // (skipped like any other; the worktree derives its own). Anything
      // else is a broken snapshot, and is counted.
      try {
        const target = resolve(dirname(path), readlinkSync(path));
        return insideDir(entryReal, target) ? 'self' : 'escape';
      } catch {
        return 'escape';
      }
    }
    if (!insideDir(entryReal, real)) return 'escape';
    return relative(entryReal, real).split(sep).includes('node_modules')
      ? 'mirror'
      : 'self';
  };
  for (const entry of entries) {
    // Build caches are per-tree state, and npm's marker is placed separately
    // — only on a clean farm.
    if (
      entry.name === '.vite' ||
      entry.name === '.vite-temp' ||
      entry.name === '.package-lock.json' ||
      entry.name === PROVISION_MARKER
    ) {
      continue;
    }
    const sourceEntry = join(sourceNm, entry.name);
    const targetEntry = join(targetNm, entry.name);
    if (entry.isSymbolicLink()) {
      const v = verdict(sourceEntry);
      if (v === 'self') continue;
      if (v === 'escape') {
        tally.failed++;
        continue;
      }
      place(sourceEntry, targetEntry);
      continue;
    }
    if (!entry.isDirectory()) continue;
    if (entry.name.startsWith('@')) {
      // A scope directory is real in the source; its PACKAGES are what get
      // linked, so the worktree's scope dir is real too — that is what lets
      // the self-link pass drop a member into an existing scope.
      let pkgs: Dirent[];
      try {
        mkdirSync(targetEntry);
        pkgs = readdirSync(sourceEntry, { withFileTypes: true });
      } catch {
        tally.failed++;
        continue;
      }
      for (const pkg of pkgs) {
        const scopedSource = join(sourceEntry, pkg.name);
        if (pkg.isSymbolicLink()) {
          const v = verdict(scopedSource);
          if (v === 'self') continue;
          if (v === 'escape') {
            tally.failed++;
            continue;
          }
        } else if (!pkg.isDirectory()) {
          continue;
        }
        place(scopedSource, join(targetEntry, pkg.name));
      }
      continue;
    }
    place(sourceEntry, targetEntry);
  }
  return true;
}

/**
 * `<root>/<dir>` when it really is inside `<root>`, and null when it is not —
 * the same guard `exposeDependencies` applies to the same untrusted input
 * (the member list comes from the manifest of the code under review).
 */
function containedIn(root: string, dir: string): string | null {
  try {
    const base = realpathSync(resolve(root));
    const full = resolve(base, dir);
    const real = existsSync(full) ? realpathSync(full) : full;
    return real === base || real.startsWith(base + sep) ? real : null;
  } catch {
    return null;
  }
}

function insideDir(base: string, path: string): boolean {
  return path === base || path.startsWith(base + sep);
}
