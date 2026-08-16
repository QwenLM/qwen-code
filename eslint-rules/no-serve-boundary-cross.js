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

/** vitest module-loading method names (member and destructured spellings). */
const vitestLoaderNames = /^(?:mock|doMock|importActual|importMock)$/;

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

function staticMemberPropertyName(memberExpr) {
  if (!memberExpr.computed && memberExpr.property.type === 'Identifier') {
    return memberExpr.property.name;
  }
  if (
    memberExpr.computed &&
    memberExpr.property.type === 'Literal' &&
    typeof memberExpr.property.value === 'string'
  ) {
    return memberExpr.property.value;
  }
  if (memberExpr.computed && memberExpr.property.type === 'TemplateLiteral') {
    return staticTemplateValue(memberExpr.property);
  }
  return undefined;
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
    const serveDir = options.serveDir
      ? resolvePath(options.serveDir)
      : undefined;
    const baseUrlDir = options.baseUrlDir
      ? resolvePath(options.baseUrlDir)
      : undefined;
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

      // Node preprocesses every specifier the way the WHATWG URL parser
      // does before scheme detection: ASCII tab/LF/CR are removed ANYWHERE,
      // C0 controls and space are removed at the edges (`import(' DATA:…')`
      // and `import('\x01data:…')` still load), and backslashes normalize
      // to '/' — file: URLs are "special", so '..\\serve\\x.js' resolves
      // exactly like '../serve/x.js'. Scheme detection must use the same
      // normalized form or C0-prefixed data:/file: URLs slip past it.
      const normalized = raw.replace(/[\t\n\r]/g, '').replace(/\\/g, '/');
      const trimmed = normalized.replace(
        // The C0-control range is deliberate: it mirrors the WHATWG URL
        // parser's edge stripping, which is exactly what scheme detection
        // must reproduce here.
        // eslint-disable-next-line no-control-regex
        /^[\u0000-\u0020]+|[\u0000-\u0020]+$/g,
        '',
      );
      const lower = trimmed.toLowerCase();

      if (lower === 'module' || lower === 'node:module') return 'unknown';

      // Other node: builtins never touch serve/.
      if (lower.startsWith('node:')) return 'outside';

      // Node package-imports specifiers ('#name') need the package.json
      // "imports" map to resolve — fail closed. Must precede
      // stripUrlSuffixes, which splits on '#' and would eat the marker.
      if (trimmed.startsWith('#')) return 'unknown';

      // data: URLs can embed imports of arbitrary files — a guarded tree
      // has no legitimate use for them.
      if (lower.startsWith('data:')) return 'unknown';

      // file: URLs resolve to a concrete path, but a guarded tree does not
      // import by URL — fail closed unconditionally (even outside serve,
      // matching the fileoverview contract).
      if (lower.startsWith('file:')) {
        try {
          const resolved = resolvePath(
            fileURLToPath(stripUrlSuffixes(trimmed)),
          );
          return isInServeDir(resolved, serveDir) ? 'inside' : 'unknown';
        } catch {
          return 'unknown';
        }
      }

      // Root-absolute paths map straight to the filesystem — fail closed
      // unconditionally; guarded trees have no legitimate absolute-path
      // imports.
      if (trimmed.startsWith('/')) {
        const decoded = decodeSpecifier(stripUrlSuffixes(trimmed));
        if (decoded === undefined) return 'unknown';
        return isInServeDir(resolvePath(decoded), serveDir)
          ? 'inside'
          : 'unknown';
      }

      const cleaned = decodeSpecifier(stripUrlSuffixes(trimmed));
      if (cleaned === undefined) return 'unknown';

      // Relative specifiers resolve against the importing file.
      if (cleaned.startsWith('./') || cleaned.startsWith('../')) {
        const resolved = resolvePath(path.join(fileDir, cleaned));
        return isInServeDir(resolved, serveDir) ? 'inside' : 'outside';
      }

      // Bare specifiers: real packages resolve elsewhere, but a tsconfig
      // baseUrl (packages/cli) makes `src/serve/...` resolve into serve/
      // (round-8 entrance). A bare specifier carrying traversal cannot be
      // attributed to any package — fail closed.
      if (cleaned.includes('../')) return 'unknown';
      if (baseUrlDir) {
        const resolved = resolvePath(path.join(baseUrlDir, cleaned));
        if (isInServeDir(resolved, serveDir)) return 'inside';
      }
      return 'outside';
    }

    function reportInside(node) {
      context.report({ node, messageId: 'serveBoundary' });
    }

    function reportUnknown(node, messageId = 'failClosed') {
      context.report({ node, messageId });
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

    /** Member-call shape: obj.prop(...); pass objectNames null to match
     *  ANY object identifier (alias-proof — the caller asserts safety). */
    function memberCall(node, objectNames, propertyPattern) {
      const callee = node.callee;
      if (callee.type !== 'MemberExpression') return false;
      const property = staticMemberPropertyName(callee);
      return (
        (objectNames === null ||
          (callee.object.type === 'Identifier' &&
            objectNames.includes(callee.object.name))) &&
        property !== undefined &&
        propertyPattern.test(property)
      );
    }

    function isProcessObject(node) {
      return (
        (node.type === 'Identifier' && node.name === 'process') ||
        (node.type === 'MemberExpression' &&
          node.object.type === 'Identifier' &&
          (node.object.name === 'globalThis' ||
            node.object.name === 'global') &&
          staticMemberPropertyName(node) === 'process')
      );
    }

    /** getBuiltinModule as a property name — identifier or computed
     *  string-literal spelling. */
    function builtinModuleProperty(memberExpr) {
      return staticMemberPropertyName(memberExpr) === 'getBuiltinModule';
    }

    function isImportMetaUrl(node) {
      return (
        node?.type === 'MemberExpression' &&
        node.object.type === 'MetaProperty' &&
        staticMemberPropertyName(node) === 'url'
      );
    }

    function hasWorkerEvalOption(node) {
      const options = node.arguments[1];
      return (
        options?.type === 'ObjectExpression' &&
        options.properties.some(
          (property) =>
            property.type === 'Property' &&
            ((property.key.type === 'Identifier' &&
              property.key.name === 'eval') ||
              (property.computed &&
                property.key.type === 'Literal' &&
                property.key.value === 'eval')) &&
            property.value.type === 'Literal' &&
            property.value.value === true,
        )
      );
    }

    return {
      ImportDeclaration(node) {
        const value = node.source?.value;
        // The `module` builtin hands out createRequire, which aliases
        // require() past every import-shaped guard (round-7 entrance).
        if (typeof value === 'string' && /^(?:node:)?module$/.test(value)) {
          reportUnknown(node.source, 'moduleBuiltin');
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
      // import x = require('../serve/x.js') — tsc under NodeNext emits a
      // working createRequire shim for this spelling, so it loads at
      // runtime despite looking type-ish (sibling of the require visitor).
      TSImportEqualsDeclaration(node) {
        if (node.moduleReference?.type === 'TSExternalModuleReference') {
          checkSource(node.moduleReference.expression);
        }
      },
      CallExpression(node) {
        const callee = node.callee;

        // eval("import('...')") executes string code that can load any
        // module — the source is visible but unresolvable, so fail closed
        // like computed sources. Covers the `(0, eval)(...)` and
        // `globalThis.eval(...)` spellings; no-eval is not enabled in the
        // shared config and the guarded trees contain no eval calls.
        const evalCallee =
          callee.type === 'SequenceExpression'
            ? callee.expressions[callee.expressions.length - 1]
            : callee;
        if (
          (evalCallee.type === 'Identifier' && evalCallee.name === 'eval') ||
          (evalCallee.type === 'MemberExpression' &&
            evalCallee.object.type === 'Identifier' &&
            (evalCallee.object.name === 'globalThis' ||
              evalCallee.object.name === 'global') &&
            ((evalCallee.property.type === 'Identifier' &&
              evalCallee.property.name === 'eval') ||
              (evalCallee.computed &&
                evalCallee.property.type === 'Literal' &&
                evalCallee.property.value === 'eval')))
        ) {
          if (node.arguments.length > 0) reportUnknown(node);
          return;
        }

        // vi.mock / vi.doMock / vi.importActual / vi.importMock — vitest
        // resolves (and, without a factory, loads) the real module. The
        // object name is deliberately NOT matched: aliased spellings
        // (`import { vi as v } from 'vitest'; v.mock(...)`, destructured
        // `importActual(...)`) evade identifier checks (round-8 entrance),
        // and the guarded trees contain no non-vitest callers with these
        // method names. Only specifiers resolving INTO serve/ report, so
        // this cannot false-positive on other packages' modules.
        if (
          memberCall(node, null, vitestLoaderNames) &&
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
          vitestLoaderNames.test(callee.name) &&
          node.arguments.length > 0
        ) {
          checkSource(node.arguments[0]);
          return;
        }

        // process.getBuiltinModule(...) hands out module objects
        // (createRequire) without any import statement (round-8 entrance).
        // isProcessObject covers `process`, `globalThis.process` and
        // `global.process` including the computed property spellings;
        // builtinModuleProperty covers identifier and computed property
        // names; the bare identifier is the destructured spelling;
        // Reflect.apply(process.getBuiltinModule, ...) unwraps to the
        // same member shape.
        if (
          (callee.type === 'MemberExpression' &&
            isProcessObject(callee.object) &&
            builtinModuleProperty(callee)) ||
          (callee.type === 'Identifier' &&
            callee.name === 'getBuiltinModule') ||
          (memberCall(node, ['Reflect'], /^apply$/) &&
            node.arguments[0]?.type === 'MemberExpression' &&
            isProcessObject(node.arguments[0].object) &&
            builtinModuleProperty(node.arguments[0]))
        ) {
          reportUnknown(node, 'moduleBuiltin');
          return;
        }

        // Function(...) is new Function(...) without `new`.
        if (
          ((callee.type === 'Identifier' && callee.name === 'Function') ||
            (callee.type === 'MemberExpression' &&
              callee.object.type === 'Identifier' &&
              (callee.object.name === 'globalThis' ||
                callee.object.name === 'global') &&
              staticMemberPropertyName(callee) === 'Function')) &&
          node.arguments.length > 0
        ) {
          reportUnknown(node);
          return;
        }

        // child_process.fork loads a module path (resolved relative to the
        // importing file as the best static approximation; the guarded
        // trees have no such calls today). spawn is deliberately NOT
        // checked: its first argument is an executable resolved via
        // PATH/cwd, not a module — flagging it would false-positive on
        // legitimate code like spawn(process.execPath, [...]). The member
        // match is object-agnostic (same tradeoff as the vitest loaders:
        // `import cp from 'node:child_process'; cp.fork(...)` and the
        // namespace form must not evade the guard), and the bare
        // identifier covers destructured `fork`; only specifiers resolving
        // INTO serve/ report, so a non-serve fork target is never flagged.
        if (
          (memberCall(node, null, /^fork$/) ||
            (callee.type === 'Identifier' && callee.name === 'fork')) &&
          node.arguments.length > 0
        ) {
          checkSource(node.arguments[0]);
          return;
        }
      },
      NewExpression(node) {
        // new Function(body) compiles arbitrary string code that can
        // import() anything — the body is visible but unresolvable, so
        // fail closed like computed sources (eval's sibling).
        if (
          ((node.callee.type === 'Identifier' &&
            node.callee.name === 'Function') ||
            (node.callee.type === 'MemberExpression' &&
              node.callee.object.type === 'Identifier' &&
              (node.callee.object.name === 'globalThis' ||
                node.callee.object.name === 'global') &&
              staticMemberPropertyName(node.callee) === 'Function')) &&
          node.arguments.length > 0
        ) {
          reportUnknown(node);
          return;
        }

        // new Worker('../serve/...') / new wt.Worker('...') — string
        // module paths resolve relative to the importing module
        // (worker_threads does the same). Object-agnostic member match
        // covers namespace/default-import spellings.
        if (
          (node.callee.type === 'Identifier'
            ? node.callee.name === 'Worker'
            : node.callee.type === 'MemberExpression' &&
              (node.callee.property.type === 'Identifier'
                ? node.callee.property.name === 'Worker'
                : node.callee.computed &&
                  node.callee.property.type === 'Literal' &&
                  node.callee.property.value === 'Worker')) &&
          node.arguments.length > 0
        ) {
          // new Worker(new URL(spec, import.meta.url)) is resolved by the
          // new-URL arm below; checking it here too would fail-close a
          // fully static, boundary-clean construct and double-report the
          // serve-targeting form.
          const arg = node.arguments[0];
          const handledByUrlArm =
            arg.type === 'NewExpression' &&
            arg.callee.type === 'Identifier' &&
            arg.callee.name === 'URL' &&
            arg.arguments.length >= 2 &&
            isImportMetaUrl(arg.arguments[1]);
          if (hasWorkerEvalOption(node)) reportUnknown(arg);
          else if (!handledByUrlArm) checkSource(arg);
          return;
        }

        // new URL('../serve/...', import.meta.url) — Worker/asset loads
        // (round-8 entrance). The base argument is a MemberExpression
        // wrapping the import.meta MetaProperty; resolve the first
        // argument against this module.
        if (
          node.callee.type === 'Identifier' &&
          node.callee.name === 'URL' &&
          node.arguments.length >= 2 &&
          node.arguments[1].type === 'MemberExpression' &&
          node.arguments[1].object.type === 'MetaProperty'
        ) {
          if (isImportMetaUrl(node.arguments[1]))
            checkSource(node.arguments[0]);
          else reportUnknown(node.arguments[1]);
        }
      },
    };
  },
};
