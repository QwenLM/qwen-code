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

/** XML comments are stripped before any structural regex runs. */
function stripComments(pomXml: string): string {
  return pomXml.replace(/<!--[\s\S]*?-->/g, '');
}

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
 * no XML dependency and `<module>` entries are plain element text. Only
 * entries inside a `<modules>` block are reactor entries — `<module>` also
 * appears in plugin `<configuration>`s (a JPMS module list), where capturing
 * it would name a directory that is not a module. Profiles declare theirs
 * inside `<modules>` too, so a profile-declared module — code a diff can
 * touch just the same — is captured. XML comments are stripped first: a
 * commented-out `<module>ghost</module>` whose directory does not exist would
 * otherwise flag the whole layout unmodeled and lose the scoping entirely.
 *
 * `unmodeled` is true when a declared entry could not be normalized — an
 * outside-the-basedir path, an empty element, or a shell-unsafe segment.
 * Dropping such an entry silently would map the files under it to NO module
 * and report a false green, so the caller hands the repo to the fallback
 * instead. The same goes for an entry the capture regex cannot see at all
 * (an attribute on the element, CDATA content, a space in the closing tag):
 * the raw-token count at the end catches what the loop never matched.
 *
 * A `<modules>` wrapper inside a plugin `<configuration>` — the shape
 * moditect-maven-plugin uses — is one the block regex cannot tell from the
 * real reactor block, so its entries are captured too and the layout
 * degrades to `unmodeled` when the fake dirs do not exist. That degrade is
 * deliberate: regex cannot reliably distinguish the shapes, and losing `-pl`
 * scoping to a whole-reactor fallback is the safe direction.
 */
export function declaredModulesOf(pomXml: string): {
  dirs: string[];
  unmodeled: boolean;
} {
  const withoutComments = stripComments(pomXml);
  const dirs: string[] = [];
  let unmodeled = false;
  let matched = 0;
  let rawModuleTokens = 0;
  let blockCount = 0;
  const blocks = /<modules>([\s\S]*?)<\/modules>/g;
  let block: RegExpExecArray | null;
  while ((block = blocks.exec(withoutComments)) !== null) {
    blockCount++;
    const body = block[1] ?? '';
    const re = /<module>\s*([^<]*?)\s*<\/module>/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(body)) !== null) {
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
    rawModuleTokens += (body.match(/<module[\s/>]/g) ?? []).length;
  }
  if (rawModuleTokens > matched) unmodeled = true;
  // A `<modules` opener the block regex cannot see (an attribute on the
  // element) hides every entry inside it; files under those modules would
  // map to nothing and report a false green, so flag instead of guessing.
  // Self-closing `<modules/>` placeholders are openers that carry no entries
  // and match no block — subtracted, not flagged.
  const modulesOpeners = withoutComments.match(/<modules[\s/>]/g) ?? [];
  const selfClosingModules = withoutComments.match(/<modules\s*\/>/g) ?? [];
  if (modulesOpeners.length - selfClosingModules.length > blockCount) {
    unmodeled = true;
  }
  // The strip above trusts every `<!--`…`-->` pair to be an XML comment.
  // Inside CDATA or an attribute value it is NOT, and a strip that spans a
  // real `</modules>` physically deletes entries — every recount then runs on
  // the corrupted string and hidden modules vanish with `unmodeled: false`.
  // A pom is PR-controlled in a PR review, so flag the layout instead of
  // trusting a parse the strip could have sabotaged.
  if (/<!\[CDATA\[/.test(pomXml) || /=["'][^"']*<!--/.test(pomXml)) {
    unmodeled = true;
  }
  return { dirs, unmodeled };
}

/**
 * The `<parent>` reference one pom declares, before resolution.
 *
 * `ref` is the `<relativePath>` text when present, Maven's `../pom.xml`
 * default when the element is absent, and null when there is no local edge —
 * no `<parent>` block at all, or an explicitly empty `<relativePath/>`
 * ("resolve from the repository, not the tree"). `untrusted` is true when a
 * `<parent>` token exists the block regex cannot see (an attribute on the
 * element, a second block): the inheritance edge cannot be established, and
 * missing one maps the inheriting module's files to nothing that builds the
 * change — the false green the caller exists to prevent.
 */
function declaredParentRef(pomXml: string): {
  ref: string | null;
  untrusted: boolean;
} {
  const clean = stripComments(pomXml);
  const openers = clean.match(/<parent[\s/>]/g) ?? [];
  if (openers.length === 0) return { ref: null, untrusted: false };
  const blocks = /<parent>([\s\S]*?)<\/parent>/g;
  let body: string | null = null;
  let count = 0;
  let m: RegExpExecArray | null;
  while ((m = blocks.exec(clean)) !== null) {
    count++;
    body = m[1] ?? '';
  }
  if (count !== openers.length || body === null) {
    return { ref: null, untrusted: true };
  }
  if (/<relativePath\s*\/>/.test(body)) return { ref: null, untrusted: false };
  const rel = body.match(/<relativePath>\s*([^<]*?)\s*<\/relativePath>/);
  const raw = rel ? (rel[1] ?? '').trim() : '../pom.xml';
  return { ref: raw === '' ? null : raw, untrusted: false };
}

/**
 * Resolve a `<relativePath>` against the module's dir, as a repo-relative
 * dir of the parent pom. Null when the parent is not in the repo — an
 * absolute path, a `..` chain that leaves the root, or a segment outside the
 * modeled charset: such a parent cannot be touched by a repo-relative diff,
 * so there is no local inheritance edge to widen along. The value is only
 * ever COMPARED against changed-pom dirs, never interpolated into a command,
 * but the charset gate keeps the comparison space and the module space alike.
 */
function resolveParentRef(moduleDir: string, ref: string): string | null {
  const path = ref.replace(/\\/g, '/');
  if (path.startsWith('/')) return null;
  const stack = moduleDir === '' ? [] : moduleDir.split('/');
  const segs = path.split('/');
  // A trailing `pom.xml` names the file; its directory is the parent.
  if (segs[segs.length - 1] === 'pom.xml' || segs[segs.length - 1] === '') {
    segs.pop();
  }
  for (const seg of segs) {
    if (seg === '' || seg === '.') continue;
    if (seg === '..') {
      if (stack.length === 0) return null;
      stack.pop();
      continue;
    }
    if (!SEGMENT_RE.test(seg)) return null;
    stack.push(seg);
  }
  return stack.join('/');
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
  /**
   * Each modeled module dir → the repo-relative dir of the pom it inherits
   * via `<parent>` (`<relativePath>` resolved, Maven's `../pom.xml` default
   * applied), or null when the edge is absent, empty, or leaves the repo.
   * Comparison data for inheritance widening — never reaches a shell.
   */
  parentOf: Map<string, string | null>;
}

/**
 * Walk the reactor: the root pom's modules, then each module's own.
 *
 * A declared dir without a `pom.xml` is unmodeled rather than skipped —
 * Maven itself fails the build on it, but a silent skip here would map the
 * files under it to no module and report a green that compiled nothing.
 * The seen set terminates cycles (a pom listing itself or its ancestor);
 * the depth cap bounds a chain of nested aggregators.
 *
 * Poms are read as bytes first: a UTF-16 pom (legal to Maven via BOM, and
 * what PowerShell writes by default) decodes to NUL-riddled text under utf8
 * that the regexes silently read as "declares no modules" — dropping a nested
 * aggregator's whole subtree with `unmodeled: false`, the false green this
 * walker exists to prevent. A UTF-16 BOM or NUL chars flag the layout
 * unmodeled; a UTF-8 BOM is stripped and parsed.
 */
export function readMavenLayout(root: string): MavenLayout {
  const modules: string[] = [];
  const parentOf = new Map<string, string | null>();
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
      const raw = readFileSync(pomPath);
      if (
        (raw[0] === 0xff && raw[1] === 0xfe) ||
        (raw[0] === 0xfe && raw[1] === 0xff)
      ) {
        unmodeled = true;
        return;
      }
      pomXml = raw.toString('utf8');
      if (pomXml.startsWith('\uFEFF')) pomXml = pomXml.slice(1);
      if (pomXml.includes('\u0000')) {
        unmodeled = true;
        return;
      }
    } catch {
      // The root call only happens after an existence check; a nested pom
      // that vanished between listing and reading ends its subtree.
      return;
    }
    const { dirs: entries, unmodeled: badEntries } = declaredModulesOf(pomXml);
    if (badEntries) unmodeled = true;
    if (parentDir !== '') {
      const { ref, untrusted } = declaredParentRef(pomXml);
      if (untrusted) unmodeled = true;
      parentOf.set(
        parentDir,
        ref === null ? null : resolveParentRef(parentDir, ref),
      );
    }
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
  return { modules: modules.sort(), unmodeled, parentOf };
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

/**
 * Every module that inherits from the pom in `dir`, transitively.
 *
 * A changed parent pom reaches every module naming it as `<parent>`, and —
 * through them — every module naming THEM: Maven flattens the inheritance
 * chain into each effective pom, so the change compiles into grandchildren
 * too. `-pl` on the changed pom's own module alone would compile nothing
 * (packaging pom, no sources) while `-am` pulls only UPSTREAM — the
 * inheriting modules would never build, a confident false green — so the
 * caller widens the scope to this set.
 */
export function modulesInheritingFrom(
  layout: MavenLayout,
  dir: string,
): string[] {
  const childrenOf = new Map<string, string[]>();
  for (const [mod, parent] of layout.parentOf) {
    if (parent === null) continue;
    const list = childrenOf.get(parent) ?? [];
    list.push(mod);
    childrenOf.set(parent, list);
  }
  const out = new Set<string>();
  const queue = [dir];
  while (queue.length > 0) {
    const d = queue.pop() as string;
    for (const child of childrenOf.get(d) ?? []) {
      if (out.has(child)) continue;
      out.add(child);
      queue.push(child);
    }
  }
  return [...out].sort();
}
