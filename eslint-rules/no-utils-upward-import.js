/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import path from 'node:path';

/**
 * `packages/cli/src/utils/` is the leaf layer that every other directory
 * imports. It must not import back up into a domain directory (`config/`,
 * `ui/`, `i18n/`, `nonInteractive/`, `commands/`, `serve/`,
 * `acp-integration/`, ...): that is the dependency-direction invariant
 * tracked in #9146.
 *
 * The only permitted "upward" references are the type-only constructs that
 * are genuinely erased at compile time: statement-level `import type`,
 * `export type ... from`, and TS `import('...').T` type queries. Inline type
 * specifiers (`import { type X } from` / `export { type X } from`) are
 * reported instead: under this repo's `verbatimModuleSyntax`, tsc keeps the
 * declaration and emits `import {} from` / `export {} from`, a runtime edge
 * that still evaluates the target module. Everything else (value imports,
 * value re-exports, literal/template dynamic `import()`) is reported too. The
 * two remaining instances (`Settings` in `modelConfigUtils.ts`,
 * `CommandContext` in `sessionPaths.ts`) are this irreducible type-level
 * coupling.
 */

const CLI_UTILS_MARKER = 'packages/cli/src/utils/';
const TEST_OR_FIXTURE_SEGMENTS = new Set(['__tests__', 'fixtures']);

function isCliUtilsProductionFile(filename) {
  if (!filename || filename === '<input>' || filename === '<text>') {
    return false;
  }
  const normalized = path.normalize(filename).replaceAll('\\', '/');
  const start = normalized.lastIndexOf(CLI_UTILS_MARKER);
  if (start < 0) {
    return false;
  }
  const relativePath = normalized.slice(start + CLI_UTILS_MARKER.length);
  if (/\.(test|spec)\.[cm]?[jt]sx?$/.test(relativePath)) {
    return false;
  }
  return !relativePath.split('/').some((s) => TEST_OR_FIXTURE_SEGMENTS.has(s));
}

function escapesUtils(filename, importedPath) {
  const normalized = path.normalize(filename).replaceAll('\\', '/');
  const utilsRoot = normalized.slice(
    0,
    normalized.lastIndexOf(CLI_UTILS_MARKER) + CLI_UTILS_MARKER.length,
  );
  const resolved = path.resolve(path.dirname(filename), importedPath);
  return path
    .relative(utilsRoot, resolved)
    .replaceAll('\\', '/')
    .startsWith('..');
}

export default {
  meta: {
    type: 'problem',
    docs: {
      description:
        'packages/cli/src/utils must not import outside utils/ (leaf-layer dependency direction).',
    },
    messages: {
      noUtilsUpwardImport:
        'packages/cli/src/utils must not import outside utils/. ' +
        'Invert the dependency (pass the value in) or move the module to the ' +
        'domain directory that owns it (#9146).',
    },
  },
  create(context) {
    const { filename } = context;
    if (!isCliUtilsProductionFile(filename)) {
      return {};
    }

    const reportIfEscaping = (sourceNode, importedPath) => {
      if (
        typeof importedPath === 'string' &&
        importedPath.startsWith('.') &&
        escapesUtils(filename, importedPath)
      ) {
        context.report({ node: sourceNode, messageId: 'noUtilsUpwardImport' });
      }
    };

    const checkStatic = (node) => {
      // Statement-level type-only imports (`import type`, `export type ...
      // from`) are erased at compile time and cannot create a runtime cycle.
      // Inline type specifiers (`import { type X } from ...`) are NOT exempt:
      // under this repo's `verbatimModuleSyntax`, tsc keeps the declaration
      // and emits `import {} from ...` / `export {} from ...`, a runtime edge
      // that evaluates the target module — so they are reported like value
      // imports.
      if (node.importKind === 'type' || node.exportKind === 'type') {
        return;
      }
      reportIfEscaping(node.source, node.source?.value);
    };

    const checkDynamic = (node) => {
      const { source } = node;
      if (source.type === 'Literal') {
        reportIfEscaping(source, source.value);
      } else if (
        source.type === 'TemplateLiteral' &&
        source.quasis.length === 1
      ) {
        reportIfEscaping(source, source.quasis[0].value.cooked);
      }
    };

    return {
      ImportDeclaration: checkStatic,
      ExportNamedDeclaration: checkStatic,
      ExportAllDeclaration: checkStatic,
      ImportExpression: checkDynamic,
      // TSImportType (`import('../config/x').T`) is type-only by definition, so
      // it is intentionally not reported.
    };
  },
};
