/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * @fileoverview Keeps the guarded CLI trees (runtime/, utils/,
 * acp-integration/) off `src/serve/` internals (#8084) by RESOLVING each
 * import-like specifier against the importing file instead of matching
 * specifier text.
 *
 * Why resolution, not text: eight review rounds each demonstrated a new
 * spelling that escaped the regex/glob matrix (data: URLs, percent-encoded
 * segments, traversal through a leading literal segment, baseUrl bare
 * specifiers, createRequire/getBuiltinModule, TSImportType, vitest call
 * APIs, Worker/fork). Every one of those is just a different way to NAME
 * the same target — resolving collapses them into one check: does the
 * specifier land inside `packages/cli/src/serve/`?
 *
 * Fail-closed posture: anything that cannot be resolved statically
 * (computed sources, `data:` URLs, `file:` URLs outside serve, absolute
 * paths, traversal-bearing bare specifiers, `node:module` imports,
 * `process.getBuiltinModule`) is rejected in a guarded tree, because a
 * guarded tree has no legitimate business importing code it cannot name —
 * none of those shapes occurs anywhere in the guarded trees today.
 *
 * Path comparison is case-insensitive: case-variant spellings
 * (`../../Serve/index.js`) load serve/ on case-insensitive filesystems, so
 * over-reporting them on case-sensitive ones is the safe direction.
 */
'use strict';

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/** Resolved inside the serve tree: exact dir or something beneath it. */
function isInServeDir(resolved, serveDir) {
  const r = resolved.toLowerCase();
  const s = serveDir.toLowerCase();
  return r === s || r.startsWith(s + path.sep.toLowerCase());
}

/** Strip ?query/#fragment — Node and bundlers drop them when resolving. */
function stripUrlSuffixes(specifier) {
  return specifier.split(/[?#]/)[0];
}

/** Decode percent-encoded segments (Node decodes when mapping to fs). */
function decodeSpecifier(specifier) {
  try {
    return decodeURIComponent(specifier);
  } catch {
    return undefined;
  }
}

function resolvePath(candidate) {
  const resolved = path.resolve(candidate);
  try {
    return fs.realpathSync.native(resolved);
  } catch {
    return resolved;
  }
}

/** Concatenate a static template literal; undefined if it has expressions. */
function staticTemplateValue(template) {
  if (template.expressions.length > 0) return undefined;
  return template.quasis.map((quasi) => quasi.value.cooked ?? '').join('');
}

export default {
  meta: {
    type: 'problem',
    docs: {
      description:
        'Disallow imports that resolve into src/serve/ from guarded trees.',
      category: 'Best Practices',
      recommended: 'error',
    },
    schema: [
      {
        type: 'object',
        properties: {
          /** Absolute path of the serve directory to protect. */
          serveDir: { type: 'string' },
          /** Absolute directory bare specifiers resolve against (baseUrl). */
          baseUrlDir: { type: 'string' },
        },
        additionalProperties: false,
      },
    ],
    messages: {
      serveBoundary:
        'This specifier resolves into src/serve/ internals, which the guarded trees must not reach (#8084). Route through a public boundary instead.',
      failClosed:
        'This import source cannot be resolved statically, so it cannot be checked against the serve/ boundary (#8084). Use a plain string-literal relative specifier.',
      moduleBuiltin:
        "Importing the 'module' builtin (or process.getBuiltinModule) in a guarded tree aliases require()/module access past the serve/ boundary (#8084). Import modules statically instead.",
    },
  },

  create(context) {
    const options = context.options[0] ?? {};
    const serveDir = options.serveDir;
    const baseUrlDir = options.baseUrlDir;
    const filename = context.filename ?? context.getFilename();
    const fileDir = path.dirname(path.resolve(filename));

    if (!serveDir) return {};

    /**
     * Resolve one specifier string against the importing file. Returns
     * 'inside' (lands in serve/), 'outside' (resolves elsewhere), or
     * 'unknown' (cannot be resolved statically — fail closed).
     */
    function classifySpecifier(raw) {
      if (typeof raw !== 'string' || raw.length === 0) return 'unknown';

      // URL schemes are case-insensitive, and the URL parser strips
      // leading/trailing whitespace (`import(' DATA:...')` still loads) —
      // detect schemes on the trimmed, lowercased form. Non-URL specifiers
      // (relative/bare) are NOT trimmed: Node resolves those verbatim.
      const normalized = raw.replace(/[\t\n\r]/g, '');
      const lower = normalized.trim().toLowerCase();

      if (lower === 'module' || lower === 'node:module') return 'unknown';

      // Other node: builtins never touch serve/.
      if (lower.startsWith('node:')) return 'outside';

      // data: URLs can embed imports of arbitrary files — a guarded tree
      // has no legitimate use for them.
      if (lower.startsWith('data:')) return 'unknown';

      // file: URLs resolve to a concrete path; anything not provably
      // outside serve is fail-closed (a guarded tree does not import by
      // URL).
      if (lower.startsWith('file:')) {
        try {
          const resolved = resolvePath(
            fileURLToPath(stripUrlSuffixes(normalized.trim())),
          );
          return isInServeDir(resolved, serveDir) ? 'inside' : 'unknown';
        } catch {
          return 'unknown';
        }
      }

      // Root-absolute paths map straight to the filesystem — fail closed
      // unless provably outside serve.
      if (normalized.startsWith('/')) {
        const decoded = decodeSpecifier(stripUrlSuffixes(normalized));
        if (decoded === undefined) return 'unknown';
        return isInServeDir(resolvePath(decoded), serveDir)
          ? 'inside'
          : 'unknown';
      }

      const cleaned = decodeSpecifier(stripUrlSuffixes(normalized));
      if (cleaned === undefined) return 'unknown';

      // Relative specifiers resolve against the importing file.
      if (cleaned.startsWith('./') || cleaned.startsWith('../')) {
        const resolved = resolvePath(path.join(fileDir, cleaned));
        return isInServeDir(resolved, serveDir) ? 'inside' : 'outside';
      }

      if (cleaned.startsWith('#')) return 'unknown';

      // Bare specifiers: real packages resolve elsewhere, but a tsconfig
      // baseUrl (packages/cli) makes `src/serve/...` resolve into serve/
      // (round-8 entrance). A bare specifier carrying traversal cannot be
      // attributed to any package — fail closed.
      if (cleaned.includes('../')) return 'unknown';
      if (baseUrlDir) {
        const resolved = path.resolve(baseUrlDir, cleaned);
        if (isInServeDir(resolved, serveDir)) return 'inside';
      }
      return 'outside';
    }

    function reportInside(node) {
      context.report({ node, messageId: 'serveBoundary' });
    }

    function reportUnknown(node) {
      context.report({ node, messageId: 'failClosed' });
    }

    /** Check a Literal/TemplateLiteral/computed source node. */
    function checkSource(sourceNode) {
      if (!sourceNode) return;
      let raw;
      if (sourceNode.type === 'Literal') {
        if (typeof sourceNode.value !== 'string') return; // not an import
        raw = sourceNode.value;
      } else if (sourceNode.type === 'TemplateLiteral') {
        raw = staticTemplateValue(sourceNode);
        if (raw === undefined) {
          reportUnknown(sourceNode);
          return;
        }
      } else {
        reportUnknown(sourceNode);
        return;
      }
      const verdict = classifySpecifier(raw);
      if (verdict === 'inside') reportInside(sourceNode);
      else if (verdict === 'unknown') reportUnknown(sourceNode);
    }

    /** new URL(spec, import.meta.url) — resolves against this module. */
    function isNewUrlWithImportMeta(node) {
      return (
        node.type === 'NewExpression' &&
        node.callee.type === 'Identifier' &&
        node.callee.name === 'URL' &&
        node.arguments.length >= 2 &&
        node.arguments[1].type === 'MetaProperty'
      );
    }

    /** Member-call shape: obj.prop(...); pass objectNames null to match
     *  ANY object identifier (alias-proof — the caller asserts safety). */
    function memberCall(node, objectNames, propertyPattern) {
      const callee = node.callee;
      const property =
        callee.type === 'MemberExpression' && !callee.computed
          ? callee.property.type === 'Identifier'
            ? callee.property.name
            : undefined
          : callee.type === 'MemberExpression' &&
              callee.computed &&
              callee.property.type === 'Literal' &&
              typeof callee.property.value === 'string'
            ? callee.property.value
            : undefined;
      return (
        callee.type === 'MemberExpression' &&
        callee.object.type === 'Identifier' &&
        (objectNames === null || objectNames.includes(callee.object.name)) &&
        property !== undefined &&
        propertyPattern.test(property)
      );
    }

    function isProcessObject(node) {
      return (
        (node.type === 'Identifier' && node.name === 'process') ||
        (node.type === 'MemberExpression' &&
          node.property.type === 'Identifier' &&
          node.property.name === 'process' &&
          node.object.type === 'Identifier' &&
          (node.object.name === 'globalThis' || node.object.name === 'global'))
      );
    }

    return {
      ImportDeclaration(node) {
        const value = node.source?.value;
        // The `module` builtin hands out createRequire, which aliases
        // require() past every import-shaped guard (round-7 entrance).
        if (typeof value === 'string' && /^(?:node:)?module$/.test(value)) {
          reportUnknown(node.source);
          return;
        }
        checkSource(node.source);
      },
      ExportNamedDeclaration(node) {
        if (node.source) checkSource(node.source);
      },
      ExportAllDeclaration(node) {
        checkSource(node.source);
      },
      ImportExpression(node) {
        checkSource(node.source);
      },
      // Type-level imports: import('../serve/x.js') inside a type position.
      TSImportType(node) {
        const literal = node.argument?.literal;
        if (literal) checkSource(literal);
      },
      CallExpression(node) {
        const callee = node.callee;

        // vi.mock / vi.doMock / vi.importActual / vi.importMock — vitest
        // resolves (and, without a factory, loads) the real module. The
        // object name is deliberately NOT matched: aliased spellings
        // (`import { vi as v } from 'vitest'; v.mock(...)`, destructured
        // `importActual(...)`) evade identifier checks (round-8 entrance),
        // and the guarded trees contain no non-vitest callers with these
        // method names. Only specifiers resolving INTO serve/ report, so
        // this cannot false-positive on other packages' modules.
        if (
          memberCall(node, null, /^(?:mock|doMock|importActual|importMock)$/) &&
          node.arguments.length > 0
        ) {
          checkSource(node.arguments[0]);
          return;
        }

        // require('...')
        if (
          callee.type === 'Identifier' &&
          callee.name === 'require' &&
          node.arguments.length > 0
        ) {
          checkSource(node.arguments[0]);
          return;
        }

        // Bare-identifier module-loading calls — the destructured spelling
        // `import { importActual } from 'vitest'; importActual(...)`. Same
        // rationale as the member form; we only report when the specifier
        // resolves INTO serve/, so a non-vitest loader of a non-serve module
        // is never flagged.
        if (
          callee.type === 'Identifier' &&
          /^(?:mock|doMock|importActual|importMock)$/.test(callee.name) &&
          node.arguments.length > 0
        ) {
          checkSource(node.arguments[0]);
          return;
        }

        // process.getBuiltinModule(...) hands out module objects
        // (createRequire) without any import statement (round-8 entrance).
        if (
          memberCall(node, ['process'], /^getBuiltinModule$/) ||
          (callee.type === 'MemberExpression' &&
            isProcessObject(callee.object) &&
            ((callee.property.type === 'Identifier' &&
              callee.property.name === 'getBuiltinModule') ||
              (callee.computed &&
                callee.property.type === 'Literal' &&
                callee.property.value === 'getBuiltinModule'))) ||
          (callee.type === 'Identifier' &&
            callee.name === 'getBuiltinModule') ||
          (memberCall(node, ['Reflect'], /^apply$/) &&
            node.arguments[0]?.type === 'MemberExpression' &&
            isProcessObject(node.arguments[0].object) &&
            node.arguments[0].property.type === 'Identifier' &&
            node.arguments[0].property.name === 'getBuiltinModule')
        ) {
          reportUnknown(node);
          return;
        }

        // child_process.fork loads a module path (resolved relative to the
        // importing file as the best static approximation; the guarded
        // trees have no such calls today). spawn is deliberately NOT
        // checked: its first argument is an executable resolved via
        // PATH/cwd, not a module — flagging it would false-positive on
        // legitimate code like spawn(process.execPath, [...]).
        if (
          memberCall(node, ['child_process'], /^fork$/) &&
          node.arguments.length > 0
        ) {
          checkSource(node.arguments[0]);
          return;
        }

        // new URL('../serve/...', import.meta.url) — Worker/asset loads
        // (round-8 entrance).
        if (isNewUrlWithImportMeta(node) && node.arguments.length > 0) {
          checkSource(node.arguments[0]);
        }
      },
      NewExpression(node) {
        // new Worker('../serve/...') — string-literal module paths resolve
        // relative to the importing module.
        if (
          node.callee.type === 'Identifier' &&
          node.callee.name === 'Worker' &&
          node.arguments.length > 0
        ) {
          checkSource(node.arguments[0]);
        }
      },
    };
  },
};
