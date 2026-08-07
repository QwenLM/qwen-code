/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  accessSync,
  constants,
  existsSync,
  readdirSync,
  readFileSync,
  statSync,
} from 'node:fs';
import type { Dirent } from 'node:fs';
import {
  basename,
  dirname,
  isAbsolute,
  join,
  relative,
  resolve,
  sep,
} from 'node:path';
import type { BuildTestReport, CommandResult } from '../build-test.js';
import { INSTALL_MIN_FREE_BYTES, freeDiskBytes, gib } from './disk.js';
import { shellQuotePath } from './shell-quote.js';
import type { ReviewToolchainAdapter, ToolchainRunArgs } from './toolchain.js';

export interface MavenReactor {
  modules: string[];
  projectDirs: string[];
  /**
   * Aggregation edges: aggregator module dir ('.' for the root) -> the module
   * dirs it aggregates. A `<module>` entry can point OUTSIDE the aggregator's
   * directory (`../its/app-it`), so descendant closure walks these edges
   * rather than directory prefixes.
   */
  children: Record<string, string[]>;
  /**
   * Inheritance edges: parent module dir -> the module dirs declaring it as
   * their `<parent>`. A changed parent POM is inherited by these modules
   * exactly as by aggregation children, so the POM-change closure walks both.
   */
  inheritors: Record<string, string[]>;
  /**
   * Named parent POM files (any spelling other than `pom.xml`) that back a
   * recorded inheritance edge. Maven accepts a parent FILE of any name, so a
   * change to one is parent-config exactly like a change to the directory's
   * `pom.xml` and must walk the inheritor closure too.
   */
  parentPomFiles?: string[];
  /**
   * Named parent files some project's `<parent>` declares, including ones the
   * diff deleted: `parentPomFiles` only records edges that survived on disk,
   * and a deleted parent's `Non-resolvable parent POM` death is the diff's
   * own doing, so the file stays a dependency input either way.
   */
  declaredParentFiles?: string[];
}

export interface MavenOwnership {
  reactorWide: boolean;
  modules: string[];
  inactiveProjects: string[];
}

export type MavenReactorResult =
  | { reactor: MavenReactor; error?: never }
  | { reactor?: never; error: string };

const REACTOR_WIDE_FILES = new Set(['pom.xml', 'mvnw', 'mvnw.cmd']);
/**
 * `failsafe-reports` is forward-looking today: this adapter only ever runs
 * `test` and `test-compile`, and Failsafe binds to `integration-test` /
 * `verify`, so any XML found there is filtered out as stale. The scan stays
 * — one readdir per project per snapshot — so the evidence is picked up if a
 * later change ever runs a Failsafe phase.
 */
const REPORT_DIRS = ['surefire-reports', 'failsafe-reports'];

/**
 * Surefire writes one XML per test class, so a green full-reactor run yields
 * thousands of reports. Clean reports therefore roll up per project dir, and
 * the per-report evidence lines are capped: this block is appended AFTER the
 * command output was trimmed, so it carries its own bound.
 */
const MAX_FAILING_REPORT_LINES = 100;
const MAX_FAILURE_CASE_LINES = 200;
const MAX_CLEAN_ROLLUP_LINES = 100;

/**
 * cmd.exe refuses command lines past 8191 characters, and containerized
 * execve enforces ARG_MAX. A POM change at a mid-level aggregator closes
 * over every aggregation AND inheritance descendant, and on the 200-400
 * module reactors this adapter targets the comma-joined `-pl` selector can
 * approach those limits — a command line the platform refuses to launch is
 * not a scope. Past the cap the run widens to the full reactor instead.
 * 4096 leaves headroom for the executable, flags, and environment.
 */
const MAX_SELECTOR_CHARS = 4096;

/**
 * Cap evidence files before reading them: Surefire/Failsafe XML is
 * PR-controlled (the PR's own tests can write into `target/surefire-reports/`
 * during the run, and the mtime freshness filter accepts any writer), so an
 * uncapped read of a multi-gigabyte file is this harness's own denial-of-
 * service surface. 2 MiB is far beyond any realistic per-class report; an
 * oversized file simply contributes no evidence.
 */
const MAX_REPORT_BYTES = 2 * 1024 * 1024;

/**
 * POM reads carry the same class of cap: the CDATA/comment strip and the
 * tokenizer each walk the text again, so an uncapped multi-megabyte
 * `pom.xml` a PR commits is this harness's own denial-of-service surface.
 * 2 MiB is far beyond any realistic POM; an oversized one fails closed with
 * a reportable error exactly like the other unreadable shapes.
 */
const MAX_POM_BYTES = 2 * 1024 * 1024;

/**
 * Reactor nesting is a handful of levels in every real repository; a deeper
 * chain is a hostile checkout shape. Cap the walk so it fails closed with a
 * reportable error instead of overflowing the stack.
 */
const MAX_REACTOR_DEPTH = 512;

/**
 * Below this much remaining whole-call budget a Maven command is NOT
 * attempted — the same floor as the npm adapter, for the same reason: Maven
 * cannot boot and produce signal in a few hundred milliseconds, so an
 * "attempt" would manufacture a fake timeout where an honest disclosure says
 * exactly what happened.
 */
const BUDGET_MIN_ATTEMPT_MS = 15_000;

function toPosix(path: string): string {
  return path.split(sep).join('/');
}

function isInside(root: string, path: string): boolean {
  const rel = relative(root, path);
  return (
    rel === '' ||
    (!rel.startsWith(`..${sep}`) && rel !== '..' && !isAbsolute(rel))
  );
}

/**
 * Strip comments and UNWRAP CDATA in one left-to-right state scan. Order
 * matters in both directions: a `<![CDATA[` INSIDE a comment is literal
 * comment text (pairing it with a later `]]>` swallows real markup between
 * them), and a `-->` inside CDATA (antrun/checkstyle/xml-generation config)
 * is literal too. A missing terminator fails the POM closed.
 *
 * CDATA content is kept, not deleted: deleting silently empties a
 * CDATA-wrapped `<artifactId>` and drops the inheritance edge that depends
 * on it — a silent under-approximation. Content carrying ANY `<` fails the
 * whole POM closed instead: unwrapped BALANCED markup would otherwise parse
 * like ordinary markup and could overwrite a real `<relativePath>` or inject
 * a phantom `<module>` — a silent edge deletion is worse than an abort.
 */
function stripCdataAndComments(pom: string): string | null {
  const chunks: string[] = [];
  let i = 0;
  let chunkStart = 0;
  while (i < pom.length) {
    if (pom.startsWith('<!--', i)) {
      const end = pom.indexOf('-->', i + 4);
      if (end === -1) return null;
      chunks.push(pom.slice(chunkStart, i));
      i = end + 3;
      chunkStart = i;
      continue;
    }
    if (pom.startsWith('<![CDATA[', i)) {
      const end = pom.indexOf(']]>', i + 9);
      if (end === -1) return null;
      const inner = pom.slice(i + 9, end);
      if (inner.includes('<')) return null;
      chunks.push(pom.slice(chunkStart, i));
      chunks.push(inner);
      i = end + 3;
      chunkStart = i;
      continue;
    }
    i += 1;
  }
  chunks.push(pom.slice(chunkStart));
  return chunks.join('');
}

interface PomParent {
  artifactId: string;
  /** Absent element: Maven's default `../pom.xml`. Empty string: `<relativePath/>` (repo-only resolution). */
  relativePath: string | null;
}

interface PomStructure {
  modules: string[];
  artifactId: string | null;
  parent: PomParent | null;
}

/**
 * Split POM text into `<…>` tag tokens and text runs in one left-to-right
 * scan. A `>` inside a quoted attribute value stays inside the tag. An
 * unterminated tag ends the scan outright: no `>` remains after it, so no
 * valid tag can follow, and any text it would still emit can only reach an
 * active capture — which the missing closing tag then fails closed exactly
 * as the equivalent regex-tokenized garbage did. The regex tokenizer this
 * replaced backtracked quadratically on repeated `<` with no `>` anywhere,
 * on bytes a PR fully controls.
 */
function tokenizePom(pom: string): string[] {
  const tokens: string[] = [];
  let i = 0;
  while (i < pom.length) {
    if (pom[i] !== '<') {
      let end = i + 1;
      while (end < pom.length && pom[end] !== '<') end += 1;
      tokens.push(pom.slice(i, end));
      i = end;
      continue;
    }
    let quote: '"' | "'" | null = null;
    let end = i + 1;
    for (; end < pom.length; end += 1) {
      const c = pom[end];
      if (quote !== null) {
        if (c === quote) quote = null;
      } else if (c === '"' || c === "'") {
        quote = c;
      } else if (c === '>') {
        break;
      }
    }
    if (end >= pom.length) break;
    tokens.push(pom.slice(i, end + 1));
    i = end + 1;
  }
  return tokens;
}

/**
 * Parse the literal structure this adapter models: `<modules>` entries, the
 * project artifactId, and the `<parent>` reference. Fails closed (null) on
 * any shape it cannot read unambiguously.
 */
function parsePomStructure(pom: string): PomStructure | null {
  const stripped = stripCdataAndComments(pom);
  if (stripped === null) return null;

  const entries: string[] = [];
  const stack: string[] = [];
  let artifactId: string | null = null;
  let parentArtifactId: string | null = null;
  let parentRelativePath: string | null = null;
  let capture: {
    field: 'module' | 'artifactId' | 'parentArtifactId' | 'parentRelativePath';
    text: string;
  } | null = null;
  // Quote-aware: a `>` inside an attribute value is legal XML and occurs in
  // real plugin config; splitting the tag there fails the whole POM closed.
  const tokens = tokenizePom(stripped);
  for (const token of tokens) {
    if (!token.startsWith('<')) {
      if (capture) capture.text += token;
      continue;
    }
    if (/^<\?(?:.|\n)*\?>$/.test(token) || /^<![^-]/.test(token)) continue;

    const closing = /^<\/\s*([\w:.-]+)\s*>$/.exec(token);
    if (closing) {
      const name = closing[1].split(':').at(-1) ?? '';
      if (stack.pop() !== name) return null;
      if (capture) {
        const text = capture.text.trim();
        if (capture.field === 'module') {
          // `,` splits `-pl` selector arguments and `:` makes Maven read the
          // selector as `[groupId]:artifactId` coordinates instead of a path,
          // so neither can survive into a shell selector — fail closed like
          // the other shell-active characters.
          if (!text || /[<$>{}&%,:]/.test(text)) return null;
          entries.push(text);
        } else if (capture.field === 'artifactId') {
          artifactId = text;
        } else if (capture.field === 'parentArtifactId') {
          parentArtifactId = text;
        } else {
          parentRelativePath = text;
        }
        capture = null;
      }
      continue;
    }

    const opening =
      /^<\s*([\w:.-]+)(?:\s(?:"[^"]*"|'[^']*'|[^>"'])*)?\s*\/?>$/.exec(token);
    if (!opening) return null;
    const name = opening[1].split(':').at(-1) ?? '';
    const selfClosing = /\/\s*>$/.test(token);
    let field:
      | 'module'
      | 'artifactId'
      | 'parentArtifactId'
      | 'parentRelativePath'
      | null = null;
    if (
      name === 'module' &&
      stack.length === 2 &&
      stack[0] === 'project' &&
      stack[1] === 'modules'
    ) {
      field = 'module';
    } else if (
      name === 'artifactId' &&
      stack.length === 1 &&
      stack[0] === 'project'
    ) {
      field = 'artifactId';
    } else if (
      name === 'artifactId' &&
      stack.length === 2 &&
      stack[0] === 'project' &&
      stack[1] === 'parent'
    ) {
      field = 'parentArtifactId';
    } else if (
      name === 'relativePath' &&
      stack.length === 2 &&
      stack[0] === 'project' &&
      stack[1] === 'parent'
    ) {
      field = 'parentRelativePath';
    }
    if (field) {
      if (selfClosing) {
        if (field === 'module') return null;
        // `<relativePath/>` means "resolve the parent from the repository,
        // not the filesystem" — no local edge to model.
        if (field === 'parentRelativePath') parentRelativePath = '';
      } else {
        capture = { field, text: '' };
        stack.push(name);
      }
      continue;
    }
    if (capture) return null;
    if (!selfClosing) stack.push(name);
  }
  if (stack.length !== 0 || capture !== null) return null;
  return {
    modules: entries,
    artifactId,
    parent: parentArtifactId
      ? { artifactId: parentArtifactId, relativePath: parentRelativePath }
      : null,
  };
}

/**
 * Prototype-less edge record: the keys are PR-controlled module dir names,
 * and a module named `constructor` or `toString` must read "no edge" from
 * `?? []` at the indexing sites, not an inherited Object.prototype member.
 */
function edgeRecord(edges: Map<string, string[]>): Record<string, string[]> {
  const record = Object.create(null) as Record<string, string[]>;
  for (const [key, value] of edges) record[key] = [...value].sort();
  return record;
}

export function readMavenReactor(root: string): MavenReactorResult {
  const reactorRoot = resolve(root);
  const rootPom = join(reactorRoot, 'pom.xml');
  if (!existsSync(rootPom)) {
    return { error: 'The repository root has no pom.xml.' };
  }

  const modules = new Set<string>();
  const projectDirs = new Set<string>(['.']);
  const children = new Map<string, string[]>();
  const structures = new Map<string, PomStructure>();
  const visited = new Set<string>();

  const visit = (pomPath: string, depth: number): string | null => {
    // Real reactors nest a handful of levels; a deeper chain is a hostile
    // input shape, and the unbounded recursion would overflow the stack
    // (a RangeError) past the never-throw MavenReactorResult contract.
    if (depth > MAX_REACTOR_DEPTH) {
      return `Maven module nesting deeper than ${MAX_REACTOR_DEPTH} levels at ${toPosix(relative(reactorRoot, pomPath))}.`;
    }
    if (visited.has(pomPath)) return null;
    visited.add(pomPath);

    let pom: string;
    try {
      if (statSync(pomPath).size > MAX_POM_BYTES) {
        return `Maven POM ${toPosix(relative(reactorRoot, pomPath))} is larger than the ${MAX_POM_BYTES}-byte read cap.`;
      }
      pom = readFileSync(pomPath, 'utf8');
    } catch (error) {
      return `Cannot read ${toPosix(relative(reactorRoot, pomPath))}: ${(error as Error).message}`;
    }
    const structure = parsePomStructure(pom);
    if (!structure) {
      return `Cannot safely parse literal Maven modules from ${toPosix(relative(reactorRoot, pomPath))}.`;
    }

    const aggregatorDir = dirname(pomPath);
    const aggregatorPath = toPosix(relative(reactorRoot, aggregatorDir)) || '.';
    structures.set(aggregatorPath, structure);
    for (const entry of structure.modules) {
      if (isAbsolute(entry) || entry.includes('${') || entry.includes('@{')) {
        return `Maven module ${entry} in ${toPosix(relative(reactorRoot, pomPath))} is not a literal reactor-relative path.`;
      }
      const moduleDir = resolve(aggregatorDir, entry);
      if (!isInside(reactorRoot, moduleDir) || moduleDir === reactorRoot) {
        return `Maven module ${entry} in ${toPosix(relative(reactorRoot, pomPath))} escapes or aliases the reactor root.`;
      }
      const childPom = join(moduleDir, 'pom.xml');
      if (!existsSync(childPom)) {
        return `Maven module ${entry} in ${toPosix(relative(reactorRoot, pomPath))} has no child pom.xml.`;
      }
      const modulePath = toPosix(relative(reactorRoot, moduleDir));
      modules.add(modulePath);
      projectDirs.add(modulePath);
      const aggregated = children.get(aggregatorPath);
      if (aggregated) aggregated.push(modulePath);
      else children.set(aggregatorPath, [modulePath]);
      const error = visit(childPom, depth + 1);
      if (error) return error;
    }
    return null;
  };

  const error = visit(rootPom, 0);
  if (error) return { error };

  // Inheritance edges: resolve each project's `<parent>` relativePath
  // (default `../pom.xml`) and keep the edge only when it lands on another
  // reactor project whose artifactId matches the declaration — the same
  // check Maven applies before trusting a local parent POM. A matching
  // parent can live ANYWHERE in the reactor (`../parent/pom.xml`), so the
  // POM-change closure walks these edges rather than directory prefixes.
  // The walk is a worklist, not one hop: a NAMED parent file carries a
  // `<parent>` declaration of its own, and Maven merges the WHOLE chain
  // into the inheriting project — stopping at the first file would scope a
  // change to a higher parent away from the modules that inherit it.
  const inheritors = new Map<string, string[]>();
  const namedParentPoms = new Set<string>();
  // Named parent files some `<parent>` declaration names, including ones the
  // diff deleted: parentPomFiles below only records edges that survive on
  // disk, so a deleted file would otherwise stop being a dependency input
  // exactly when the resolution failure it causes is the diff's own doing.
  const declaredParentFiles = new Set<string>();
  const worklist: Array<{
    heir: string;
    fromDir: string;
    parent: PomParent;
  }> = [];
  for (const [modulePath, structure] of structures) {
    if (structure.parent) {
      worklist.push({
        heir: modulePath,
        fromDir: modulePath,
        parent: structure.parent,
      });
    }
  }
  // Per-(heir, file) cycle guard: a hostile chain can name files in a ring,
  // and each (heir, parent file) pair is resolved at most once.
  const enqueued = new Set<string>();
  while (worklist.length > 0) {
    const item = worklist.pop() as {
      heir: string;
      fromDir: string;
      parent: PomParent;
    };
    const parent = item.parent;
    // `<relativePath/>`: resolved from the repository, no local edge.
    if (parent.relativePath === '') continue;
    const relPath = parent.relativePath ?? '../pom.xml';
    if (relPath.includes('${') || relPath.includes('@{')) {
      return {
        error: `Maven parent relativePath of ${item.fromDir} is not a literal path.`,
      };
    }
    let parentPom = resolve(reactorRoot, item.fromDir, relPath);
    // Maven appends `pom.xml` only when the resolved path IS A DIRECTORY
    // (DefaultModelBuilder.getParentPomFile): a parent FILE may carry any
    // name. A path that is not an existing file keeps the historical append,
    // so an absent target never resolves onto its parent directory.
    if (basename(parentPom) !== 'pom.xml') {
      if (isInside(reactorRoot, parentPom)) {
        declaredParentFiles.add(toPosix(relative(reactorRoot, parentPom)));
      }
      let namedFile = false;
      try {
        namedFile = statSync(parentPom).isFile();
      } catch {
        // absent: keep the directory spelling
      }
      if (!namedFile) parentPom = join(parentPom, 'pom.xml');
    }
    const parentDir = dirname(parentPom);
    if (!isInside(reactorRoot, parentDir)) continue;
    const parentPath = toPosix(relative(reactorRoot, parentDir)) || '.';
    // Self-reference guard: only the heir's own `pom.xml` is a true
    // self-parent. A NAMED parent file inside the heir's own dir keeps its
    // full treatment below — registration and chain continuation — or the
    // whole inheritance chain through it silently dies here.
    if (parentPath === item.heir && basename(parentPom) === 'pom.xml') {
      continue;
    }
    // A parent that is a visited reactor project matches that project's
    // artifactId. Every other shape — a named parent FILE, or a `pom.xml`
    // in a directory the reactor does not aggregate — is read directly:
    // dropping the edge would scope a change to a higher parent away from
    // every module that inherits through this chain.
    let targetArtifactId: string | null;
    let fileStructure: PomStructure | null = null;
    if (basename(parentPom) === 'pom.xml' && structures.has(parentPath)) {
      targetArtifactId = structures.get(parentPath)?.artifactId ?? null;
    } else {
      let parentFile: string;
      try {
        if (statSync(parentPom).size > MAX_POM_BYTES) {
          return {
            error: `Maven POM ${toPosix(relative(reactorRoot, parentPom))} is larger than the ${MAX_POM_BYTES}-byte read cap.`,
          };
        }
        parentFile = readFileSync(parentPom, 'utf8');
      } catch (error) {
        if (basename(parentPom) === 'pom.xml') {
          // An absent `pom.xml` target: Maven falls back to repository
          // resolution, so there is no local edge to model.
          continue;
        }
        return {
          error: `Cannot read ${toPosix(relative(reactorRoot, parentPom))}: ${(error as Error).message}`,
        };
      }
      fileStructure = parsePomStructure(parentFile);
      if (!fileStructure) {
        return {
          error: `Cannot safely parse literal Maven modules from ${toPosix(relative(reactorRoot, parentPom))}.`,
        };
      }
      targetArtifactId = fileStructure.artifactId;
    }
    if (targetArtifactId !== parent.artifactId) continue;
    if (basename(parentPom) !== 'pom.xml') {
      namedParentPoms.add(toPosix(relative(reactorRoot, parentPom)));
    }
    // The parent file's own `<parent>` continues the chain, resolved
    // from the file's own directory but still owed to the SAME heir.
    if (fileStructure?.parent) {
      const key = `${item.heir}\0${parentPom}`;
      if (!enqueued.has(key)) {
        enqueued.add(key);
        worklist.push({
          heir: item.heir,
          fromDir: parentPath,
          parent: fileStructure.parent,
        });
      }
    }
    // A named parent file inside the heir's own dir is parent config, not
    // an inheritor of itself.
    if (parentPath !== item.heir) {
      const inherited = inheritors.get(parentPath);
      if (inherited) {
        if (!inherited.includes(item.heir)) inherited.push(item.heir);
      } else {
        inheritors.set(parentPath, [item.heir]);
      }
    }
  }

  return {
    reactor: {
      modules: [...modules].sort(),
      projectDirs: [...projectDirs].sort(),
      children: edgeRecord(children),
      inheritors: edgeRecord(inheritors),
      ...(namedParentPoms.size > 0
        ? { parentPomFiles: [...namedParentPoms].sort() }
        : {}),
      ...(declaredParentFiles.size > 0
        ? { declaredParentFiles: [...declaredParentFiles].sort() }
        : {}),
    },
  };
}

function normalizedChangedPath(
  root: string,
  changedFile: string,
): string | null {
  const absolute = resolve(root, changedFile);
  if (!isInside(root, absolute)) return null;
  return toPosix(relative(root, absolute));
}

function isDocumentationPath(path: string): boolean {
  // Anchored to the WHOLE relative path: a DIRECTORY named `README` must
  // not exempt its entire subtree — files of any extension — from
  // verification.
  if (/^README(?:\.[^/]*)?$/i.test(path)) return true;
  // The `src/` guard alone would skip a compilable file under a module's
  // `doc/` tree; a documentation path is a documentation EXTENSION first.
  if (path.startsWith('src/')) return false;
  if (!/\.(?:md|mdx|adoc|rst|txt)$/i.test(path)) return false;
  // Outside `src/`, the extension alone is not enough: a `.txt` can be a
  // resource wired into the artifact (maven-resources-plugin points at
  // arbitrary dirs), and skipping the build on it would be a fail-open in an
  // otherwise fail-closed design. Exempt only doc-shaped locations: a
  // `docs?/` or `site/` tree, or the module/root top level itself.
  const dir = dirname(path);
  return dir === '.' || /^(?:docs?|site)$/i.test(dir.split('/')[0]);
}

/**
 * Repository metadata that cannot change what Maven builds: VCS/CI config,
 * licenses, editor rules. Anything NOT recognized here still runs the reactor
 * — a root `checkstyle.xml` or build script affects the build, and failing
 * closed costs time while failing open ships an unverified diff.
 */
function isRepoMetadataPath(path: string): boolean {
  // `[^/]*` keeps the LICENSE/NOTICE extension run inside the final
  // segment: a DIRECTORY with one of those names must not exempt its
  // subtree from verification.
  return (
    /^(?:\.git(?:ignore|attributes|modules)|\.editorconfig|CODEOWNERS|LICENSE(?:\.[^/]*)?|NOTICE(?:\.[^/]*)?)$/.test(
      path,
    ) || path.startsWith('.github/')
  );
}

/**
 * A POM under a known project's `src/` tree is test data — maven-invoker ITs,
 * archetype fixtures, `src/test/resources/projects/*` — never a reactor member,
 * and no profile activates one. Reading it as a project boundary would fail the
 * whole diff closed over a fixture, so keep walking: the file stays owned by the
 * enclosing project.
 */
function isUnderTestSourceTree(
  rel: string,
  projectDirs: readonly string[],
): boolean {
  return projectDirs.some((projectDir) => {
    const src = projectDir === '.' ? 'src' : `${projectDir}/src`;
    // Strictly BENEATH `src/`: a real project located exactly at a project's
    // src path is not test data, and reading it as one defeats the
    // out-of-reactor fail-closed rule for that shape.
    return rel.startsWith(`${src}/`);
  });
}

function nearestMavenProject(
  root: string,
  path: string,
  projectDirs: readonly string[],
): string | null {
  let dir = dirname(join(root, path));
  while (isInside(root, dir)) {
    if (existsSync(join(dir, 'pom.xml'))) {
      const rel = toPosix(relative(root, dir)) || '.';
      if (!isUnderTestSourceTree(rel, projectDirs)) return rel;
    }
    if (dir === root) break;
    dir = dirname(dir);
  }
  return null;
}

export function detectMavenOwnership(
  root: string,
  changedFiles: readonly string[],
  reactor: MavenReactor,
  platform: string = process.platform,
): MavenOwnership {
  const modules = new Set<string>();
  const inactiveProjects = new Set<string>();
  let reactorWide = false;
  const deepestFirst = [...reactor.modules].sort(
    (a, b) => b.split('/').length - a.split('/').length || b.length - a.length,
  );
  // Every wrapper repo ships both platform variants, but only one is ever
  // executed: a change confined to the OTHER platform's wrapper cannot affect
  // this platform's run, so it neither escalates to reactor-wide nor falls
  // into the unowned catch-all (which would run the whole reactor to verify
  // nothing).
  const otherPlatformWrapper = platform === 'win32' ? 'mvnw' : 'mvnw.cmd';
  // Named parent POM files backing a recorded inheritance edge: a change to
  // one is parent config exactly like the directory's `pom.xml`, so it walks
  // the same closure below instead of routing as an ordinary source file.
  const namedParentDirs = new Map<string, string>(
    (reactor.parentPomFiles ?? []).map((file) => [file, dirname(file)]),
  );

  // The descendant closure shared by both parent-config change paths (a
  // changed module `pom.xml` and a changed named parent file): a parent
  // config change reaches every module aggregated beneath it AND every
  // module declaring it as `<parent>`, transitively. The closure walks the
  // recorded aggregation and inheritance edges, not directory prefixes: a
  // `<module>../its/app-it</module>` entry sits OUTSIDE the aggregator's
  // directory and still inherits the parent change. `seen` is the
  // expansion guard, SEPARATE from the result set: a descendant already in
  // `modules` through an earlier changed file still has to be expanded, or
  // its whole subtree silently drops out of the scope.
  const addDescendantClosure = (start: string): void => {
    const seen = new Set<string>([start]);
    const queue = [start];
    while (queue.length > 0) {
      const aggregator = queue.pop() as string;
      for (const child of [
        ...(reactor.children[aggregator] ?? []),
        ...(reactor.inheritors[aggregator] ?? []),
      ]) {
        if (seen.has(child)) continue;
        seen.add(child);
        modules.add(child);
        queue.push(child);
      }
    }
  };

  for (const changedFile of changedFiles) {
    const path = normalizedChangedPath(root, changedFile);
    if (path === null) continue;
    // A wrapper-spelled file that is ALSO a recorded parent file is a build
    // input first: the skip must not swallow its closure and routing.
    if (path === otherPlatformWrapper && !namedParentDirs.has(path)) continue;
    const namedParentDir = namedParentDirs.get(path);
    if (namedParentDir !== undefined) {
      if (namedParentDir === '.') {
        reactorWide = true;
      } else {
        if (deepestFirst.includes(namedParentDir)) {
          modules.add(namedParentDir);
        }
        addDescendantClosure(namedParentDir);
      }
      // Deliberately NO continue: the file still routes through the
      // ownership checks below, so the module whose tree holds it joins
      // the scope, and an out-of-reactor home reaches the inactive-project
      // abort instead of bypassing it.
    } else if (REACTOR_WIDE_FILES.has(path) || path.startsWith('.mvn/')) {
      reactorWide = true;
      continue;
    }
    const owner = deepestFirst.find(
      (module) => path === module || path.startsWith(`${module}/`),
    );
    if (owner) {
      if (path === `${owner}/pom.xml`) {
        // A module POM is the parent config of every module aggregated
        // beneath it AND of every module declaring it as `<parent>`: the
        // descendants inherit what changed, and `-am` alone would compile
        // only the aggregator and test nothing.
        modules.add(owner);
        addDescendantClosure(owner);
        continue;
      }
      // The out-of-reactor project check outranks the documentation
      // exemption, exactly as in the unowned branch: a changed path that
      // BELONGS to an inactive nested project fails closed no matter its
      // extension. Documentation is then judged relative to the owning
      // module so the `src/` guard means the MODULE's source tree:
      // `core/README.md` is a no-op run, but
      // `core/src/test/resources/expected.txt` is test data and must keep
      // building.
      const nearestProject = nearestMavenProject(
        root,
        path,
        reactor.projectDirs,
      );
      if (nearestProject && !reactor.projectDirs.includes(nearestProject)) {
        inactiveProjects.add(nearestProject);
        continue;
      }
      // Repo metadata is exempted module-relatively for the same reason as
      // at the root: a module-level LICENSE cannot change what Maven builds.
      if (
        !isDocumentationPath(path.slice(owner.length + 1)) &&
        !isRepoMetadataPath(path.slice(owner.length + 1))
      ) {
        modules.add(owner);
      }
      continue;
    }
    // The project check outranks the documentation exemption: a changed path
    // that BELONGS to an out-of-reactor project fails closed no matter its
    // extension, as step 5 of the ownership rules mandates. Root-level docs
    // still fall through — the root project '.' is always in the reactor.
    const nearestProject = nearestMavenProject(root, path, reactor.projectDirs);
    if (nearestProject && !reactor.projectDirs.includes(nearestProject)) {
      inactiveProjects.add(nearestProject);
      continue;
    }
    if (isDocumentationPath(path) || isRepoMetadataPath(path)) continue;
    // Source owned by the root project '.' scopes to `-pl . -am`: no other
    // module compiles the root artifact's own `src/`, and on the large
    // reactors this adapter targets, a reactor-wide run can spend its whole
    // deadline proving nothing. Anything ELSE unowned (a root build script
    // or checkstyle config) can affect every module and stays reactor-wide.
    if (nearestProject === '.' && (path === 'src' || path.startsWith('src/'))) {
      modules.add('.');
      continue;
    }
    reactorWide = true;
  }

  return {
    reactorWide,
    modules: [...modules].sort(),
    inactiveProjects: [...inactiveProjects].sort(),
  };
}

interface ReportSnapshot {
  mtimes: Map<string, number>;
}

interface MavenTestSummary {
  report: string;
  tests: number;
  failures: number;
  errors: number;
  skipped: number;
  failedCases: string[];
}

function reportPaths(root: string, reactor: MavenReactor): string[] {
  const paths: string[] = [];
  for (const projectDir of reactor.projectDirs) {
    for (const reportDir of REPORT_DIRS) {
      const dir = join(root, projectDir, 'target', reportDir);
      let entries: Dirent[];
      try {
        entries = readdirSync(dir, { withFileTypes: true });
      } catch {
        continue;
      }
      for (const entry of entries) {
        if (entry.isFile() && entry.name.endsWith('.xml')) {
          paths.push(join(dir, entry.name));
        }
      }
    }
  }
  return paths;
}

function snapshotReports(root: string, reactor: MavenReactor): ReportSnapshot {
  // Freshness is an mtime comparison, and some filesystems resolve mtimes at
  // 1s granularity: a report rewritten inside the same tick reads as stale and
  // is dropped. That degrades in the safe direction — absent test-count
  // evidence, never a wrong verdict — so no sub-second workaround is worth it.
  const mtimes = new Map<string, number>();
  for (const path of reportPaths(root, reactor)) {
    try {
      mtimes.set(path, statSync(path).mtimeMs);
    } catch {
      // The report disappeared while the snapshot was being taken.
    }
  }
  return { mtimes };
}

function xmlAttributes(source: string): Map<string, string> {
  const attributes = new Map<string, string>();
  // The lookbehind pins each name to a maximal word run: without it, a long
  // attribute-name run with no `=` backtracked the greedy name from every
  // start position — quadratic on PR-controlled report bytes.
  const re = /(?<![\w:.-])([\w:.-]+)\s*=\s*(?:"([^"]*)"|'([^']*)')/g;
  let match: RegExpExecArray | null;
  while ((match = re.exec(source)) !== null) {
    attributes.set(match[1], match[2] ?? match[3] ?? '');
  }
  return attributes;
}

function decodeXml(value: string): string {
  return value
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&');
}

function numberAttribute(
  attributes: Map<string, string>,
  name: string,
): number {
  const value = Number.parseInt(attributes.get(name) ?? '0', 10);
  if (!Number.isFinite(value)) return 0;
  // A malformed report's negative count must not cancel legitimate counts
  // from its neighbours when totals roll up across reports.
  return Math.max(0, value);
}

/** A start tag located by `xmlOpenTagHeaders`. */
interface XmlOpenTagHeader {
  /** Attribute run between the tag name and the closing `>`. */
  attributes: string;
  /** Offset of the opening `<` in the scanned text. */
  index: number;
  /** The full tag text; a self-closing tag ends `/>`. */
  text: string;
}

const XML_WORD_CHAR = /[A-Za-z0-9_]/;

/**
 * Quote-aware linear scan for `<name …>` start tags. A `>` is legal
 * unescaped inside a quoted attribute value (parameterized-test and
 * @DisplayName suite/case names carry them). The regex header walk this
 * replaces went quadratic on PR-controlled reports: one never-closed opener
 * made every later tag start scan to EOF (a 2 MiB report of `<testcase x `
 * openers measured minutes per file — a denial of service through the very
 * evidence this parser exists to read). Here each byte is examined once:
 * locate a `<name` start, then advance to the next `>` outside quotes. An
 * opener with no `>` before EOF ends the scan — the truncated-XML branch in
 * parseTestReport handles what was seen until then.
 */
function xmlOpenTagHeaders(xml: string, name: string): XmlOpenTagHeader[] {
  const tag = `<${name.toLowerCase()}`;
  // toLowerCase() can lengthen UTF-16 text (`İ` → `i` + U+0307), so offsets
  // located in a lowercased copy would misindex the original xml past the
  // first such character. Use the copy only while it stayed the same length;
  // otherwise scan the original case-insensitively.
  const lower = xml.toLowerCase();
  const indexOfTag =
    lower.length === xml.length
      ? (from: number): number => lower.indexOf(tag, from)
      : (from: number): number => {
          for (let i = from; i + tag.length <= xml.length; i += 1) {
            let matched = true;
            for (let j = 0; j < tag.length; j += 1) {
              if (xml[i + j].toLowerCase() !== tag[j]) {
                matched = false;
                break;
              }
            }
            if (matched) return i;
          }
          return -1;
        };
  const headers: XmlOpenTagHeader[] = [];
  let from = 0;
  for (;;) {
    const start = indexOfTag(from);
    if (start === -1) return headers;
    from = start + 1;
    // `\b` semantics: `<testsuite` must not match `<testsuites`.
    const next = xml[start + tag.length];
    if (next !== undefined && XML_WORD_CHAR.test(next)) continue;
    let quote: '"' | "'" | null = null;
    let end = -1;
    for (let i = start + tag.length; i < xml.length; i++) {
      const c = xml[i];
      if (quote !== null) {
        if (c === quote) quote = null;
      } else if (c === '"' || c === "'") {
        quote = c;
      } else if (c === '>') {
        end = i;
        break;
      }
    }
    if (end === -1) return headers;
    headers.push({
      attributes: xml.slice(start + tag.length, end),
      index: start,
      text: xml.slice(start, end + 1),
    });
    from = end + 1;
  }
}

const TESTCASE_CLOSE_RE = /<\/testcase\s*>/gi;

/**
 * Drop terminated `<![CDATA[ … ]]>` sections and `<!-- … -->` comments in
 * one linear pass: both are opaque text, never markup, and scanning a
 * commented-out or CDATA-wrapped suite (aggregate writers like jest-junit
 * and karma emit both) fabricated phantom suites and failure evidence. The
 * earlier marker wins — a marker inside the other kind is literal content,
 * consumed with it. An unterminated section stays verbatim: its content
 * then fails closed exactly as it did before this handling existed.
 */
function stripOpaqueSections(xml: string): string {
  if (!xml.includes('<![CDATA[') && !xml.includes('<!--')) return xml;
  const chunks: string[] = [];
  let i = 0;
  let chunkStart = 0;
  while (i < xml.length) {
    let closer: string | null = null;
    let markerLength = 0;
    if (xml.startsWith('<!--', i)) {
      closer = '-->';
      markerLength = 4;
    } else if (xml.startsWith('<![CDATA[', i)) {
      closer = ']]>';
      markerLength = 9;
    }
    if (closer === null) {
      i += 1;
      continue;
    }
    const end = xml.indexOf(closer, i + markerLength);
    if (end === -1) break;
    chunks.push(xml.slice(chunkStart, i));
    i = end + closer.length;
    chunkStart = i;
  }
  chunks.push(xml.slice(chunkStart));
  return chunks.join('');
}

function parseTestReport(root: string, path: string): MavenTestSummary | null {
  try {
    if (statSync(path).size > MAX_REPORT_BYTES) return null;
  } catch {
    return null;
  }
  let xml: string;
  try {
    xml = readFileSync(path, 'utf8');
  } catch {
    return null;
  }
  // CDATA and comment content is opaque text, never markup: test output
  // wrapped in `<system-out>` CDATA routinely CONTAINS XML samples, and
  // aggregate writers also emit commented-out markup; scanning either as
  // real fabricated phantom suites and failure evidence. Drop terminated
  // sections; an unterminated one stays as-is and fails closed as before.
  xml = stripOpaqueSections(xml);
  // Aggregate counts across EVERY suite in the file: aggregate JUnit writers
  // (jest-junit, karma reporters aimed at target/surefire-reports/ for
  // SonarQube) emit several `<testsuite>` elements, and reading only the
  // first undercounts later suites' failures to zero.
  let tests = 0;
  let failures = 0;
  let errors = 0;
  let skipped = 0;
  let suites = 0;
  for (const suite of xmlOpenTagHeaders(xml, 'testsuite')) {
    const attributes = xmlAttributes(suite.attributes);
    suites += 1;
    tests += numberAttribute(attributes, 'tests');
    failures += numberAttribute(attributes, 'failures');
    errors += numberAttribute(attributes, 'errors');
    skipped += numberAttribute(attributes, 'skipped');
  }
  if (suites === 0) return null;
  const failedCases: string[] = [];
  let consumedUntil = 0;
  for (const header of xmlOpenTagHeaders(xml, 'testcase')) {
    const bodyStart = header.index + header.text.length;
    let body = '';
    if (!header.text.endsWith('/>')) {
      // Closing tags are consumed forward-only: an opener whose body starts
      // before the last consumed close overlaps an already-attributed body —
      // malformed XML, and the pre-fix shape that re-found the same early
      // close for every later opener, quadratic over the whole file.
      if (bodyStart < consumedUntil) continue;
      TESTCASE_CLOSE_RE.lastIndex = bodyStart;
      const close = TESTCASE_CLOSE_RE.exec(xml);
      // A file truncated mid-case has no closing tag to attribute a body to;
      // every later opener has the same hole, so stop rather than rescan.
      if (!close) break;
      body = xml.slice(bodyStart, close.index);
      consumedUntil = close.index + close[0].length;
    }
    if (!/<(?:failure|error)\b/i.test(body)) continue;
    const testcaseAttributes = xmlAttributes(header.attributes);
    const className = decodeXml(testcaseAttributes.get('classname') ?? '');
    const name = decodeXml(testcaseAttributes.get('name') ?? 'unknown');
    failedCases.push(className ? `${className}#${name}` : name);
  }
  return {
    report: toPosix(relative(root, path)),
    tests,
    failures,
    errors,
    skipped,
    failedCases,
  };
}

function freshTestSummaries(
  root: string,
  reactor: MavenReactor,
  before: ReportSnapshot,
): MavenTestSummary[] {
  const summaries: MavenTestSummary[] = [];
  for (const path of reportPaths(root, reactor)) {
    let mtime: number;
    try {
      mtime = statSync(path).mtimeMs;
    } catch {
      continue;
    }
    const previous = before.mtimes.get(path);
    if (previous !== undefined && mtime <= previous) continue;
    const summary = parseTestReport(root, path);
    if (summary) summaries.push(summary);
  }
  // Byte-order, not localeCompare: evidence-line order must not depend on
  // the host's ICU/locale settings.
  return summaries.sort((a, b) =>
    a.report < b.report ? -1 : a.report > b.report ? 1 : 0,
  );
}

/** Report paths are always `<projectDir>/target/<report-dir>/<file>` (see reportPaths). */
function projectDirOf(report: string): string {
  return dirname(dirname(dirname(report)));
}

/**
 * NOTE: the `[maven-test-report]`/`[maven-test-failure]` markers below are
 * text-mined by test-plan out of `output`, which is dominated by the PR's
 * own test stdout — like the npm console-summary parsing, they are NOT
 * tamper-proof. Verdicts that must survive a hostile PR belong in a
 * structured report field, not in mined text.
 */
function appendTestSummaries(
  result: CommandResult,
  summaries: MavenTestSummary[],
): CommandResult {
  if (summaries.length === 0) return result;

  const clean = new Map<string, MavenTestSummary[]>();
  const failing: MavenTestSummary[] = [];
  for (const summary of summaries) {
    if (summary.failures > 0 || summary.errors > 0) {
      failing.push(summary);
    } else {
      const project = projectDirOf(summary.report);
      const group = clean.get(project);
      if (group) group.push(summary);
      else clean.set(project, [summary]);
    }
  }

  const lines: string[] = [];
  const cleanGroups = [...clean.entries()].map(([project, group]) => {
    const totals = group.reduce(
      (sum, item) => ({
        tests: sum.tests + item.tests,
        skipped: sum.skipped + item.skipped,
      }),
      { tests: 0, skipped: 0 },
    );
    return {
      line:
        `[maven-test-report] ${project} (${group.length} report(s)): ` +
        `tests=${totals.tests}, failures=0, errors=0, skipped=${totals.skipped}`,
      // The group's per-report clamped passed total — what the omission
      // marker aggregates (see below).
      clampedPassed: group.reduce(
        (sum, item) => sum + Math.max(0, item.tests - item.skipped),
        0,
      ),
    };
  });
  const cleanLines = cleanGroups.map((group) => group.line);
  // One line per project dir: bounded by module count, but a 300-module
  // reactor still appends 300 lines AFTER the command output was trimmed, so
  // cap it like the failing-report and case blocks. The marker carries the
  // omitted counts so count adjudication still sees the whole run — a
  // truncated total once "corrected" a right author count to a wrong one.
  // They are per-report CLAMPED passed totals: the parser clamps per parsed
  // line, and clamping the marker's aggregated raw totals instead would let
  // one anomalous report (Surefire does not guarantee tests >= skipped)
  // cancel the passed counts of its batchmates — the exact cancellation the
  // per-report clamp prevents.
  if (cleanGroups.length > MAX_CLEAN_ROLLUP_LINES) {
    const omittedGroups = cleanGroups.slice(MAX_CLEAN_ROLLUP_LINES);
    cleanLines.length = MAX_CLEAN_ROLLUP_LINES;
    const passed = omittedGroups.reduce(
      (sum, group) => sum + group.clampedPassed,
      0,
    );
    cleanLines.push(
      `[maven-test-report] ${omittedGroups.length} more clean project rollup(s) omitted: ` +
        `tests=${passed}, failures=0, errors=0, skipped=0`,
    );
  }
  lines.push(...cleanLines);

  const reportLines = failing.map(
    (summary) =>
      `[maven-test-report] ${summary.report}: tests=${summary.tests}, ` +
      `failures=${summary.failures}, errors=${summary.errors}, skipped=${summary.skipped}`,
  );
  if (reportLines.length > MAX_FAILING_REPORT_LINES) {
    const omittedSummaries = failing.slice(MAX_FAILING_REPORT_LINES);
    reportLines.length = MAX_FAILING_REPORT_LINES;
    // Per-report clamped passed totals, for the same reason as the clean
    // marker above.
    const passed = omittedSummaries.reduce(
      (sum, item) =>
        sum +
        Math.max(0, item.tests - item.failures - item.errors - item.skipped),
      0,
    );
    reportLines.push(
      `[maven-test-report] ${omittedSummaries.length} more failing report(s) omitted: ` +
        `tests=${passed}, failures=0, errors=0, skipped=0`,
    );
  }
  lines.push(...reportLines);

  const caseLines = failing.flatMap((summary) =>
    summary.failedCases.map(
      (testcase) => `[maven-test-failure] ${summary.report}: ${testcase}`,
    ),
  );
  if (caseLines.length > MAX_FAILURE_CASE_LINES) {
    const omitted = caseLines.length - MAX_FAILURE_CASE_LINES;
    caseLines.length = MAX_FAILURE_CASE_LINES;
    caseLines.push(
      `[maven-test-failure] ${omitted} more failing case(s) omitted`,
    );
  }
  lines.push(...caseLines);

  return { ...result, output: `${result.output}\n${lines.join('\n')}`.trim() };
}

function unsupportedReport(note: string): BuildTestReport {
  return {
    toolchain: 'unsupported',
    affected: [],
    buildSet: [],
    widenedWith: [],
    install: null,
    build: [],
    test: [],
    ok: true,
    timedOut: [],
    note,
  };
}

/**
 * How a non-clean best-effort dependency warm-up ended. The timeout note
 * quotes the deadline that was actually applied — the whole-call budget
 * shortens it below the `--timeout` flag — not the flag default.
 */
function warmUpOutcome(
  install: CommandResult,
  deadlineSeconds: number,
): string {
  return (
    `Dependency warm-up (\`${install.command}\`) ` +
    (install.timedOut
      ? `ran out of time (${deadlineSeconds}s)`
      : install.exitCode === null
        ? 'ended without an exit code (a spawn failure or signal outside the deadline)'
        : `exited ${install.exitCode}`)
  );
}

function mavenReport(
  fields: Omit<BuildTestReport, 'toolchain'>,
): BuildTestReport {
  return { toolchain: 'maven', ...fields };
}

/**
 * Shell and JVM launch diagnostics. The runner-missing and JAVA_HOME forms
 * are printed bare by the shell or the mvn launcher — never with Maven
 * framing — so requiring `[ERROR]` there would miss the real thing. The
 * unframed scan therefore stops at the first Maven-framed line: these
 * diagnostics precede any Maven output, and once Maven is talking, a test
 * printing `mvn: command not found` in its own stdout must not launder a
 * source failure into infrastructure. `No space left on device` is different:
 * a test exercising a disk-full path can print it in its own stdout at any
 * point, so only Maven's own `[ERROR]`/`[FATAL]` framing tells the outage
 * from test output — the same argument DEPENDENCY_FAILURE_LINE_RE encodes.
 */
function isLaunchFailure(output: string): boolean {
  const lines = output.split('\n');
  const prelude: string[] = [];
  for (const line of lines) {
    if (/^\[(?:INFO|WARNING|ERROR|FATAL)\]/.test(line)) break;
    prelude.push(line);
  }
  return (
    prelude.some(
      (line) =>
        /(?:mvn|java): (?:command )?not found/i.test(line) ||
        /command not found: (?:mvn|java)(?:\.cmd)?\b/i.test(line) ||
        /(?:mvn|java)(?:\.cmd)?'? is not recognized as an internal or external command/i.test(
          line,
        ) ||
        /The term '?(?:mvn|java)'? is not recognized/i.test(line) ||
        /Unknown command: (?:mvn|java)\b/i.test(line) ||
        /JAVA_HOME.*(?:not defined|incorrectly|invalid directory)/i.test(
          line,
        ) ||
        /Unable to locate a Java Runtime/i.test(line),
    ) ||
    lines.some((line) =>
      /^\[(?:ERROR|FATAL)\].*No space left on device/i.test(line),
    )
  );
}

/**
 * Dependency/network/plugin failures count only when Maven itself frames them:
 * a test that fails printing `Connection refused` in its stdout is a source
 * finding, not a network outage, and free-text matching cannot tell the two
 * apart. Maven's own error lines carry the `[ERROR]`/`[FATAL]` prefix. The
 * line-level form is exported so `build-test`'s output trim rescues these from
 * the omitted middle — the classification below runs on that trimmed output,
 * and a marker lost to the trim would file a network outage against the PR.
 */
const DEPENDENCY_FAILURE_LINE_RE =
  /^\[(?:ERROR|FATAL)\].*(?:Could not resolve dependencies|Failed to (?:collect|read artifact descriptor)|Could not transfer artifact|Non-resolvable parent POM|PluginResolutionException|DependencyResolutionException|No plugin found for prefix|Unknown host|Name or service not known|Temporary failure in name resolution|Connection (?:reset|refused|timed out)|PKIX path building failed|status code: (?:401|403|407|429|5\d\d))/i;

export function isDependencyFailureLine(line: string): boolean {
  return DEPENDENCY_FAILURE_LINE_RE.test(line);
}

function isDependencyFailure(output: string): boolean {
  return output.split('\n').some(isDependencyFailureLine);
}

/**
 * Compile and test failure markers Maven itself prints once a run reaches
 * building or executing code. A dependency outage can share the output with
 * them (a flaky mirror, or an upstream module pulled in by `-am`), and the
 * acquisition carve-out must not launder the source failure into an
 * infrastructure result: a compile failure writes no Surefire XML, so
 * `freshFailures` cannot see it. `[ERROR]`-framed and line-level like
 * DEPENDENCY_FAILURE_LINE_RE, for the same trim-rescue reason.
 *
 * The line shapes cover the JVM compilers Maven hosts: Java's `.java:[l,c]`,
 * Kotlin's `.kt: (l, c):`, Scala's `.scala:l:`, Groovy's `.groovy: l:`, plus
 * the compiler-plugin goal framing a failed compile ends with.
 */
const SOURCE_FAILURE_LINE_RE =
  /^\[(?:ERROR|FATAL)\](?: COMPILATION ERROR| There are test failures| .*\.java:\[\d+,\d+\]| .*\.kts?: ?\(\d+, ?\d+\)| .*\.scala:\d+| .*\.groovy: ?\d+| Failed to execute goal .*Compilation failure)/i;

export function isSourceFailureLine(line: string): boolean {
  return SOURCE_FAILURE_LINE_RE.test(line);
}

function isSourceFailure(output: string): boolean {
  return output.split('\n').some(isSourceFailureLine);
}

function hasFreshTestFailure(summaries: MavenTestSummary[]): boolean {
  return summaries.some(
    (summary) => summary.failures > 0 || summary.errors > 0,
  );
}

/**
 * Shell diagnostics for a wrapper that cannot start. `Permission denied` is
 * the missing executable bit; `bad interpreter` / `No such file or directory`
 * on the `./mvnw` line is a CRLF-committed shebang dying on Linux. bash >=
 * 5.2 reports the same death as `cannot execute: required file not found`
 * and dash as a bare `not found`; a `#!/usr/bin/env sh\r` shebang names
 * `/usr/bin/env`, not the wrapper, so that line gets its own alternant.
 * Win32 is known-uncovered: a broken `mvnw.cmd` (missing, CRLF, ACL) matches
 * none of these POSIX shapes and stays attributed to the diff.
 */
const WRAPPER_LAUNCH_FAILURE_RE =
  /(?:^|\n)(?:.*\.\/mvnw[^\n]*(?:Permission denied|bad interpreter|No such file or directory|cannot execute: required file not found|not found)|\/usr\/bin\/env:[^\n]*No such file or directory)(?:\n|$)/i;

function summaryTotals(summaries: MavenTestSummary[]) {
  return summaries.reduce(
    (sum, item) => ({
      tests: sum.tests + item.tests,
      failures: sum.failures + item.failures,
      errors: sum.errors + item.errors,
      skipped: sum.skipped + item.skipped,
    }),
    { tests: 0, failures: 0, errors: 0, skipped: 0 },
  );
}

export function shellSelector(
  modules: string[],
  platform: string = process.platform,
): string {
  const selector = modules.join(',');
  if (/^[A-Za-z0-9_./,-]+$/.test(selector)) return selector;
  // The command runs through cmd.exe on Windows, where POSIX quoting is
  // literal and a `"…"` wrap does not stop %VAR% expansion or an embedded
  // quote. That stays safe only because readMavenReactor rejects any module
  // entry whose pom.xml is missing from disk (the existsSync gate), rejects
  // `%` outright (the `/[<$>{}&%,:]/` gate parsePomStructure applies to
  // `<module>` entries — cmd.exe expands it even inside `"…"`), and a
  // Windows filename cannot contain `"` or `|` — do not remove those gates.
  return platform === 'win32' ? `"${selector}"` : shellQuotePath(selector);
}

/**
 * The wrapper a platform can actually execute. Every wrapper repo ships both
 * `mvnw` and `mvnw.cmd`; `./mvnw` is not runnable under win32 `cmd.exe`. On
 * POSIX a wrapper without the executable bit (a `core.fileMode=false`
 * checkout) falls back to the system `mvn` rather than dying with exit 126
 * and turning the whole run into an infrastructure handoff that verifies
 * nothing.
 */
export function mavenExecutable(
  root: string,
  platform: string = process.platform,
): string {
  if (platform === 'win32') {
    return existsSync(join(root, 'mvnw.cmd')) ? 'mvnw.cmd' : 'mvn';
  }
  try {
    accessSync(join(root, 'mvnw'), constants.X_OK);
    return './mvnw';
  } catch {
    return 'mvn';
  }
}

/**
 * Resolution inputs named by `.mvn/maven.config`: the launcher injects them
 * into the very command this adapter runs, so a settings or local-repository
 * location referenced there is a dependency input the PR can change.
 */
function mavenConfigDependencyInputs(root: string): string[] {
  let config: string;
  try {
    config = readFileSync(join(root, '.mvn', 'maven.config'), 'utf8');
  } catch {
    return [];
  }
  const inputs: string[] = [];
  const tokens = config.split(/\s+/);
  const pairedFlags = new Set(['-s', '--settings', '-gs', '--global-settings']);
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i];
    // Maven 3.9's chained local repositories: EVERY entry is a local-
    // repository location. Checked before `-Dmaven.repo.local=` — the
    // longer property merely starts with that prefix.
    if (token.startsWith('-Dmaven.repo.local.tail=')) {
      for (const part of token
        .slice('-Dmaven.repo.local.tail='.length)
        .split(/[,|]/)) {
        if (!part) continue;
        const path = normalizedChangedPath(root, part);
        if (path !== null) inputs.push(path);
      }
      continue;
    }
    let value: string | undefined;
    if (pairedFlags.has(token)) value = tokens[i + 1];
    else if (token.startsWith('--settings='))
      value = token.slice('--settings='.length);
    else if (token.startsWith('--global-settings='))
      value = token.slice('--global-settings='.length);
    else if (token.startsWith('-Dmaven.repo.local='))
      value = token.slice('-Dmaven.repo.local='.length);
    // commons-cli also accepts the attached short forms (`-s<path>`): the
    // remainder of a token whose option bears an argument becomes the value.
    else if (/^-s.+/.test(token)) value = token.slice('-s'.length);
    else if (/^-gs.+/.test(token)) value = token.slice('-gs'.length);
    if (!value) continue;
    const path = normalizedChangedPath(root, value);
    if (path !== null) inputs.push(path);
  }
  return inputs;
}

function runMavenToolchain(args: ToolchainRunArgs): BuildTestReport {
  const perCommandMs = args.timeout * 1000;
  /** The deadline a command was actually given, in whole seconds — the
   * whole-call budget shortens it below the flag default, and timeout
   * notes must quote the number that fired. */
  const deadlineSecs = (r: CommandResult): number =>
    Math.round((r.deadlineMs ?? perCommandMs) / 1000);
  // The floor never exceeds the caller's own per-command deadline: a run
  // whose whole budget is one short deadline still gets that attempt,
  // exactly as it did before budgeting existed.
  const attemptFloorMs = Math.min(BUDGET_MIN_ATTEMPT_MS, perCommandMs);
  // The whole-call budget the npm adapter runs under, for the same reason:
  // the warm-up and the lifecycle command SUM against the outer tool
  // timeout, and a cold reactor whose warm-up takes the whole sum leaves
  // the lifecycle command nothing — or the outer kill discards the report.
  // It bounds what the COMMANDS spend: reactor parsing and scoping are
  // linear and fast, and charging them would let millisecond overhead
  // starve a call whose whole budget is one short deadline.
  const callBudgetMs =
    (args.budget ?? Math.max(args.timeout, args.timeout * 2 - 30)) * 1000;
  let spentMs = 0;
  /** Budget left for the whole call; every command spends from it. */
  const remainingMs = (): number => callBudgetMs - spentMs;
  const budgetedExec = (
    command: string,
    cwd: string,
    timeoutMs: number,
  ): CommandResult => {
    const startedAt = Date.now();
    const r = args.exec(command, cwd, timeoutMs);
    spentMs += Date.now() - startedAt;
    return r;
  };
  const parsed = readMavenReactor(args.root);
  if (!parsed.reactor) {
    return unsupportedReport(
      `${parsed.error} Maven reactor ownership cannot be determined safely, so no partial verification was run.`,
    );
  }
  const ownership = detectMavenOwnership(
    args.root,
    args.changedFiles,
    parsed.reactor,
  );
  if (ownership.inactiveProjects.length > 0) {
    return unsupportedReport(
      `The diff changes Maven project(s) outside the root reactor: ${ownership.inactiveProjects.join(', ')}. ` +
        'They may be standalone or profile-inactive under the current reactor, so no root-scoped Maven command was guessed.',
    );
  }
  if (!ownership.reactorWide && ownership.modules.length === 0) {
    return mavenReport({
      affected: [],
      buildSet: [],
      widenedWith: [],
      install: null,
      build: [],
      test: [],
      ok: true,
      timedOut: [],
      note:
        `The diff changes ${args.changedFiles.length} file(s), but none of them needs a Maven build ` +
        'or test (documentation, repository metadata, or nothing inside a Maven module). There is no ' +
        'Maven target to run — this is a complete answer.',
    });
  }

  const executable = mavenExecutable(args.root);
  // The wrapper is the script AND its configuration:
  // `.mvn/wrapper/maven-wrapper.properties` names the distribution the script
  // downloads and executes, so a diff touching it controls what `./mvnw`
  // runs exactly as one touching the script does.
  const wrapperConfigChanged = args.changedFiles.some((file) => {
    const path = normalizedChangedPath(args.root, file);
    return path !== null && path.startsWith('.mvn/wrapper/');
  });
  const wrapperChanged =
    wrapperConfigChanged ||
    args.changedFiles.some((file) => {
      const path = normalizedChangedPath(args.root, file);
      return path === 'mvnw' || path === 'mvnw.cmd';
    });
  // Every wrapper repo ships both platform variants, but only ONE is ever
  // executed here: a diff touching only the other platform's wrapper cannot
  // affect this run, so the carve-out suppressions below key on the file
  // this platform executes, not on either wrapper.
  const executedWrapper =
    executable === './mvnw'
      ? 'mvnw'
      : executable === 'mvnw.cmd'
        ? 'mvnw.cmd'
        : null;
  const executedWrapperChanged =
    executedWrapper !== null &&
    (wrapperConfigChanged ||
      args.changedFiles.some(
        (file) => normalizedChangedPath(args.root, file) === executedWrapper,
      ));
  // The platform-preferred wrapper, whether or not it was executed: when the
  // diff deletes it (or drops its executable bit), mavenExecutable falls back
  // to system `mvn`, executedWrapper is null, and the fallback's launch death
  // is the diff's own doing, not an environmental result.
  const platformWrapper = process.platform === 'win32' ? 'mvnw.cmd' : 'mvnw';
  const platformWrapperChanged = args.changedFiles.some(
    (file) => normalizedChangedPath(args.root, file) === platformWrapper,
  );
  // The dependency carve-out below must not file a PR-caused breakage as
  // environmental: when the diff changed POMs, `.mvn/**`, the settings or
  // repository locations `.mvn/maven.config` references, or the executed
  // wrapper (which can redirect the local repository or settings), the
  // resolution failure may be the diff's own doing. POMs under a project's
  // `src/` tree are test fixtures (see isUnderTestSourceTree) and cannot
  // change the reactor's dependency resolution — unless the reactor models
  // them as live members, in which case they are real projects here too.
  const settingsInputs = mavenConfigDependencyInputs(args.root);
  const dependencyInputsChanged = args.changedFiles.some((file) => {
    const path = normalizedChangedPath(args.root, file);
    if (path === null) return false;
    if (path === 'pom.xml' || path.startsWith('.mvn/')) return true;
    // Named parent POM files backing a recorded inheritance edge are
    // resolution inputs exactly like a member's `pom.xml`: ownership routing
    // already models them as build inputs (namedParentDirs).
    if ((parsed.reactor.parentPomFiles ?? []).includes(path)) return true;
    // A named parent file the diff DELETED carries no parentPomFiles entry —
    // the edge no longer resolves on disk — but the resolution failure it
    // now causes is the diff's own doing.
    if ((parsed.reactor.declaredParentFiles ?? []).includes(path)) return true;
    if (executedWrapper !== null && path === executedWrapper) return true;
    if (
      settingsInputs.some(
        (input) => path === input || path.startsWith(`${input}/`),
      )
    ) {
      return true;
    }
    if (path.endsWith('/pom.xml')) {
      // Only a reactor MEMBER's POM is a resolution input: a changed member
      // POM counts exactly like the root `pom.xml` above, whether it stays
      // on disk (the common case) or the diff deleted it. Fixture POMs
      // under a project's `src/` tree and POMs in out-of-reactor projects
      // are the excluded shapes — counting them would suppress the
      // infrastructure carve-out for outages the diff cannot have caused.
      const projectDir = path.slice(0, -'/pom.xml'.length);
      return parsed.reactor.projectDirs.includes(projectDir);
    }
    return false;
  });
  const lifecycle = args.buildOnly ? 'test-compile' : 'test';
  // `-am` builds the changed modules plus their upstream closure. `-amd`
  // (downstream) selects the whole reactor on exactly the repos this adapter
  // was built for, and a run that spends its whole deadline proving nothing
  // is the failure this command exists to avoid — downstream coverage stays
  // the project's CI matrix, as with the npm adapter's scope.
  const selector = ownership.reactorWide
    ? ''
    : shellSelector(ownership.modules);
  const selectorOverflow =
    !ownership.reactorWide && selector.length > MAX_SELECTOR_CHARS;
  const reactorWide = ownership.reactorWide || selectorOverflow;
  const affected = reactorWide ? ['.'] : ownership.modules;
  const buildSet = reactorWide ? ['.'] : ownership.modules;
  const narrowing = reactorWide ? '' : ` -pl ${selector} -am`;
  const command = `${executable} --batch-mode --no-transfer-progress${narrowing} ${lifecycle}`;
  // Disk preflight, mirroring the npm adapter: Maven resolves plugins and
  // dependencies inside the lifecycle command, and a run that dies on ENOSPC
  // leaves a full disk that fails every agent scheduled after this one.
  const free = freeDiskBytes(args.root);
  if (free !== null && free < INSTALL_MIN_FREE_BYTES) {
    return mavenReport({
      affected,
      buildSet,
      widenedWith: [],
      install: null,
      build: [],
      test: [],
      ok: false,
      timedOut: [],
      note:
        `Insufficient disk space (${gib(free)}G free, need ~${gib(INSTALL_MIN_FREE_BYTES)}G): ` +
        `skipped \`${command}\`. Maven resolves dependencies inside the lifecycle ` +
        'command, so nothing could be built or tested. This is an environment ' +
        'issue, not a code finding — report it as informational.',
    });
  }
  // Dependency warm-up on its own deadline. A review worktree is cold by
  // construction, and Maven resolves dependencies and plugins INSIDE the
  // lifecycle command, sharing the single deadline with compilation and the
  // tests — a cold resolve on the large reactors this adapter targets can
  // spend the whole budget downloading and verify nothing, exactly the
  // timeout-as-infrastructure outcome the command exists to prevent.
  // `dependency:go-offline` is best-effort: it has known gaps (some plugin
  // dependencies resolve lazily), and the lifecycle command resolves what it
  // missed exactly as before. Unlike a partial `node_modules`, a partial
  // local repository is content-addressed and resumable — never worse than
  // none — so no warm-up outcome blocks the lifecycle run. Gated on the same
  // install flag as `npm ci`: `--no-install` means "assume warm, fetch
  // nothing".
  let install: CommandResult | null = null;
  if (args.install && remainingMs() >= attemptFloorMs) {
    install = budgetedExec(
      `${executable} --batch-mode --no-transfer-progress${narrowing} dependency:go-offline -q`,
      args.root,
      Math.min(perCommandMs, remainingMs()),
    );
  }
  if (remainingMs() < attemptFloorMs) {
    // spentMs === 0 means nothing ever ran: the budget was below the
    // attempt floor from the start, so "was spent" would assert a
    // consumption that has no consumer.
    let note =
      spentMs === 0
        ? `The granted budget (${Math.round(callBudgetMs / 1000)}s) is below the ` +
          `${Math.round(attemptFloorMs / 1000)}s minimum a Maven attempt needs, so nothing ` +
          'could be started, built, or tested. This is an infrastructure result, ' +
          'not a defect in the diff — report it as informational.'
        : `The whole-call budget (${Math.round(callBudgetMs / 1000)}s) was spent ` +
          `before \`${command}\` could start, so nothing could be built or tested. ` +
          'This is an infrastructure result, not a defect in the diff — report it as informational.';
    if (install) {
      note +=
        ` ${warmUpOutcome(install, deadlineSecs(install))} — the budget it consumed ` +
        'is what stopped the lifecycle command.';
    }
    return mavenReport({
      affected,
      buildSet,
      widenedWith: [],
      install,
      build: [],
      test: [],
      ok: false,
      timedOut: [],
      note,
    });
  }
  // A build-only run never reads the evidence, so it skips the snapshot too
  // — on a large reactor that is a readdir + statSync sweep of every
  // reports dir for nothing.
  const before = args.buildOnly
    ? null
    : snapshotReports(args.root, parsed.reactor);
  const executed = budgetedExec(
    command,
    args.root,
    Math.min(perCommandMs, remainingMs()),
  );
  const summaries = before
    ? freshTestSummaries(args.root, parsed.reactor, before)
    : [];
  const result = appendTestSummaries(executed, summaries);
  const timedOut = result.timedOut ? [result.command] : [];
  // A fresh report recording failures outranks a green exit: surefire's
  // `testFailureIgnore` (or `-Dmaven.test.failure.ignore`) lets `mvn test`
  // exit 0 over failing tests, and the verdict must read the evidence.
  const freshFailures = hasFreshTestFailure(summaries);
  // A zero exit is not a pass when Maven's own framing records errors it did
  // not fail on: a repo (or the PR itself) shipping `.mvn/maven.config` with
  // `-fn`/`--fail-never` makes Maven exit 0 over compilation, dependency
  // resolution, AND launch-class failures (a mid-command ENOSPC), and none
  // of those writes Surefire XML for `freshFailures` to see. Read the
  // output, or the run verifies nothing while reporting green.
  const swallowedFailure =
    result.exitCode === 0 &&
    !result.timedOut &&
    !freshFailures &&
    (isSourceFailure(result.output) ||
      isDependencyFailure(result.output) ||
      isLaunchFailure(result.output));
  const ok =
    result.exitCode === 0 &&
    !result.timedOut &&
    !freshFailures &&
    !swallowedFailure;
  // Every carve-out carries a diff-inputs exception: when the PR changed
  // the wrapper or the dependency inputs, the failure may be the diff's own
  // doing and must not be laundered into an environmental result.
  const acquisitionFailure =
    !ok &&
    !freshFailures &&
    !isSourceFailure(result.output) &&
    result.exitCode !== null &&
    ((isLaunchFailure(result.output) &&
      !executedWrapperChanged &&
      // maven-wrapper.properties feeds mvnw.cmd exactly as it feeds ./mvnw:
      // when the executed wrapper fell back to system `mvn` (no win32
      // wrapper in the tree), a config the diff changed is still suspect.
      !wrapperConfigChanged &&
      !(executable === 'mvn' && platformWrapperChanged)) ||
      (isDependencyFailure(result.output) && !dependencyInputsChanged) ||
      (executable === './mvnw' &&
        !executedWrapperChanged &&
        (result.exitCode === 126 || result.exitCode === 127) &&
        WRAPPER_LAUNCH_FAILURE_RE.test(result.output)));
  const recorded = acquisitionFailure
    ? { ...result, infrastructure: true }
    : swallowedFailure
      ? { ...result, swallowedFailure: true }
      : result;
  const report = mavenReport({
    affected,
    buildSet,
    widenedWith: [],
    install,
    build: args.buildOnly ? [recorded] : [],
    test: args.buildOnly ? [] : [recorded],
    ok,
    timedOut,
    note: '',
  });

  if ((result.timedOut || result.exitCode === null) && freshFailures) {
    // A deadline kill or spawn death does not retroactively excuse the test
    // failures Surefire/Failsafe already recorded: name the interruption as
    // infrastructure, but keep the captured regressions as test evidence.
    const totals = summaryTotals(summaries);
    const cause = result.timedOut
      ? `ran out of time (${deadlineSecs(result)}s)`
      : 'ended without an exit code (a spawn failure or signal outside the deadline)';
    report.note =
      `\`${result.command}\` ${cause} — that part is infrastructure. But fresh ` +
      `Surefire/Failsafe reports written before it record ${totals.failures} ` +
      `failure(s) and ${totals.errors} error(s): treat those as test failures, ` +
      'not as a pass or as purely environmental.';
  } else if (result.timedOut) {
    report.note =
      `\`${result.command}\` ran out of time (${deadlineSecs(result)}s). This is an infrastructure result, ` +
      'not a defect in the diff — report it as informational.';
    if (selectorOverflow) {
      report.note +=
        ' The scope widened to reactor-wide because the changed-module `-pl` selector exceeded ' +
        `${MAX_SELECTOR_CHARS} characters; on large reactors that scope usually cannot finish ` +
        'within this deadline, so re-running it at the same scope will spend the same budget ' +
        'for the same result.';
    } else if (reactorWide) {
      report.note +=
        ' The scope is reactor-wide because the diff changes inputs every module inherits; ' +
        'on large reactors that scope usually cannot finish within this deadline, so re-running ' +
        'it at the same scope will spend the same budget for the same result.';
    }
  } else if (result.exitCode === null) {
    // A spawn-level death (output past maxBuffer, an outside signal) leaves no
    // exit code and nothing to correlate — infrastructure, like a timeout.
    report.note =
      `\`${result.command}\` ended without an exit code (a spawn failure or signal outside the deadline). ` +
      'This is infrastructure evidence, not a source finding.';
  } else if (acquisitionFailure) {
    report.note =
      `\`${result.command}\` failed while acquiring or starting Maven, Java, plugins, or dependencies` +
      (result.exitCode === 0
        ? ' — a fail-never setting masked the failure with exit 0'
        : '') +
      '. This is infrastructure evidence, not a source finding.';
  } else if (!ok && result.exitCode === 0 && freshFailures) {
    const totals = summaryTotals(summaries);
    report.note =
      `\`${result.command}\` exited 0 but fresh Surefire/Failsafe reports record ` +
      `${totals.failures} failure(s) and ${totals.errors} error(s) — a testFailureIgnore-style ` +
      'setting is swallowing them. Treat these as test failures, not a pass.';
  } else if (!ok && result.exitCode === 0) {
    report.note =
      `\`${result.command}\` exited 0 but its output records failures Maven did not fail on — ` +
      'a fail-never setting (e.g. `-fn`/`--fail-never` in `.mvn/maven.config`) is swallowing ' +
      'them. Treat this as a failed run, not a pass.';
  } else if (!ok) {
    report.note =
      `\`${result.command}\` failed. Correlate compiler or test errors with the changed files; ` +
      'fresh module-qualified Surefire/Failsafe summaries are appended when available.';
  } else if (args.buildOnly) {
    report.note =
      `Maven compiled ${reactorWide ? 'the full reactor' : ownership.modules.join(', ')}. ` +
      'Tests were not run (build-only).';
  } else if (summaries.length === 0) {
    report.note =
      `Maven tested ${reactorWide ? 'the full reactor' : ownership.modules.join(', ')} successfully, ` +
      'but produced no fresh Surefire/Failsafe XML (reports written to a non-default directory are not seen here), ' +
      'so test-count evidence is unavailable.';
  } else {
    const totals = summaryTotals(summaries);
    report.note =
      `Maven test passed with fresh reports: ${totals.tests} tests, ${totals.failures} failures, ` +
      `${totals.errors} errors, ${totals.skipped} skipped across ${summaries.length} report(s).`;
  }
  if (!reactorWide) {
    report.note +=
      ' Scope: this run covered the changed modules and their upstream dependencies only ' +
      '(`-pl … -am`); downstream dependents were NOT built — a POM or API change can break ' +
      "modules this run never compiled, and that coverage stays with the project's CI.";
  } else if (selectorOverflow) {
    report.note +=
      ` Scope: the changed-module \`-pl\` selector exceeded ${MAX_SELECTOR_CHARS} characters — ` +
      'a command line platforms may refuse to launch — so this run covered the full reactor ' +
      'instead of the changed modules and their upstream dependencies.';
  }
  if (install && (install.timedOut || install.exitCode !== 0)) {
    report.note +=
      ` ${warmUpOutcome(install, deadlineSecs(install))} — it is best-effort, and the ` +
      'lifecycle outcome above stands on its own.';
  }
  if (wrapperChanged && !executedWrapperChanged) {
    report.note +=
      executable === 'mvn'
        ? ' Note: the diff changes the Maven wrapper, but this run used the system ' +
          '`mvn` instead of it, so the wrapper change itself was not exercised.'
        : ` Note: the diff changes the Maven wrapper, but this run executed \`${executable}\`, ` +
          'so the wrapper change itself was not exercised.';
  }
  return report;
}

export const mavenToolchainAdapter: ReviewToolchainAdapter = {
  applies: (root) => existsSync(join(root, 'pom.xml')),
  run: runMavenToolchain,
};
