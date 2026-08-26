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
 *      not import react, solid, ink, or @opentui/* either, so any renderer
 *      binding can sit on top of it.
 *
 * Usage:  node scripts/check-tui-dep-direction.mjs
 * Exit 0 = all rules hold; exit 1 = violations found.
 *
 * Detection is a regex scan over comments/strings-masked source (static
 * imports, export-from, dynamic import(), require(), vi.mock()), not a full
 * parse — sufficient for dependency direction, deliberately dependency-free.
 */

import { readdirSync, readFileSync } from 'node:fs';
import { dirname, extname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { exit, stdout } from 'node:process';

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
]);
const SKIP_DIRS = new Set(['node_modules', 'dist', '.git']);

const IMPORT_PATTERNS = [
  {
    kind: 'import',
    re: /\bimport\s+(?:type\s+)?(?:[\s\S]*?\bfrom\s+)?(['"])([^'"\n]+)\1/g,
  },
  {
    kind: 'dynamic-import',
    re: /\bimport\s*\(\s*(['"])([^'"\n]+)\1\s*\)/g,
  },
  {
    kind: 'export-from',
    re: /\bexport\s+(?:\*|\{[\s\S]*?\})\s*from\s+(['"])([^'"\n]+)\1/g,
  },
  { kind: 'require', re: /\brequire\s*\(\s*(['"])([^'"\n]+)\1\s*\)/g },
  { kind: 'vi.mock', re: /\bvi\.mock\s*\(\s*(['"])([^'"\n]+)\1/g },
];

function listSourceFiles(root) {
  const files = [];
  const walk = (dir) => {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.isSymbolicLink()) continue;
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (!SKIP_DIRS.has(entry.name)) walk(full);
      } else if (entry.isFile() && SOURCE_EXTENSIONS.has(extname(entry.name))) {
        files.push(full);
      }
    }
  };
  walk(root);
  return files.sort();
}

/**
 * Mask comment and string-literal regions so "import" text inside fixture
 * strings is not mistaken for a real import. Template literals are masked
 * whole, including any ${} interpolation (imports cannot appear there).
 * Returns an array of [start, end) spans.
 */
function maskedSpans(source) {
  const spans = [];
  const n = source.length;
  let i = 0;
  while (i < n) {
    const ch = source[i];
    const next = source[i + 1];
    if (ch === '/' && next === '/') {
      const start = i;
      while (i < n && source[i] !== '\n') i++;
      spans.push([start, i]);
      continue;
    }
    if (ch === '/' && next === '*') {
      const start = i;
      i += 2;
      while (i < n && !(source[i] === '*' && source[i + 1] === '/')) i++;
      i = Math.min(n, i + 2);
      spans.push([start, i]);
      continue;
    }
    if (ch === "'" || ch === '"' || ch === '`') {
      const start = i;
      i++;
      while (i < n && source[i] !== ch) {
        if (source[i] === '\\') i++;
        i++;
      }
      i = Math.min(n, i + 1);
      spans.push([start, i]);
      continue;
    }
    i++;
  }
  return spans;
}

function isMasked(spans, index) {
  return spans.some(([start, end]) => index >= start && index < end);
}

function findImports(source) {
  const spans = maskedSpans(source);
  const found = [];
  for (const { kind, re } of IMPORT_PATTERNS) {
    re.lastIndex = 0;
    let match;
    while ((match = re.exec(source)) !== null) {
      if (isMasked(spans, match.index)) continue;
      const line = source.slice(0, match.index).split('\n').length;
      found.push({ kind, spec: match[2], line });
    }
  }
  return found.sort((a, b) => a.line - b.line);
}

function bannedFamily(spec) {
  if (spec === 'ink' || spec.startsWith('ink/') || spec.startsWith('ink-')) {
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
    spec.startsWith('@solidjs/')
  ) {
    return 'solid';
  }
  if (spec.startsWith('@opentui/') || spec === '@opentui') {
    return '@opentui';
  }
  return null;
}

function checkRule({ label, root, rules }) {
  stdout.write(`[rule] ${label}\n`);
  const files = listSourceFiles(root);
  let specifiers = 0;
  const violations = [];

  for (const file of files) {
    const source = readFileSync(file, 'utf8');
    for (const imp of findImports(source)) {
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
      if (rules.noRelativeIntoCli && imp.spec.startsWith('.')) {
        const resolved = resolve(dirname(file), imp.spec);
        if (
          resolved === CLI_PACKAGE ||
          resolved.startsWith(CLI_PACKAGE + sep)
        ) {
          violations.push(
            `  ${rel}  ${imp.kind} '${imp.spec}'` +
              `  (relative import reaches into packages/cli)`,
          );
        }
      }
    }
  }

  stdout.write(
    `  scanned ${files.length} files, ${specifiers} import specifiers\n`,
  );
  if (violations.length === 0) {
    stdout.write('  OK: no violations\n');
  } else {
    for (const violation of violations) stdout.write(`${violation}\n`);
  }
  stdout.write('\n');
  return violations;
}

function main() {
  let failed = false;

  if (listSourceFiles(CORE_SRC).length === 0) {
    stdout.write(`error: ${CORE_SRC} not found or empty\n`);
    exit(1);
  }

  stdout.write(
    'TUI dependency-direction check (OpenTUI migration Phase 0)\n\n',
  );

  const coreViolations = checkRule({
    label: 'packages/core/src — framework-neutral business core',
    root: CORE_SRC,
    rules: { noFramework: true, noRelativeIntoCli: true },
  });
  failed ||= coreViolations.length > 0;

  let modelViolations = [];
  if (listSourceFiles(UI_MODEL).length > 0) {
    modelViolations = checkRule({
      label: 'packages/cli/src/ui/model — framework-neutral streaming state',
      root: UI_MODEL,
      rules: { noFramework: true, noRelativeIntoCli: false },
    });
  } else {
    stdout.write(
      `[rule] packages/cli/src/ui/model — framework-neutral streaming state\n` +
        `  directory absent or has no source files; nothing to check\n\n`,
    );
  }
  failed ||= modelViolations.length > 0;

  if (failed) {
    stdout.write('FAIL — dependency-direction violations found.\n');
    exit(1);
  }
  stdout.write('PASS — dependency direction holds.\n');
}

export { bannedFamily, checkRule, findImports };

if (resolve(process.argv[1] ?? '') === fileURLToPath(import.meta.url)) {
  main();
}
