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
 * silently shrinking it, and any symlink fails it too, because a file
 * reached through a link resolves relative imports from the link's
 * lexical location, not the target's physical one, so no link can be
 * trusted to keep resolution inside the rule root).
 *
 * Detection parses each file with the TypeScript compiler (already a repo
 * devDependency) and walks ImportDeclaration / ExportDeclaration / dynamic
 * import() / require() / vi.mock() / import-type (type X = import("..."))
 * nodes, accepting string literals and interpolation-free template
 * literals as specifiers, so comments, strings, regex literals and
 * interpolated templates cannot mask or fake an import.
 */

import { readdirSync, readFileSync, realpathSync } from 'node:fs';
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
 * is trust must not shrink silently: unlistable directories are collected as
 * diagnostics for the caller to fail on.
 *
 * Symlinks fail closed. `checkRule` resolves a file's relative imports from
 * the path the file was reached at, but a symlink's bytes live wherever the
 * link points — so resolution from the link's lexical path can report an
 * escape that physically stays in the root, or (worse) pass an import that
 * physically escapes. Neither direction is auditable link-by-link, and the
 * tree commits no symlinks, so any symlink is reported and fails the gate.
 * Because symlinks are never followed, traversal cannot cycle or leave the
 * root.
 */
function listSourceFiles(root) {
  const files = [];
  const unreadableDirs = [];
  const symlinks = [];
  const walk = (dir) => {
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
        symlinks.push(full);
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
  return { files: files.sort(), unreadableDirs, symlinks };
}

/**
 * Extract import specifiers via the TypeScript AST. Only statically
 * knowable specifiers are reportable: string literals and
 * interpolation-free template literals (which the runtime treats
 * identically as module names); computed or interpolated ones (e.g.
 * `import(variable)`) are skipped because no static specifier exists to
 * classify. Import-type queries (`type X = import("...").Y`) count too —
 * they still record a static framework dependency at the type level.
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

  // Specifiers a call/import can statically name: quoted literals plus
  // template literals without `${}` interpolation (isStringLiteral rejects
  // those, but they resolve to the same module name).
  const staticSpecifier = (node) =>
    node &&
    (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node))
      ? node.text
      : undefined;

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
    } else if (ts.isImportTypeNode(node)) {
      const argument = node.argument;
      const spec = ts.isLiteralTypeNode(argument)
        ? staticSpecifier(argument.literal)
        : undefined;
      if (spec !== undefined) {
        record('import-type', node, spec);
      }
    } else if (ts.isCallExpression(node)) {
      const spec = staticSpecifier(node.arguments[0]);
      if (
        node.expression.kind === ts.SyntaxKind.ImportKeyword &&
        spec !== undefined
      ) {
        record('dynamic-import', node, spec);
      } else if (
        ts.isIdentifier(node.expression) &&
        node.expression.text === 'require' &&
        spec !== undefined
      ) {
        record('require', node, spec);
      } else if (
        ts.isPropertyAccessExpression(node.expression) &&
        ts.isIdentifier(node.expression.expression) &&
        node.expression.expression.text === 'vi' &&
        node.expression.name.text === 'mock' &&
        spec !== undefined
      ) {
        record('vi.mock', node, spec);
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

function checkRule({ label, root, rules, enumeration }) {
  const { files, unreadableDirs, symlinks } =
    enumeration ?? listSourceFiles(root);
  let specifiers = 0;
  const violations = [];

  for (const file of files) {
    const source = readFileSync(file, 'utf8');
    for (const imp of findImports(source, file)) {
      specifiers++;
      // Paths are reported relative to the rule root, not the repo root:
      // slicing by repoRoot corrupts any root outside the checkout, which
      // is how the unit tests exercise this function.
      const rel = `${file.slice(root.length + 1)}:${imp.line}`;
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
    symlinks,
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
  const enumeration = listSourceFiles(root);
  if (enumeration.files.length === 0) {
    stdout.write(`error: ${label} (${root}) not found or has no source files`);
    stdout.write('\n');
    exit(1);
  }
  return enumeration;
}

function main() {
  // Enumerate once per rule root so diagnostics (unlistable directories,
  // symlinks) are attributed to the same rule block as the scan.
  const coreEnumeration = requirePopulatedRoot(CORE_SRC, 'packages/core/src');
  const uiModelEnumeration = requirePopulatedRoot(
    UI_MODEL,
    'packages/cli/src/ui/model',
  );

  stdout.write(
    'TUI dependency-direction check (OpenTUI migration Phase 0)\n\n',
  );

  const results = [
    checkRule({
      label: 'packages/core/src — framework-neutral business core',
      root: CORE_SRC,
      rules: { noFramework: true, noRelativeIntoCli: true },
      enumeration: coreEnumeration,
    }),
    checkRule({
      label: 'packages/cli/src/ui/model — framework-neutral streaming state',
      root: UI_MODEL,
      rules: { noFramework: true, selfContained: true },
      enumeration: uiModelEnumeration,
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
    for (const link of result.symlinks) {
      stdout.write(`error: symlink in scanned tree (not followed): ${link}\n`);
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
