#!/usr/bin/env node
/**
 * Dependency-direction architecture check for the OpenTUI migration
 * (tracking QwenLM/qwen-code#8662).
 *
 * Rules:
 *   1. packages/core/src must stay framework-neutral — no imports of ink,
 *      react, solid, or @opentui/*, and no relative imports that reach
 *      into packages/cli.
 *   2. packages/cli/src/ui/model (framework-neutral streaming state) must
 *      not import react, solid, ink, or @opentui/* either, and must be
 *      self-contained — no relative import may resolve outside the
 *      directory, so no framework-dependent sibling can leak in through a
 *      relative path.
 *
 * Usage:  node scripts/check-tui-dep-direction.mjs
 * Exit 0 = all rules hold; exit 1 = violations found (or the scan itself
 * was incomplete — unlistable directories fail the gate instead of
 * silently shrinking it; symlinks are followed, not skipped).
 *
 * Detection parses each file with the TypeScript compiler (already a repo
 * devDependency) and walks ImportDeclaration / ExportDeclaration / dynamic
 * import() / require() / vi.mock() nodes, so comments, strings, regex
 * literals and template interpolations cannot mask or fake an import.
 */

import { readdirSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { dirname, extname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { exit, stdout } from 'node:process';
import ts from 'typescript';

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const CORE_SRC = join(repoRoot, 'packages', 'core', 'src');
const UI_MODEL = join(repoRoot, 'packages', 'cli', 'src', 'ui', 'model');
const CLI_PACKAGE = join(repoRoot, 'packages', 'cli');

const SOURCE_EXTENSIONS = new Set([
  '.ts',
  '.tsx',
  '.js',
  '.jsx',
  '.mjs',
  '.cjs',
  '.mts',
  '.cts',
]);
const SKIP_DIRS = new Set(['node_modules', 'dist', '.git']);

/**
 * Walk a directory tree collecting source files. A gate whose only product
 * is trust must not shrink silently: symlinked entries are followed (with a
 * realpath visited-set guarding cycles, so a committed symlink cannot evade
 * the rules) and unlistable directories are collected as diagnostics for
 * the caller to fail on.
 */
function listSourceFiles(root) {
  const files = [];
  const unreadableDirs = [];
  const visitedDirs = new Set();
  const walk = (dir) => {
    let realDir;
    try {
      realDir = realpathSync(dir);
    } catch (error) {
      unreadableDirs.push(`${dir} (${error.message})`);
      return;
    }
    if (visitedDirs.has(realDir)) return;
    visitedDirs.add(realDir);
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch (error) {
      unreadableDirs.push(`${dir} (${error.message})`);
      return;
    }
    for (const entry of entries) {
      const full = join(dir, entry.name);
      if (entry.isSymbolicLink()) {
        // The target may be a file, a directory, or dangling; stat it so a
        // committed symlink cannot evade either rule.
        let stats;
        try {
          stats = statSync(full);
        } catch (error) {
          unreadableDirs.push(`${full} (${error.message})`);
          continue;
        }
        if (stats.isDirectory()) {
          if (!SKIP_DIRS.has(entry.name)) walk(full);
        } else if (
          stats.isFile() &&
          SOURCE_EXTENSIONS.has(extname(entry.name))
        ) {
          files.push(full);
        }
        continue;
      }
      if (entry.isDirectory()) {
        if (!SKIP_DIRS.has(entry.name)) walk(full);
      } else if (entry.isFile() && SOURCE_EXTENSIONS.has(extname(entry.name))) {
        files.push(full);
      }
    }
  };
  walk(root);
  return { files: files.sort(), unreadableDirs };
}

/**
 * Extract import specifiers via the TypeScript AST. Only string-literal
 * specifiers are reportable; computed ones (e.g. `import(variable)`) are
 * skipped because no static specifier exists to classify.
 */
function findImports(source, fileName = 'module.ts') {
  const sourceFile = ts.createSourceFile(
    fileName,
    source,
    ts.ScriptTarget.Latest,
    /* setParentNodes */ true,
  );
  const found = [];

  const lineOf = (node) =>
    sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile)).line +
    1;
  const record = (kind, node, specifier) => {
    found.push({ kind, spec: specifier, line: lineOf(node) });
  };

  const visit = (node) => {
    if (
      ts.isImportDeclaration(node) &&
      ts.isStringLiteral(node.moduleSpecifier)
    ) {
      record('import', node, node.moduleSpecifier.text);
    } else if (
      ts.isExportDeclaration(node) &&
      node.moduleSpecifier &&
      ts.isStringLiteral(node.moduleSpecifier)
    ) {
      record('export-from', node, node.moduleSpecifier.text);
    } else if (ts.isCallExpression(node)) {
      const [firstArg] = node.arguments;
      if (
        node.expression.kind === ts.SyntaxKind.ImportKeyword &&
        firstArg &&
        ts.isStringLiteral(firstArg)
      ) {
        record('dynamic-import', node, firstArg.text);
      } else if (
        ts.isIdentifier(node.expression) &&
        node.expression.text === 'require' &&
        firstArg &&
        ts.isStringLiteral(firstArg)
      ) {
        record('require', node, firstArg.text);
      } else if (
        ts.isPropertyAccessExpression(node.expression) &&
        ts.isIdentifier(node.expression.expression) &&
        node.expression.expression.text === 'vi' &&
        node.expression.name.text === 'mock' &&
        firstArg &&
        ts.isStringLiteral(firstArg)
      ) {
        record('vi.mock', node, firstArg.text);
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return found.sort((a, b) => a.line - b.line);
}

/**
 * Classify a specifier into a banned framework family, treating each
 * framework as its whole ecosystem (ink/react/solid prefixes and scoped
 * ecosystem packages), matching how the migration isolates renderers.
 */
function bannedFamily(spec) {
  if (
    spec === 'ink' ||
    spec.startsWith('ink/') ||
    spec.startsWith('ink-') ||
    spec.startsWith('@inkjs/')
  ) {
    return 'ink';
  }
  if (
    spec === 'react' ||
    spec.startsWith('react/') ||
    spec.startsWith('react-')
  ) {
    return 'react';
  }
  if (
    spec === 'solid-js' ||
    spec.startsWith('solid-js/') ||
    spec.startsWith('solid-') ||
    spec.startsWith('@solidjs/') ||
    spec.startsWith('@solid-') ||
    spec.startsWith('@solid/')
  ) {
    return 'solid';
  }
  if (spec.startsWith('@opentui/') || spec === '@opentui') {
    return '@opentui';
  }
  return null;
}

function checkRule({ label, root, rules }) {
  const { files, unreadableDirs } = listSourceFiles(root);
  let specifiers = 0;
  const violations = [];

  for (const file of files) {
    const source = readFileSync(file, 'utf8');
    for (const imp of findImports(source, file)) {
      specifiers++;
      const rel = `${file.slice(repoRoot.length + 1)}:${imp.line}`;
      if (rules.noFramework) {
        const family = bannedFamily(imp.spec);
        if (family) {
          violations.push(
            `  ${rel}  ${imp.kind} '${imp.spec}'` +
              `  (${family} import in framework-neutral code)`,
          );
        }
      }
      if (imp.spec.startsWith('.')) {
        const resolved = resolve(dirname(file), imp.spec);
        if (
          rules.noRelativeIntoCli &&
          (resolved === CLI_PACKAGE || resolved.startsWith(CLI_PACKAGE + sep))
        ) {
          violations.push(
            `  ${rel}  ${imp.kind} '${imp.spec}'` +
              `  (relative import reaches into packages/cli)`,
          );
        }
        if (
          rules.selfContained &&
          resolved !== root &&
          !resolved.startsWith(root + sep)
        ) {
          violations.push(
            `  ${rel}  ${imp.kind} '${imp.spec}'` +
              `  (relative import escapes the framework-neutral directory)`,
          );
        }
      }
    }
  }

  return {
    label,
    scanned: files.length,
    specifiers,
    violations,
    unreadableDirs,
  };
}

function printRule(result) {
  stdout.write(`[rule] ${result.label}\n`);
  stdout.write(
    `  scanned ${result.scanned} files, ${result.specifiers} import specifiers\n`,
  );
  if (result.violations.length === 0) {
    stdout.write('  OK: no violations\n');
  } else {
    for (const violation of result.violations) {
      stdout.write(`${violation}\n`);
    }
  }
  stdout.write('\n');
}

function requirePopulatedRoot(root, label) {
  if (listSourceFiles(root).files.length === 0) {
    stdout.write(`error: ${label} (${root}) not found or has no source files`);
    stdout.write('\n');
    exit(1);
  }
}

function main() {
  requirePopulatedRoot(CORE_SRC, 'packages/core/src');
  requirePopulatedRoot(UI_MODEL, 'packages/cli/src/ui/model');

  stdout.write(
    'TUI dependency-direction check (OpenTUI migration Phase 0)\n\n',
  );

  const results = [
    checkRule({
      label: 'packages/core/src — framework-neutral business core',
      root: CORE_SRC,
      rules: { noFramework: true, noRelativeIntoCli: true },
    }),
    checkRule({
      label: 'packages/cli/src/ui/model — framework-neutral streaming state',
      root: UI_MODEL,
      rules: { noFramework: true, selfContained: true },
    }),
  ];

  let failed = false;
  for (const result of results) {
    printRule(result);
    failed ||= result.violations.length > 0;
    for (const dir of result.unreadableDirs) {
      stdout.write(`error: could not list directory: ${dir}\n`);
      failed = true;
    }
  }

  if (failed) {
    stdout.write('FAIL — dependency-direction violations found.\n');
    exit(1);
  }
  stdout.write('PASS — dependency direction holds.\n');
}

export { bannedFamily, checkRule, findImports, listSourceFiles };

if (
  process.argv[1] &&
  realpathSync(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  main();
}
