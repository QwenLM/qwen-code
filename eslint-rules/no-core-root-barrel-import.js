/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * @fileoverview Prevents core production modules from importing the core root barrel.
 */

import path from 'node:path';

const TEST_OR_FIXTURE_SEGMENTS = new Set(['__tests__', 'fixtures']);
const CORE_SRC_MARKER = 'packages/core/src/';

function isCoreProductionFile(filename) {
  if (!filename || filename === '<input>' || filename === '<text>')
    return false;
  const normalized = path.normalize(filename).replaceAll('\\', '/');
  const start = normalized.lastIndexOf(CORE_SRC_MARKER);
  if (start < 0) return false;
  const relativePath = normalized.slice(start + CORE_SRC_MARKER.length);
  const segments = relativePath.split('/');
  return (
    !segments.some((segment) => TEST_OR_FIXTURE_SEGMENTS.has(segment)) &&
    !/\.(test|spec)\.[cm]?[jt]sx?$/.test(relativePath)
  );
}

const CORE_PACKAGE_SPECIFIER = '@qwen-code/qwen-code-core';
// The package exports map ("./*", "./src/*", "./dist/*") also exposes the root
// barrel through these self-reference subpaths.
const CORE_BARREL_SPECIFIERS = new Set([
  CORE_PACKAGE_SPECIFIER,
  `${CORE_PACKAGE_SPECIFIER}/index.js`,
  `${CORE_PACKAGE_SPECIFIER}/src/index.js`,
  `${CORE_PACKAGE_SPECIFIER}/src/index.ts`,
  `${CORE_PACKAGE_SPECIFIER}/dist/index.js`,
]);

function resolvesToCoreRootBarrel(filename, importedPath) {
  if (CORE_BARREL_SPECIFIERS.has(importedPath)) return true;
  if (!importedPath.startsWith('.')) return false;
  const normalized = path.normalize(filename).replaceAll('\\', '/');
  const sourceRoot = path.resolve(
    normalized.slice(
      0,
      normalized.lastIndexOf(CORE_SRC_MARKER) + CORE_SRC_MARKER.length,
    ),
  );
  const resolvedImport = path.resolve(path.dirname(filename), importedPath);
  const relativeToSource = path
    .relative(sourceRoot, resolvedImport)
    .replaceAll('\\', '/');
  return (
    relativeToSource === 'index.js' ||
    relativeToSource === 'index.ts' ||
    relativeToSource === '../index.js' ||
    relativeToSource === '../index.ts' ||
    relativeToSource === '../dist/index.js'
  );
}

export default {
  meta: {
    type: 'problem',
    docs: {
      description:
        'Disallow core production modules from importing the core root barrel.',
    },
    schema: [],
    messages: {
      noCoreRootBarrelImport:
        'Core production modules must import symbols from their direct owner modules, not the core root barrel.',
    },
  },

  create(context) {
    const filename = context.filename;
    if (!isCoreProductionFile(filename)) {
      return {};
    }

    function reportIfBarrel(sourceNode, importedPath) {
      if (
        typeof importedPath === 'string' &&
        resolvesToCoreRootBarrel(filename, importedPath)
      ) {
        context.report({
          node: sourceNode,
          messageId: 'noCoreRootBarrelImport',
        });
      }
    }

    function checkSource(node) {
      if (node.source && typeof node.source.value === 'string') {
        reportIfBarrel(node.source, node.source.value);
      }
    }

    function checkDynamicImport(node) {
      const source = node.source;
      if (source.type === 'Literal') {
        reportIfBarrel(source, source.value);
      } else if (
        source.type === 'TemplateLiteral' &&
        source.quasis.length === 1
      ) {
        reportIfBarrel(source, source.quasis[0].value.cooked);
      }
    }

    // Inline type imports (`type X = import('../index.js').X;`) parse as
    // TSImportType under typescript-eslint, not as ImportDeclaration.
    function checkTSImportType(node) {
      const argument = node.argument;
      if (
        argument &&
        argument.type === 'TSLiteralType' &&
        argument.literal &&
        typeof argument.literal.value === 'string'
      ) {
        reportIfBarrel(argument.literal, argument.literal.value);
      }
    }

    return {
      ImportDeclaration: checkSource,
      ExportNamedDeclaration: checkSource,
      ExportAllDeclaration: checkSource,
      ImportExpression: checkDynamicImport,
      TSImportType: checkTSImportType,
    };
  },
};
