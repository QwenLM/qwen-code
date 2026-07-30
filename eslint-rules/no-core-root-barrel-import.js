/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * @fileoverview Prevents core production modules from importing the core root barrel.
 */

import path from 'node:path';

const CORE_SOURCE_ROOT = path.join('packages', 'core', 'src');
const TEST_OR_FIXTURE_SEGMENTS = new Set(['__tests__', 'fixtures']);

function isCoreProductionFile(filename) {
  if (!filename || filename === '<input>' || filename === '<text>') return false;
  const normalized = path.normalize(filename).replaceAll('\\', '/');
  const marker = 'packages/core/src/';
  const start = normalized.indexOf(marker);
  if (start < 0) return false;
  const relativePath = normalized.slice(start + marker.length);
  const segments = relativePath.split('/');
  return !segments.some((segment) => TEST_OR_FIXTURE_SEGMENTS.has(segment)) &&
    !/\.test\.[cm]?[jt]sx?$/.test(relativePath);
}

function resolvesToCoreRootBarrel(filename, importedPath) {
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

    return {
      ImportDeclaration(node) {
        if (resolvesToCoreRootBarrel(filename, node.source.value)) {
          context.report({ node: node.source, messageId: 'noCoreRootBarrelImport' });
        }
      },
    };
  },
};
