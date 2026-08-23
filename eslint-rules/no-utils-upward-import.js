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
 * value re-exports, dynamic `import()`) is reported too: a literal or
 * single-segment template source is checked against its resolved path, and a
 * computed source (a multi-segment template or a `+` concatenation) whose
 * statically known prefix is relative is reported fail-closed, because
 * interpolation can contribute a `../` step no static check can rule out. A
 * computed source with no statically known relative prefix is dropped, the
 * same boundary applied to non-relative static specifiers. The two remaining
 * instances (`Settings` in `modelConfigUtils.ts`, `CommandContext` in
 * `sessionPaths.ts`) are this irreducible type-level coupling.
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

/**
 * The statically known leading characters of a computed dynamic-import
 * source: the first quasi of a template literal, the string literal itself,
 * or the leftmost operand of a `+` concatenation. Anything else (a bare
 * identifier, a call, an empty first quasi) has no statically known prefix.
 */
function knownDynamicPrefix(node) {
  if (node.type === 'Literal') {
    return typeof node.value === 'string' ? node.value : null;
  }
  if (node.type === 'TemplateLiteral') {
    return node.quasis[0].value.cooked;
  }
  if (node.type === 'BinaryExpression' && node.operator === '+') {
    return knownDynamicPrefix(node.left);
  }
  return null;
}

/** Whether a known prefix spells a relative specifier (`./`, `../`, `.`, `..`). */
function isRelativePrefix(prefix) {
  return (
    prefix === '.' ||
    prefix === '..' ||
    prefix.startsWith('./') ||
    prefix.startsWith('../')
  );
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
      noUtilsUnprovableDynamicImport:
        'packages/cli/src/utils cannot statically prove this computed ' +
        'dynamic import() stays inside utils/ — interpolation can ' +
        'contribute a `../` step. Resolve the target through a literal or ' +
        'single-segment template source, or pass the module in (#9146).',
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
        return;
      }
      if (source.type === 'TemplateLiteral' && source.quasis.length === 1) {
        reportIfEscaping(source, source.quasis[0].value.cooked);
        return;
      }
      // Computed sources — multi-segment templates and `+` concatenations —
      // fail closed when their statically known prefix is relative:
      // interpolation can contribute a `../` step, so no static check can
      // prove the import stays inside utils/ (a leading `../` cannot be
      // undone by interpolation at all). A computed source with no known
      // relative prefix — a bare identifier, a package-like prefix — is
      // dropped, the same boundary applied to non-relative static
      // specifiers.
      const prefix = knownDynamicPrefix(source);
      if (typeof prefix === 'string' && isRelativePrefix(prefix)) {
        context.report({
          node: source,
          messageId: 'noUtilsUnprovableDynamicImport',
        });
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
