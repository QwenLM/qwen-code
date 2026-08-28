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
  chmodSync,
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
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import type { Dirent } from 'node:fs';
import { createHash } from 'node:crypto';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import semver from 'semver';
import { readWorkspacePackages } from './workspaces.js';

/**
 * The file the CI population step writes LAST into a cache entry (the stage
 * directory is renamed into place atomically, so the marker's presence means
 * the whole entry landed). An entry without it is a torn or in-progress
 * snapshot and is never farmed from.
 */
export const DEPS_COMPLETE_MARKER = '.qwen-review-deps-complete';

/**
 * The path+sha256 manifest the population step writes into the stage BEFORE
 * the atomic rename (every file it snapshotted, sha256sum format). Entries
 * sit on a path writable by the unsandboxed PR code a review executes, so
 * the completeness marker alone cannot be trusted: the manifest is what an
 * entry must still verify against before this farm links it anywhere.
 */
export const DEPS_MANIFEST_FILE = '.qwen-review-deps-manifest';

/**
 * The revision the population step built the entry's `dist` trees from
 * (`git rev-parse HEAD` of its checkout, written before the manifest). The
 * entry is keyed on the lockfile alone, so without this nothing could see a
 * source-only base change leaving stale sibling `dist` under a warm name.
 */
export const DEPS_SOURCE_REV_FILE = '.qwen-review-source-rev';

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
  mergeBaseSha?: string | null,
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
  let cacheRootReal: string;
  let entry: string;
  try {
    cacheRootReal = realpathSync(cacheRoot);
    entry = realpathSync(join(cacheRoot, hash));
  } catch {
    return fallback(
      `no cache entry for lockfile ${hash.slice(0, 12)} (cold cache, or the PR changed the lockfile)`,
    );
  }
  if (!insideDir(cacheRootReal, entry)) {
    // A symlink planted AT the entry name resolves outside the cache; the
    // farm refuses it exactly like a missing entry (R1-1).
    return fallback(
      `cache entry ${entry} resolves outside the cache root; refusing it`,
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
  if (!entryManifestValid(entry)) {
    // The marker only says the entry ARRIVED whole; the manifest says it is
    // still what the population step published. A mismatch means the shared
    // tree was written through or pre-created by PR code this same host
    // executed — fail closed and let build-test install on its own path.
    return fallback(
      `cache entry ${entry} fails its content manifest; refusing to farm it`,
    );
  }
  if (mergeBaseSha !== undefined) {
    // The entry's `dist` was built from the recorded revision; it serves
    // this worktree only when that IS the worktree's merge base. Any other
    // shape — newer main than the PR's branch point, or an entry recorded
    // before this field existed — serves sibling `dist` the worktree's own
    // sources disagree with, and the probe verdicts built on it decide the
    // PR from the base's code.
    if (mergeBaseSha === null) {
      return fallback(
        'the merge base is unknown, so the cached dist cannot be vouched',
      );
    }
    let recorded: string | null = null;
    try {
      recorded = readFileSync(join(entry, DEPS_SOURCE_REV_FILE), 'utf8').trim();
    } catch {
      // No recorded revision: an entry published before the source-rev
      // guard existed. Its dist cannot be vouched either.
    }
    if (!recorded) {
      return fallback(`cache entry ${entry} records no source revision`);
    }
    if (recorded !== mergeBaseSha) {
      return fallback(
        `cache entry ${entry} was built from ${recorded.slice(0, 12)}, ` +
          `not the worktree's merge base ${mergeBaseSha.slice(0, 12)}`,
      );
    }
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
      false,
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
          // The entry publishes its files read-only and cpSync preserves
          // the mode; a scoped rebuild overwrites the copied outputs in
          // place and would die EACCES on them (R3-1). Restore owner-write
          // on the COPY — the shared entry stays immutable.
          const copiedFiles: string[] = [];
          walkFiles(join(target, 'dist'), copiedFiles);
          for (const f of copiedFiles) {
            chmodSync(f, statSync(f).mode | 0o200);
          }
          tally.distCopied++;
        } catch {
          tally.failed++;
        }
      }
    }
  }

  // The manifests are PR content the lockfile key cannot see: `npm ci`
  // rejects a manifest/lockfile desync loudly, but this farm would link
  // everything the entry has and claim a completeness the entry cannot
  // satisfy — the missing module then surfaces as a defect in the diff.
  // Demand what npm's sync check demands: presence AND range satisfaction
  // against the lockfile this farm already holds (a manifest bumped past
  // its locked version passes a presence-only check, and npm's marker —
  // what build-test reads — then hides the desync from everywhere, R1-16),
  // minus the optionals npm may legitimately leave out, like platform
  // binaries. The ROOT manifest joins the pass: without a `workspaces`
  // field the member loop never runs, and root dependencies are exactly
  // what a desync hits. The same pass collects each member's declared bins
  // for the `.bin` rebuild below.
  const lockPackages = parseLockfilePackages(lockBytes);
  const demandUnmet = (
    manifest: MemberManifest,
    nestedSource: string | null,
  ): boolean => {
    const demanded = new Set<string>([
      ...Object.keys(manifest.dependencies ?? {}),
      ...Object.keys(manifest.devDependencies ?? {}),
      ...Object.keys(manifest.peerDependencies ?? {}),
    ]);
    for (const [dep, meta] of Object.entries(
      manifest.peerDependenciesMeta ?? {},
    )) {
      if (meta?.optional === true) demanded.delete(dep);
    }
    for (const dep of demanded) {
      const inEntry = existsSync(
        join(entryReal, 'node_modules', ...dep.split('/')),
      );
      const inNested =
        nestedSource !== null &&
        existsSync(join(nestedSource, 'node_modules', ...dep.split('/')));
      if (!inEntry && !inNested) return true;
      const spec =
        manifest.dependencies?.[dep] ??
        manifest.devDependencies?.[dep] ??
        manifest.peerDependencies?.[dep];
      const locked = lockPackages?.[`node_modules/${dep}`];
      // Presence-only for non-semver specs (file:, git+, links) and for
      // lockfiles that record no version — the check npm reduces those to.
      if (
        typeof spec === 'string' &&
        semver.validRange(spec) !== null &&
        typeof locked?.version === 'string' &&
        !semver.satisfies(locked.version, spec)
      ) {
        return true;
      }
    }
    return false;
  };
  try {
    const rootManifest = JSON.parse(
      readFileSync(join(worktreeReal, 'package.json'), 'utf8'),
    ) as MemberManifest;
    if (demandUnmet(rootManifest, null)) tally.failed++;
  } catch {
    // A worktree whose root manifest is unreadable demands nothing.
  }
  const memberBins: Array<{
    linkName: string;
    target: string;
    memberDir: string;
  }> = [];
  for (const { dir, name } of members) {
    const target = containedIn(worktreeReal, dir);
    if (target === null) continue;
    let manifest: MemberManifest;
    try {
      manifest = JSON.parse(
        readFileSync(join(target, 'package.json'), 'utf8'),
      ) as MemberManifest;
    } catch {
      continue;
    }
    if (demandUnmet(manifest, containedIn(entryReal, dir))) {
      tally.failed++;
      continue;
    }
    const bin = manifest.bin;
    if (typeof bin === 'string') {
      memberBins.push({
        // npm names a string bin after the package itself.
        linkName: name.split('/').pop() ?? name,
        target: join(target, bin),
        memberDir: target,
      });
    } else if (bin) {
      for (const [linkName, binPath] of Object.entries(bin)) {
        memberBins.push({
          linkName,
          target: join(target, binPath),
          memberDir: target,
        });
      }
    }
  }

  // The self-links, re-derived from the worktree manifest (see the module
  // comment for why the cache's own are skipped). npm creates one per member
  // so an import BY NAME resolves to the sibling's working copy.
  for (const { dir, name } of members) {
    // The NAME is PR content and becomes a path under node_modules, where
    // this loop rmSync/mkdir/symlinks: validate the shape BEFORE any
    // filesystem operation. `.` collapses onto the farm root (whose occupied
    // branch would rmSync the farm itself), a second non-scope segment
    // traverses entry links into the shared cache, and a farm-owned name
    // (`.bin`, the provision marker) replaces it. Every shape npm itself
    // rejects dies here; containment below stays as the backstop.
    if (!isValidPackageName(name)) {
      tally.failed++;
      continue;
    }
    const memberDir = containedIn(worktreeReal, dir);
    if (memberDir === null) {
      tally.failed++;
      continue;
    }
    // Reject anything that would still escape (`..`, absolute, empty
    // segments) by resolving the joined path and requiring containment.
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

  // The root farm deliberately does NOT mirror the entry's `.bin`: member
  // binaries would resolve into the base's member snapshot, bypassing the
  // self-links this farm re-derived precisely so probes never execute the
  // base's copy. Rebuild it instead — the entry's third-party bin links
  // re-resolve through the farm (their relative targets are npm's own), and
  // each worktree member's bins are re-pointed at the worktree member,
  // npm's precedence, the same re-derivation the self-links get.
  try {
    const binDir = join(worktreeReal, 'node_modules', '.bin');
    mkdirSync(binDir, { recursive: true });
    let entryBins: Dirent[] = [];
    try {
      entryBins = readdirSync(join(entryReal, 'node_modules', '.bin'), {
        withFileTypes: true,
      });
    } catch {
      // An entry without `.bin` links no third-party binaries.
    }
    const entryBinDir = join(entryReal, 'node_modules', '.bin');
    for (const b of entryBins) {
      if (!b.isSymbolicLink()) continue;
      try {
        const linkText = readlinkSync(join(entryBinDir, b.name));
        // The link text is entry content: mirror only links whose target
        // stays inside the entry, the same verdict every other mirrored
        // link gets — a tampered text must never reach out of the cache
        // through the worktree's `.bin` (R1-1).
        if (!insideDir(entryReal, resolve(entryBinDir, linkText))) {
          tally.failed++;
          continue;
        }
        symlinkSync(linkText, join(binDir, b.name));
      } catch {
        tally.failed++;
      }
    }
    for (const { linkName, target, memberDir } of memberBins) {
      // Both halves are PR content this loop places: the link NAME becomes
      // a path under `.bin` it rm/symlinks at, and the bin PATH is where
      // the link resolves — `../` in either escapes the farm (R1-25).
      const linkPath = resolve(binDir, linkName);
      if (
        !insideDir(binDir, linkPath) ||
        !insideDir(memberDir, resolve(target))
      ) {
        tally.failed++;
        continue;
      }
      try {
        rmSync(linkPath, { force: true });
        symlinkSync(relative(binDir, target), linkPath);
      } catch {
        tally.failed++;
      }
    }
  } catch {
    tally.failed++;
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
 * population step produces — and it must sit under the configured cache
 * root (`DEPS_CACHE_ENV`), because a marker naming anywhere else on the
 * host is PR content pointing at an attacker-shaped directory. A marker
 * that fails any of it is ignored, which restores exactly the
 * pre-provisioning containment.
 */
export function provisionSourceOf(dependencyRoot: string): string | null {
  // The recorded path is admitted as the containment's `provisionRoot`, so
  // bound what it may name to the configured cache: with the environment
  // unset no cache exists, and a committed marker naming some other host
  // path is PR content pointing at an attacker-shaped directory.
  const cacheRoot = process.env[DEPS_CACHE_ENV];
  if (!cacheRoot) return null;
  let cacheRootReal: string;
  try {
    cacheRootReal = realpathSync(cacheRoot);
  } catch {
    return null;
  }
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
  if (!insideDir(cacheRootReal, real)) return null;
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
  mirrorDotBin = true,
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
      entry.name === PROVISION_MARKER ||
      // The ROOT farm rebuilds `.bin` from the worktree's own members
      // instead (see the caller): mirrored whole, member binaries would
      // resolve into the base's snapshot. Nested farms keep theirs.
      (!mirrorDotBin && entry.name === '.bin')
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
 * The lockfile's v3 `packages` map, or null when it carries none. The
 * demand check reads each demanded dep's locked VERSION out of it — the
 * manifest/lockfile sync `npm ci` enforces (R1-16).
 */
function parseLockfilePackages(
  lockBytes: Buffer,
): Record<string, { version?: unknown }> | null {
  try {
    const parsed = JSON.parse(lockBytes.toString('utf8')) as {
      packages?: Record<string, { version?: unknown }>;
    };
    return parsed.packages && typeof parsed.packages === 'object'
      ? parsed.packages
      : null;
  } catch {
    return null;
  }
}

/** The manifest fields the farm's demand check and bin rebuild read. */
interface MemberManifest {
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
  peerDependencies?: Record<string, string>;
  peerDependenciesMeta?: Record<string, { optional?: boolean } | undefined>;
  bin?: string | Record<string, string>;
}

/**
 * The package-name shapes npm admits, applied to a workspace member's name
 * before it becomes a path under `node_modules`: exactly one segment, or a
 * scoped `@scope/name` — never a leading `.` or `_`, never an empty, `.`,
 * or `..` segment, never a bare scope. Anything else is a traversal
 * (`foo/..`), a collapse onto the farm root (`.`), or a farm-owned path
 * (`.bin`, the provision marker) — and this loop rmSync/mkdir/symlinks at
 * whatever a name survives to.
 */
function isValidPackageName(name: string): boolean {
  const segmentOk = (seg: string): boolean =>
    seg !== '' && !seg.startsWith('.') && !seg.startsWith('_');
  const segments = name.split('/');
  if (segments.length === 1) {
    return segmentOk(segments[0]) && !segments[0].startsWith('@');
  }
  return (
    segments.length === 2 &&
    segments[0].startsWith('@') &&
    segments[0].length > 1 &&
    segmentOk(segments[1])
  );
}

/**
 * Whether the entry's files still hash to the manifest the population step
 * published with it. The file SET must agree as well — an unlisted file is
 * a write the manifest never vouched. The completeness marker and the
 * manifest itself are the population step's own last writes and are not
 * listed.
 */
function entryManifestValid(entry: string): boolean {
  let manifestText: string;
  try {
    manifestText = readFileSync(join(entry, DEPS_MANIFEST_FILE), 'utf8');
  } catch {
    return false;
  }
  const listed = new Map<string, string>();
  for (const line of manifestText.split('\n')) {
    if (line === '') continue;
    const parsed = /^([0-9a-f]{64})\s+\*?(.+)$/.exec(line);
    if (parsed === null) return false;
    listed.set(parsed[2].replace(/^\.\//, ''), parsed[1]);
  }
  const files: string[] = [];
  walkFiles(entry, files);
  const unlisted = [
    join(entry, DEPS_COMPLETE_MARKER),
    join(entry, DEPS_MANIFEST_FILE),
  ];
  try {
    for (const file of files) {
      if (unlisted.includes(file)) continue;
      const rel = relative(entry, file);
      const expected = listed.get(rel);
      if (expected === undefined) return false;
      const actual = createHash('sha256')
        .update(readFileSync(file))
        .digest('hex');
      if (actual !== expected) return false;
      listed.delete(rel);
    }
  } catch {
    return false;
  }
  // Every walked file hashed right; nothing listed is missing.
  return listed.size === 0;
}

function walkFiles(dir: string, out: string[]): void {
  let dirents: Dirent[];
  try {
    dirents = readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const d of dirents) {
    // `find -type f` does not follow links, and neither may this walk: a
    // symlinked file hashes to its target, not to the link the manifest
    // recorded.
    if (d.isSymbolicLink()) continue;
    const full = join(dir, d.name);
    if (d.isDirectory()) {
      walkFiles(full, out);
    } else if (d.isFile()) {
      out.push(full);
    }
  }
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
