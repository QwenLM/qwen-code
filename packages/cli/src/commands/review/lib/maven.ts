/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

// Which Maven modules a diff actually touches, so `build-test` can scope
// `mvn -pl <modules> -am` the same way it scopes `npm run build --workspace`.
//
// The fallback a Maven repo got before this existed was a bare `mvn compile`
// over the whole reactor — the prose precedence list's entry for `pom.xml`.
// On a multi-module monorepo that command does not finish inside the
// per-command deadline, so the review's one deterministic check degraded to
// "timed out, informational" every time. A change in one module does not need
// the other dozen compiled; the root pom already names the modules, so the
// scope is derivable, and derived here, in code.
//
// The mapping is deliberately to the DEEPEST module that owns a file: with
// `-pl`, Maven puts exactly the named modules and (with `-am`) their upstream
// dependencies into the reactor, so naming `libs/dqc-all/dqc-core` instead of
// its aggregator `libs/dqc-all` is the difference between compiling one
// module and compiling every sibling the aggregator also lists.

import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

/** How deep the module walk descends — a guard against malformed poms. */
const MAX_MODULE_DEPTH = 10;

/**
 * The charset a module path segment may use. This is a security boundary,
 * not a style preference: the dirs end up UNQUOTED in a shell command
 * (`mvn -pl <dirs> -am …`, run through `shell: true`), and in a PR review the
 * pom they came from is attacker-controlled — a `<module>x$(reboot)</module>`
 * whose directory exists would otherwise be command injection. Same
 * discipline as `parse-args` applying GitHub's name charset to everything
 * interpolated into `gh`. A segment outside the charset flags the layout
 * unmodeled and hands the repo to the fallback.
 */
const SEGMENT_RE = /^[A-Za-z0-9._-]+$/;

/**
 * A raw `<module>` entry as a repo-relative directory.
 *
 * Maven tolerates `./` segments, trailing slashes, and (on Windows) backslash
 * separators in module paths; all are normalized away so the dir compares
 * cleanly against plan file paths. Entries that cannot be mapped to a file
 * under the worktree root safely — a `..` segment, an absolute path, or a
 * segment outside the shell-safe charset — come back null and the caller
 * flags the layout unmodeled.
 */
function normalizeModuleDir(raw: string): string | null {
  const path = raw.trim().replace(/\\/g, '/');
  if (path.startsWith('/')) return null;
  const out: string[] = [];
  for (const seg of path.split('/')) {
    if (seg === '' || seg === '.') continue;
    if (seg === '..' || !SEGMENT_RE.test(seg)) return null;
    out.push(seg);
  }
  return out.length > 0 ? out.join('/') : null;
}

/**
 * The module dirs one pom declares, in order.
 *
 * A regex over the element text rather than an XML parse: the project carries
 * no XML dependency, `<module>` entries are plain element text, and the only
 * other place a `<module>` element appears in a pom is inside a profile —
 * which this also wants, since a profile-declared module holds code a diff
 * can touch just the same. XML comments are stripped first: a commented-out
 * `<module>ghost</module>` whose directory does not exist would otherwise
 * flag the whole layout unmodeled and lose the scoping entirely.
 *
 * `unmodeled` is true when a declared entry could not be normalized — an
 * outside-the-basedir path, an empty element, or a shell-unsafe segment.
 * Dropping such an entry silently would map the files under it to NO module
 * and report a false green, so the caller hands the repo to the fallback
 * instead. The same goes for an entry the capture regex cannot see at all
 * (an attribute on the element, CDATA content, a space in the closing tag):
 * the raw-token count at the end catches what the loop never matched.
 */
export function declaredModulesOf(pomXml: string): {
  dirs: string[];
  unmodeled: boolean;
} {
  const withoutComments = pomXml.replace(/<!--[\s\S]*?-->/g, '');
  const dirs: string[] = [];
  let unmodeled = false;
  let matched = 0;
  const re = /<module>\s*([^<]*?)\s*<\/module>/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(withoutComments)) !== null) {
    matched++;
    const dir = normalizeModuleDir(m[1] ?? '');
    if (dir) {
      dirs.push(dir);
    } else {
      unmodeled = true;
    }
  }
  // `<modules>` does not match — the char after `<module` is `s`, not
  // whitespace, `/` or `>` — so this counts module elements only.
  const rawModuleTokens = withoutComments.match(/<module[\s/>]/g) ?? [];
  if (rawModuleTokens.length > matched) unmodeled = true;
  return { dirs, unmodeled };
}

/** The reactor module layout a root pom describes. */
export interface MavenLayout {
  /**
   * Every module dir that exists, repo-relative, deepest included —
   * `['common', 'libs/dqc-all', 'libs/dqc-all/dqc-core']` for a nested
   * reactor. The root itself is NOT listed; scoping to the root means
   * running without `-pl`.
   */
  modules: string[];
  /**
   * True when some pom declares a module this walker cannot model — an
   * outside-the-basedir entry, or a declared dir with no `pom.xml`. A diff
   * inside such a module would map to NO module and report "nothing to
   * build", the confident false green `build-test` exists to prevent, so the
   * caller hands the repo to the brief's fallback instead of scoping it.
   */
  unmodeled: boolean;
}

/**
 * Walk the reactor: the root pom's modules, then each module's own.
 *
 * A declared dir without a `pom.xml` is unmodeled rather than skipped —
 * Maven itself fails the build on it, but a silent skip here would map the
 * files under it to no module and report a green that compiled nothing.
 * The seen set terminates cycles (a pom listing itself or its ancestor);
 * the depth cap bounds a chain of nested aggregators.
 */
export function readMavenLayout(root: string): MavenLayout {
  const modules: string[] = [];
  let unmodeled = false;
  const seen = new Set<string>();

  const walk = (parentDir: string, depth: number): void => {
    if (depth > MAX_MODULE_DEPTH) {
      unmodeled = true;
      return;
    }
    const pomPath = join(root, parentDir, 'pom.xml');
    let pomXml: string;
    try {
      pomXml = readFileSync(pomPath, 'utf8');
    } catch {
      // The root call only happens after an existence check; a nested pom
      // that vanished between listing and reading ends its subtree.
      return;
    }
    const { dirs: entries, unmodeled: badEntries } = declaredModulesOf(pomXml);
    if (badEntries) unmodeled = true;
    for (const entry of entries) {
      const dir = parentDir ? `${parentDir}/${entry}` : entry;
      if (seen.has(dir)) continue;
      seen.add(dir);
      if (!existsSync(join(root, dir, 'pom.xml'))) {
        unmodeled = true;
        continue;
      }
      modules.push(dir);
      walk(dir, depth + 1);
    }
  };

  walk('', 0);
  return { modules: modules.sort(), unmodeled };
}

/**
 * The deepest module dir that owns `filePath`, or null when none does.
 *
 * The prefix test includes the `/` boundary so module `libs/dqc` does not
 * claim a file in `libs/dqc-all/...` — sibling dirs where one name is a
 * string prefix of the other are common in real reactors.
 */
export function mavenModuleFor(
  filePath: string,
  modules: string[],
): string | null {
  const norm = filePath.replace(/^\.\//, '');
  let owner: string | null = null;
  for (const dir of modules) {
    if (norm === dir || norm.startsWith(`${dir}/`)) {
      if (owner === null || dir.length > owner.length) owner = dir;
    }
  }
  return owner;
}

/** The module dirs a change set touches, deduplicated and sorted. */
export function affectedMavenModules(
  changedFiles: string[],
  modules: string[],
): string[] {
  const dirs = new Set<string>();
  for (const f of changedFiles) {
    const d = mavenModuleFor(f, modules);
    if (d) dirs.add(d);
  }
  return [...dirs].sort();
}
