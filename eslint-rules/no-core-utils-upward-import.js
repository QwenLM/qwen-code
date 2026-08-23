/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * @fileoverview Disallows runtime (value) imports from `packages/core/src/utils/`
 * production modules into modules outside the utils/ directory. Type-only
 * imports are permitted because they are erased at compile time and therefore
 * introduce no runtime upward dependency.
 *
 * The goal is a leaf utils/ layer: every runtime dependency of a utils module
 * must be a sibling utils module (or an external/npm package). A small
 * allowlist carries the deferred inversions that cannot be leafed without a
 * larger refactor (`Storage` and `getTraceContext` are stateful and live
 * behind `debugLogger`).
 */

import path from 'node:path';

const CORE_SRC_MARKER = 'packages/core/src/';
const UTILS_SRC_MARKER = 'packages/core/src/utils/';

// Deferred inversions. Each entry is the import target relative to
// packages/core/src, without its extension. See the file header for why these
// are tolerated rather than moved.
const ALLOWED_UPWARD_TARGETS = new Set([
  'config/storage',
  'telemetry/trace-context',
]);

function isUtilsProductionFile(filename) {
  if (!filename || filename === '<input>' || filename === '<text>') {
    return false;
  }
  const normalized = path.normalize(filename).replaceAll('\\', '/');
  const start = normalized.lastIndexOf(UTILS_SRC_MARKER);
  if (start < 0) return false;
  const relativePath = normalized.slice(start + UTILS_SRC_MARKER.length);
  return !/\.(test|spec)\.[cm]?[jt]sx?$/.test(relativePath);
}

function coreSrcAbs(filename) {
  const normalized = path.normalize(filename).replaceAll('\\', '/');
  const start = normalized.lastIndexOf(CORE_SRC_MARKER);
  if (start < 0) return null;
  return path.resolve(normalized.slice(0, start + CORE_SRC_MARKER.length));
}

function stripExtension(rel) {
  return rel.replace(/\.(js|ts|tsx|mjs|cjs)$/, '');
}

export default {
  meta: {
    type: 'problem',
    docs: {
      description: 'Disallow runtime upward imports from core utils modules.',
    },
    schema: [],
    messages: {
      noCoreUtilsUpwardImport:
        "Core utils module '{{file}}' imports runtime value '{{importedPath}}' from outside utils/. Move the value into utils/ (or re-export it from its owner module) so utils/ stays a leaf layer. Type-only imports are allowed.",
    },
  },

  create(context) {
    const filename = context.filename;
    if (!isUtilsProductionFile(filename)) {
      return {};
    }

    const srcRoot = coreSrcAbs(filename);
    if (!srcRoot) {
      return {};
    }
    const utilsRoot = path.join(srcRoot, 'utils');

    function reportIfUpward(sourceNode, importedPath) {
      if (typeof importedPath !== 'string' || !importedPath.startsWith('.')) {
        return;
      }
      const resolved = path.resolve(path.dirname(filename), importedPath);

      // Leave cross-package relative imports to no-relative-cross-package-imports.
      const relToCore = path.relative(srcRoot, resolved).replaceAll('\\', '/');
      if (relToCore.startsWith('..') || path.isAbsolute(relToCore)) {
        return;
      }

      if (ALLOWED_UPWARD_TARGETS.has(stripExtension(relToCore))) {
        return;
      }

      const relToUtils = path.relative(utilsRoot, resolved);
      if (relToUtils.startsWith('..') || path.isAbsolute(relToUtils)) {
        context.report({
          node: sourceNode,
          messageId: 'noCoreUtilsUpwardImport',
          data: {
            file: path.relative(utilsRoot, filename),
            importedPath,
          },
        });
      }
    }

    function checkSource(node) {
      if (node.source && typeof node.source.value === 'string') {
        reportIfUpward(node.source, node.source.value);
      }
    }

    function checkDynamicImport(node) {
      const source = node.source;
      if (source.type === 'Literal') {
        reportIfUpward(source, source.value);
      } else if (
        source.type === 'TemplateLiteral' &&
        source.quasis.length === 1
      ) {
        reportIfUpward(source, source.quasis[0].value.cooked);
      }
    }

    return {
      ImportDeclaration(node) {
        if (node.importKind === 'type') return;
        checkSource(node);
      },
      ExportNamedDeclaration(node) {
        if (node.exportKind === 'type') return;
        checkSource(node);
      },
      ExportAllDeclaration(node) {
        if (node.exportKind === 'type') return;
        checkSource(node);
      },
      ImportExpression: checkDynamicImport,
    };
  },
};
