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

function isCoreProductionFile(filename) {
  if (!filename || filename === '<input>' || filename === '<text>')
    return false;
  const normalized = path.normalize(filename).replaceAll('\\', '/');
  const marker = 'packages/core/src/';
  const start = normalized.indexOf(marker);
  if (start < 0) return false;
  const relativePath = normalized.slice(start + marker.length);
  const segments = relativePath.split('/');
  return (
    !segments.some((segment) => TEST_OR_FIXTURE_SEGMENTS.has(segment)) &&
    !/\.test\.[cm]?[jt]sx?$/.test(relativePath)
  );
}

const CORE_PACKAGE_SPECIFIER = '@qwen-code/qwen-code-core';

function resolvesToCoreRootBarrel(filename, importedPath) {
  if (importedPath === CORE_PACKAGE_SPECIFIER) return true;
  if (!importedPath.startsWith('.')) return false;
  const normalized = path.normalize(filename).replaceAll('\\', '/');
  const marker = 'packages/core/src/';
  const sourceRoot = path.resolve(
    normalized.slice(0, normalized.indexOf(marker) + marker.length),
  );
  const resolvedImport = path.resolve(path.dirname(filename), importedPath);
  const relativeToSource = path.relative(sourceRoot, resolvedImport);
  return relativeToSource === 'index.js' || relativeToSource === 'index.ts';
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
        'Core production modules must import symbols from their direct owner modules, not ../index.js.',
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

    return {
      ImportDeclaration: checkSource,
      ExportNamedDeclaration: checkSource,
      ExportAllDeclaration: checkSource,
      ImportExpression: checkDynamicImport,
    };
  },
};
