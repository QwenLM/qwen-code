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
 * none of those shapes occurs anywhere in the guarded trees today. The
 * same posture covers CALLEE opacity: a call whose callee cannot be
 * classified (an unreduced call result, undecided conditional, or
 * non-static element access) is rejected too, and one binding hop from a
 * guarded name is tracked, because a guarded function reached through an
 * opaque or rebound callee is the same boundary crossing (R13-5, R13-7).
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
    // ENOENT: an import target does not have to exist for the resolver
    // (tsc/esbuild resolve extensionless and not-yet-written paths).
    // Canonicalize the deepest EXISTING ancestor and re-append the
    // missing tail — returning the textual path here lets candidates
    // reached through a symlinked ancestor (macOS /tmp, symlink-mounted
    // workspaces) miss the realpath'd serveDir and fail open (#8084
    // R13-2). Only a filesystem root that cannot be realpath'd keeps
    // the raw path.
    const tail = [];
    let base = resolved;
    for (;;) {
      const parent = path.dirname(base);
      if (parent === base) return resolved;
      tail.unshift(path.basename(base));
      base = parent;
      try {
        return path.join(fs.realpathSync.native(base), ...tail);
      } catch {
        // keep walking up
      }
    }
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
    // Canonicalize BOTH comparison sides through realpath: candidates are
    // realpath'd in the resolution arms, so a never-canonicalized
    // serveDir/baseUrlDir mismatches them whenever the repo sits under a
    // symlinked ancestor (macOS /tmp, symlink-mounted workspaces) and the
    // guard fails open (#8084 review).
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

      // Distinct verdict: the error is right but the generic failClosed
      // advice ('use a plain string-literal relative specifier') is
      // unactionable for a builtin — route to the dedicated message on
      // every entrance, matching the ImportDeclaration arm (R12-13).
      if (lower === 'module' || lower === 'node:module') {
        return 'module-builtin';
      }

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
        // Decode first, THEN re-normalize: %5c/%5C reintroduce
        // backslashes that the pre-decode normalization cannot see, and
        // the decoded '..\\serve' form resolves like '../serve'
        // (#8084 R13-1).
        const decoded = decodeSpecifier(stripUrlSuffixes(trimmed))?.replace(
          /\\/g,
          '/',
        );
        if (decoded === undefined) return 'unknown';
        return isInServeDir(resolvePath(decoded), serveDir)
          ? 'inside'
          : 'unknown';
      }

      const cleaned = decodeSpecifier(stripUrlSuffixes(trimmed))?.replace(
        /\\/g,
        '/',
      );
      if (cleaned === undefined) return 'unknown';

      // Relative specifiers resolve against the importing file.
      if (cleaned.startsWith('./') || cleaned.startsWith('../')) {
        const resolved = resolvePath(path.join(fileDir, cleaned));
        return isInServeDir(resolved, serveDir) ? 'inside' : 'outside';
      }

      // Bare specifiers: real packages resolve elsewhere, but a tsconfig
      // baseUrl (packages/cli) makes `src/serve/...` resolve into serve/
      // (round-8 entrance). A bare specifier carrying traversal cannot be
      // attributed to any package — fail closed. The resolution goes
      // through realpath like every other filesystem arm: a committable
      // symlink inside the baseUrl tree pointing into serve/ must not
      // classify 'outside' while tsc/esbuild follow it.
      if (cleaned.includes('../')) return 'unknown';
      if (baseUrlDir) {
        const resolved = resolvePath(path.resolve(baseUrlDir, cleaned));
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

    /** new URL(spec, import.meta.url) — the URL arm resolves this
     *  construct itself (reporting a serve target exactly once); every
     *  other entrance must let it through instead of fail-closing the
     *  canonical fully-static dynamic-load pattern or double-reporting
     *  the serve form (R12-12). */
    function isNewUrlWithImportMetaUrl(sourceNode) {
      const arg = unwrapSequence(sourceNode);
      return (
        arg.type === 'NewExpression' &&
        arg.callee.type === 'Identifier' &&
        arg.callee.name === 'URL' &&
        arg.arguments.length >= 2 &&
        arg.arguments[1].type === 'MemberExpression' &&
        arg.arguments[1].object.type === 'MetaProperty' &&
        staticPropertyName(
          arg.arguments[1].property,
          arg.arguments[1].computed,
        ) === 'url'
      );
    }

    /** Check a Literal/TemplateLiteral/computed source node. */
    function checkSource(sourceNode) {
      if (!sourceNode) return;
      // Statically non-specifier arguments (env objects, numbers,
      // functions) cannot load a module — treat them as non-imports
      // instead of failing closed (R12-11: recorder.mock({ silent: true })
      // and cluster.fork(env) must not error with unactionable advice).
      if (
        sourceNode.type === 'ObjectExpression' ||
        sourceNode.type === 'ArrayExpression' ||
        sourceNode.type === 'FunctionExpression' ||
        sourceNode.type === 'ArrowFunctionExpression' ||
        (sourceNode.type === 'Literal' && typeof sourceNode.value !== 'string')
      ) {
        return;
      }
      // The URL arm owns the new-URL-with-import.meta.url construct.
      if (isNewUrlWithImportMetaUrl(sourceNode)) return;
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
      else if (verdict === 'module-builtin') {
        reportUnknown(sourceNode, 'moduleBuiltin');
      } else if (verdict === 'unknown') reportUnknown(sourceNode);
    }

    /** Unwrap sequence expressions recursively: `(0, x)` evaluates to
     *  `x`, and double-wrapping `(0, (0, x))` is equally transparent
     *  (R12-2). TS assertion/instantiation wrappers (`x!`, `x as T`,
     *  `x satisfies T`, `x<T>`) are runtime no-ops and equally
     *  transparent. */
    function unwrapSequence(node) {
      let current = node;
      for (;;) {
        if (current?.type === 'SequenceExpression') {
          current = current.expressions[current.expressions.length - 1];
          continue;
        }
        if (
          current?.type === 'TSNonNullExpression' ||
          current?.type === 'TSAsExpression' ||
          current?.type === 'TSSatisfiesExpression' ||
          current?.type === 'TSInstantiationExpression'
        ) {
          current = current.expression;
          continue;
        }
        break;
      }
      return current;
    }

    /** Callee resolution on top of unwrapSequence (#8084 R13-7): the
     *  statically-known callee shapes evaluate to their targets — element
     *  access into a literal array (`[fork][0]`), a conditional whose
     *  test is a static literal, and `Reflect.get(obj, 'key')` (the
     *  equivalent member access). Every other shape keeps its node so the
     *  classifiability check can fail it closed. */
    function unwrapCallee(node) {
      let current = unwrapSequence(node);
      for (;;) {
        // A member chain whose OBJECT is itself a resolvable shape
        // (`Reflect.get(process, 'getBuiltinModule').call(...)`) keeps
        // its property but takes the resolved object.
        if (current?.type === 'MemberExpression') {
          const object = unwrapCallee(current.object);
          if (object !== current.object) {
            current = {
              type: 'MemberExpression',
              object,
              property: current.property,
              computed: current.computed,
            };
            continue;
          }
        }
        if (
          current?.type === 'MemberExpression' &&
          current.computed &&
          current.object.type === 'ArrayExpression' &&
          current.property.type === 'Literal' &&
          typeof current.property.value === 'number' &&
          Number.isInteger(current.property.value) &&
          current.property.value >= 0 &&
          current.property.value < current.object.elements.length &&
          current.object.elements[current.property.value]
        ) {
          current = unwrapSequence(
            current.object.elements[current.property.value],
          );
          continue;
        }
        if (current?.type === 'ConditionalExpression') {
          const test = unwrapSequence(current.test);
          let decided;
          if (test?.type === 'Literal') {
            decided = Boolean(test.value);
          } else if (test?.type === 'TemplateLiteral') {
            const value = staticTemplateValue(test);
            if (value === undefined) break;
            decided = Boolean(value);
          } else {
            break;
          }
          current = unwrapSequence(
            decided ? current.consequent : current.alternate,
          );
          continue;
        }
        if (
          current?.type === 'CallExpression' &&
          memberCall(current.callee, ['Reflect'], /^get$/) &&
          current.arguments.length >= 2 &&
          current.arguments[1].type === 'Literal' &&
          typeof current.arguments[1].value === 'string'
        ) {
          current = {
            type: 'MemberExpression',
            object: current.arguments[0],
            property: current.arguments[1],
            computed: true,
          };
          continue;
        }
        break;
      }
      return current;
    }

    /** Static name of a member property node: Identifier for dot access,
     *  string Literal or expression-free TemplateLiteral for computed
     *  (`vi[`mock`]` is as resolvable as vi.mock). */
    function staticPropertyName(propertyNode, computed) {
      if (!computed) {
        if (propertyNode.type === 'Identifier') return propertyNode.name;
        // A QUOTED key in an object literal (`{ 'eval': true }`) is
        // runtime-identical to the identifier key — resolving only
        // Identifiers fails open on the quoted spelling (#8084 R13-3).
        return propertyNode.type === 'Literal' &&
          typeof propertyNode.value === 'string'
          ? propertyNode.value
          : undefined;
      }
      if (
        propertyNode.type === 'Literal' &&
        typeof propertyNode.value === 'string'
      ) {
        return propertyNode.value;
      }
      if (propertyNode.type === 'TemplateLiteral') {
        return staticTemplateValue(propertyNode) ?? undefined;
      }
      return undefined;
    }

    /** Rightmost member-segment name of an object expression:
     *  `globalThis.vi` → 'vi', `x.cp` → 'cp', bare `vi` → 'vi'. Nested
     *  member objects must not evade object-scoped arms; sequence
     *  wrappers are transparent (`(0, process)` → 'process', R12-2). */
    function rightmostObjectName(objectNode) {
      const node = unwrapSequence(objectNode);
      if (node?.type === 'Identifier') return node.name;
      if (node?.type === 'MemberExpression') {
        return staticPropertyName(node.property, node.computed);
      }
      return undefined;
    }

    /** A named guarded global object (process/globalThis/global) whose
     *  computed property key is statically unresolvable — one variable
     *  rename re-opens the guarded entrance, so fail closed (R12-7).
     *  Object-agnostic arms keep their documented residue. */
    function namedGuardedObjectWithOpaqueKey(memberExpr) {
      return (
        memberExpr.type === 'MemberExpression' &&
        memberExpr.computed &&
        staticPropertyName(memberExpr.property, true) === undefined &&
        (() => {
          const name = rightmostObjectName(memberExpr.object);
          return (
            name === 'process' || name === 'globalThis' || name === 'global'
          );
        })()
      );
    }

    /** Message for an opaque-key fail-closed hit on a guarded global:
     *  the process family's opaque key stands in for getBuiltinModule,
     *  so it keeps the dedicated moduleBuiltin message; every other
     *  guarded global gets the generic failClosed advice (#8084 R13-4). */
    function opaqueGuardMessage(memberExpr) {
      const processFamily =
        isProcessObject(memberExpr.object) ||
        rightmostObjectName(memberExpr.object) === 'process';
      return processFamily ? 'moduleBuiltin' : 'failClosed';
    }

    /** Inline lazy vm imports as callee objects: `(await import('node:vm'))`
     *  or `import('vm')` — canonical ESM spellings that need no aliasing
     *  (R12-9). */
    function isVmLazyImportObject(objectNode) {
      let node = unwrapSequence(objectNode);
      if (node?.type === 'AwaitExpression') {
        node = unwrapSequence(node.argument);
      }
      if (node?.type !== 'ImportExpression') return false;
      const source =
        node.source?.type === 'Literal' ? node.source.value : undefined;
      return typeof source === 'string' && /^(?:node:)?vm$/.test(source);
    }

    /** Member-call shape: obj.prop(...); pass objectNames null to match
     *  ANY object shape (alias-proof — the caller asserts safety). */
    function memberCall(callee, objectNames, propertyPattern) {
      if (callee.type !== 'MemberExpression') return false;
      const property = staticPropertyName(callee.property, callee.computed);
      if (property === undefined || !propertyPattern.test(property)) {
        return false;
      }
      if (objectNames === null) return true;
      const objectName = rightmostObjectName(callee.object);
      return objectName !== undefined && objectNames.includes(objectName);
    }

    function isProcessObject(node) {
      const unwrapped = unwrapSequence(node);
      if (unwrapped?.type === 'Identifier') {
        return (
          unwrapped.name === 'process' || processAliases.has(unwrapped.name)
        );
      }
      if (unwrapped?.type !== 'MemberExpression') return false;
      const objectName = rightmostObjectName(unwrapped.object);
      return (
        (objectName === 'globalThis' || objectName === 'global') &&
        staticPropertyName(unwrapped.property, unwrapped.computed) === 'process'
      );
    }

    /** The vm object test shared by the vm-exec and Script arms: tracked
     *  import names, the bare `vm`, or an inline lazy vm import (R12-9). */
    function isVmObject(objectNode) {
      return (
        vmObjectNames.has(rightmostObjectName(objectNode) ?? '') ||
        isVmLazyImportObject(objectNode)
      );
    }

    /** getBuiltinModule as a property name — any statically resolvable
     *  spelling. */
    function builtinModuleProperty(memberExpr) {
      return (
        staticPropertyName(memberExpr.property, memberExpr.computed) ===
        'getBuiltinModule'
      );
    }

    // Renamed module-loading bindings resolved from the import
    // declarations of this file: `import { fork as f }`,
    // `import { Worker as W }`, vitest loaders, vm surfaces. Anything
    // unresolvable stays out of these sets (documented residue, not
    // fail-closed bait).
    const forkAliases = new Set();
    const workerAliases = new Set();
    const scriptAliases = new Set();
    const vmObjectNames = new Set(['vm']);
    const vmExecNames =
      /^(?:runInThisContext|runInNewContext|runInContext|compileFunction)$/;
    const vmBareExecAliases = new Set();
    const vitestLoaderAliases = new Set();
    // Rebindings of the `process` global (isProcessObject consults these)
    // and of getBuiltinModule extracted/destructured from it (#8084 R13-5).
    const processAliases = new Set();
    const bareGetBuiltinModuleAliases = new Set();
    /** local name -> bare lib, for namespace-like bindings of tracked libs */
    const namespaceAliases = new Map();
    const trackedLibs = /^(?:worker_threads|child_process|vitest|vm)$/;

    function registerImportAliases(importNode) {
      const value = importNode.source?.value;
      if (typeof value !== 'string') return;
      const bare = value.startsWith('node:') ? value.slice(5) : value;
      for (const spec of importNode.specifiers) {
        const imported =
          spec.type === 'ImportSpecifier'
            ? (spec.imported?.name ?? spec.imported?.value)
            : undefined;
        // Namespace/default imports of a tracked lib are destructurable
        // namespaces: `const { Worker: W } = wt` must see wt's lib
        // (#8084 R13-5). vm additionally uses the name as a vm object.
        if (
          (spec.type === 'ImportNamespaceSpecifier' ||
            spec.type === 'ImportDefaultSpecifier') &&
          trackedLibs.test(bare)
        ) {
          namespaceAliases.set(spec.local.name, bare);
        }
        if (bare === 'child_process' && imported === 'fork') {
          forkAliases.add(spec.local.name);
        } else if (bare === 'worker_threads' && imported === 'Worker') {
          workerAliases.add(spec.local.name);
        } else if (
          bare === 'vitest' &&
          spec.type === 'ImportSpecifier' &&
          vitestLoaderNames.test(imported ?? '')
        ) {
          vitestLoaderAliases.add(spec.local.name);
        } else if (bare === 'vm') {
          if (spec.type === 'ImportSpecifier') {
            if (imported === 'Script') scriptAliases.add(spec.local.name);
            else if (vmExecNames.test(imported ?? '')) {
              vmBareExecAliases.add(spec.local.name);
            }
          } else {
            // default or namespace import — usable as the vm object
            vmObjectNames.add(spec.local.name);
          }
        }
      }
    }

    // ESM imports are HOISTED: a renamed import used textually BEFORE its
    // declaration is legal, so the alias sets must be populated from the
    // whole module body before any guarded call is inspected — visitor
    // source order would fail open on use-before-import (R12-5).
    for (const statement of context.sourceCode.ast?.body ?? []) {
      if (statement.type === 'ImportDeclaration') {
        registerImportAliases(statement);
      }
    }

    /** Bare lib name of a (possibly awaited, sequence-wrapped) dynamic
     *  import expression; undefined for any other shape. */
    function dynamicImportLib(node) {
      let current = unwrapSequence(node);
      if (current?.type === 'AwaitExpression') {
        current = unwrapSequence(current.argument);
      }
      if (current?.type !== 'ImportExpression') return undefined;
      const source =
        current.source?.type === 'Literal' ? current.source.value : undefined;
      if (typeof source !== 'string') return undefined;
      return source.startsWith('node:') ? source.slice(5) : source;
    }

    /** Lib of a namespace-like object expression: a tracked namespace
     *  alias, or an inline dynamic import of a tracked lib. */
    function namespaceLibOf(node) {
      const current = unwrapSequence(node);
      if (current?.type === 'Identifier') {
        return namespaceAliases.get(current.name);
      }
      const lib = dynamicImportLib(current);
      return lib !== undefined && trackedLibs.test(lib) ? lib : undefined;
    }

    /** Register one named binding extracted from a tracked lib. */
    function registerNamedBinding(local, imported, lib, add) {
      if (lib === 'child_process' && imported === 'fork') {
        add(forkAliases, local);
      } else if (lib === 'worker_threads' && imported === 'Worker') {
        add(workerAliases, local);
      } else if (lib === 'vitest' && vitestLoaderNames.test(imported ?? '')) {
        add(vitestLoaderAliases, local);
      } else if (lib === 'vm') {
        if (imported === 'Script') add(scriptAliases, local);
        else if (vmExecNames.test(imported ?? '')) {
          add(vmBareExecAliases, local);
        }
      }
    }

    // import('<lib>').then((ns) => ...) binds the namespace inside the
    // callback — register the first parameter of any such callback,
    // wherever it appears (#8084 R13-5).
    (function walkForThenNamespaces(node) {
      if (!node || typeof node !== 'object') return;
      if (node.type === 'CallExpression') {
        const callee = unwrapSequence(node.callee);
        const callback = node.arguments?.[0];
        if (
          callee?.type === 'MemberExpression' &&
          staticPropertyName(callee.property, callee.computed) === 'then' &&
          (callback?.type === 'ArrowFunctionExpression' ||
            callback?.type === 'FunctionExpression') &&
          callback.params[0]?.type === 'Identifier'
        ) {
          const lib = dynamicImportLib(callee.object);
          if (lib !== undefined && trackedLibs.test(lib)) {
            if (lib === 'vm') vmObjectNames.add(callback.params[0].name);
            namespaceAliases.set(callback.params[0].name, lib);
          }
        }
      }
      for (const key of Object.keys(node)) {
        if (key === 'parent') continue;
        const value = node[key];
        if (Array.isArray(value)) {
          for (const child of value) walkForThenNamespaces(child);
        } else if (value && typeof value.type === 'string') {
          walkForThenNamespaces(value);
        }
      }
    })(context.sourceCode.ast);

    // One binding hop defeats a name-based arm: a local holding a guarded
    // function IS that function (#8084 R13-5). Propagate bindings over
    // top-level declarators to a fixpoint (rebinding chains converge):
    // rebinding of tracked names, member extraction from guarded globals
    // and tracked namespaces, destructuring from guarded globals /
    // namespaces / awaited dynamic imports, and whole-namespace bindings
    // from dynamic imports.
    for (;;) {
      let changed = false;
      const add = (set, name) => {
        if (!set.has(name)) {
          set.add(name);
          changed = true;
        }
      };
      for (const statement of context.sourceCode.ast?.body ?? []) {
        if (statement.type !== 'VariableDeclaration') continue;
        for (const declarator of statement.declarations) {
          const init = declarator.init
            ? unwrapSequence(declarator.init)
            : undefined;
          if (!init) continue;

          if (declarator.id.type === 'Identifier') {
            const local = declarator.id.name;
            if (init.type === 'Identifier') {
              const name = init.name;
              if (name === 'process' || processAliases.has(name)) {
                add(processAliases, local);
              }
              if (name === 'Worker' || workerAliases.has(name)) {
                add(workerAliases, local);
              }
              if (name === 'fork' || forkAliases.has(name)) {
                add(forkAliases, local);
              }
              if (name === 'Script' || scriptAliases.has(name)) {
                add(scriptAliases, local);
              }
              if (
                name === 'getBuiltinModule' ||
                bareGetBuiltinModuleAliases.has(name)
              ) {
                add(bareGetBuiltinModuleAliases, local);
              }
              if (vmObjectNames.has(name)) add(vmObjectNames, local);
              if (vmBareExecAliases.has(name)) add(vmBareExecAliases, local);
              if (vitestLoaderAliases.has(name)) {
                add(vitestLoaderAliases, local);
              }
              const nsLib = namespaceAliases.get(name);
              if (
                nsLib !== undefined &&
                namespaceAliases.get(local) !== nsLib
              ) {
                namespaceAliases.set(local, nsLib);
                changed = true;
              }
            }
            if (init.type === 'MemberExpression') {
              const property = staticPropertyName(init.property, init.computed);
              if (
                property === 'getBuiltinModule' &&
                isProcessObject(init.object)
              ) {
                add(bareGetBuiltinModuleAliases, local);
              }
              if (property !== undefined) {
                const lib = namespaceLibOf(init.object);
                if (lib !== undefined) {
                  registerNamedBinding(local, property, lib, add);
                }
              }
            }
            const lib = dynamicImportLib(init);
            if (lib !== undefined && trackedLibs.test(lib)) {
              if (lib === 'vm') add(vmObjectNames, local);
              if (namespaceAliases.get(local) !== lib) {
                namespaceAliases.set(local, lib);
                changed = true;
              }
            }
          }

          if (declarator.id.type === 'ObjectPattern') {
            const fromProcess = isProcessObject(init);
            const lib = fromProcess ? undefined : namespaceLibOf(init);
            if (!fromProcess && lib === undefined) continue;
            for (const property of declarator.id.properties) {
              if (
                property.type !== 'Property' ||
                property.value.type !== 'Identifier'
              ) {
                continue;
              }
              const key = staticPropertyName(property.key, property.computed);
              if (key === undefined) continue;
              if (fromProcess) {
                if (key === 'getBuiltinModule') {
                  add(bareGetBuiltinModuleAliases, property.value.name);
                }
              } else {
                registerNamedBinding(property.value.name, key, lib, add);
              }
            }
          }
        }
      }
      if (!changed) break;
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
        // `(0, x)` (and nested `(0, (0, x))`) evaluates to `x` — unwrap
        // recursively and uniformly before every callee-shape check
        // (R12-2); statically-known callee shapes ([x][0], static
        // conditionals, Reflect.get with a literal key) additionally
        // resolve to their targets (R13-7).
        const callee = unwrapCallee(node.callee);

        // Callee opacity (#8084 R13-7): a guarded function invoked
        // through a callee shape no arm can classify evades every
        // name-based check. Fail closed narrowly: a conditional callee
        // whose branch is statically undecided, a non-static element
        // access into an array callee (the static-index form is resolved
        // by unwrapCallee), and Reflect.get with an opaque key on a
        // guarded global. Call-result callees of any other provenance
        // (`it.each([...])(...)`, factory patterns) keep the documented
        // pass-through — their binding is no more resolvable than any
        // other local the rule does not track.
        if (callee.type === 'ConditionalExpression') {
          reportUnknown(node);
          return;
        }
        if (
          callee.type === 'MemberExpression' &&
          callee.computed &&
          callee.object.type === 'ArrayExpression'
        ) {
          reportUnknown(node);
          return;
        }
        if (
          callee.type === 'CallExpression' &&
          memberCall(callee.callee, ['Reflect'], /^get$/) &&
          callee.arguments.length > 0
        ) {
          const staticKey =
            callee.arguments.length >= 2 &&
            staticPropertyName(callee.arguments[1], true) !== undefined;
          if (!staticKey) {
            const target = unwrapSequence(callee.arguments[0]);
            const targetObjectName = rightmostObjectName(target);
            if (
              isProcessObject(target) ||
              targetObjectName === 'process' ||
              targetObjectName === 'globalThis' ||
              targetObjectName === 'global'
            ) {
              reportUnknown(
                node,
                isProcessObject(target) || targetObjectName === 'process'
                  ? 'moduleBuiltin'
                  : 'failClosed',
              );
              return;
            }
          }
        }

        // Function.prototype.call/apply/bind indirection on guarded
        // callees: `.call` unwraps like a direct call with the specifier
        // shifted one argument right; `.apply`/`.bind` forward their
        // arguments in shapes this rule does not resolve — fail closed
        // (same treatment Reflect.apply already gets). Chained
        // indirection (x.call.call) resolves innerName to 'call' itself —
        // fail closed rather than fall through (R12-3).
        if (callee.type === 'MemberExpression') {
          const indirect = staticPropertyName(callee.property, callee.computed);
          if (
            indirect === 'call' ||
            indirect === 'apply' ||
            indirect === 'bind'
          ) {
            const innerName = rightmostObjectName(callee.object);
            if (
              innerName === 'call' ||
              innerName === 'apply' ||
              innerName === 'bind'
            ) {
              reportUnknown(node);
              return;
            }
            if (
              innerName === 'eval' ||
              innerName === 'Function' ||
              innerName === 'constructor' ||
              // Worker/Script forward a module path / code — same
              // fail-closed class as eval/Function; the alias sets keep
              // this list mirrored with the direct-call arms (R13-6).
              innerName === 'Worker' ||
              innerName === 'Script' ||
              (innerName !== undefined && workerAliases.has(innerName)) ||
              (innerName !== undefined && scriptAliases.has(innerName)) ||
              // vm exec callees forward CODE, not a specifier — and a
              // renamed vm-exec import resolves through its alias set.
              (innerName !== undefined && vmExecNames.test(innerName)) ||
              (innerName !== undefined && vmBareExecAliases.has(innerName))
            ) {
              reportUnknown(node);
              return;
            }
            if (
              innerName === 'getBuiltinModule' ||
              (innerName !== undefined &&
                bareGetBuiltinModuleAliases.has(innerName))
            ) {
              if (node.arguments.length > 0) {
                reportUnknown(node, 'moduleBuiltin');
              }
              return;
            }
            if (
              /^(?:require|fork|mock|doMock|importActual|importMock)$/.test(
                innerName ?? '',
              ) ||
              forkAliases.has(innerName ?? '') ||
              vitestLoaderAliases.has(innerName ?? '')
            ) {
              if (indirect === 'call') {
                if (node.arguments.length > 1) {
                  checkSource(node.arguments[1]);
                }
              } else {
                reportUnknown(node);
              }
              return;
            }
            // Opaque composition one hop down: `process[k].call(...)` —
            // the callee BELOW `.call/.apply/.bind` carries a statically
            // unresolvable key on a guarded global, so the name-based
            // cascade above sees `undefined` and falls through. Fail
            // closed at composition depth with the family message
            // (#8084 R13-4).
            if (
              node.arguments.length > 0 &&
              namedGuardedObjectWithOpaqueKey(callee.object)
            ) {
              reportUnknown(node, opaqueGuardMessage(callee.object));
              return;
            }
          }
          // A named guarded global with an opaque computed key is one
          // variable rename away from a guarded entrance — fail closed
          // (R12-7; object-agnostic arms keep their documented residue).
          // process-family objects keep the dedicated moduleBuiltin
          // message: the opaque key stands in for getBuiltinModule.
          if (
            node.arguments.length > 0 &&
            namedGuardedObjectWithOpaqueKey(callee)
          ) {
            reportUnknown(
              node,
              isProcessObject(callee.object) ? 'moduleBuiltin' : 'failClosed',
            );
            return;
          }
        }

        // String-code execution class: any call whose callee ends in the
        // `eval` or `Function` identifier — direct, sequence-unwrapped,
        // or member spellings (globalThis.eval, globalThis.Function) —
        // plus `.constructor` property chains, which reach the Function
        // constructor WITHOUT naming it (({}).constructor.constructor,
        // (function(){}).constructor, AsyncFunction variants). All
        // compile/execute arbitrary string code that can import()
        // anything; the source is visible but unresolvable, so fail
        // closed like computed sources. eval/Function fail closed on ANY
        // argument; `.constructor` keeps the pass-through for statically
        // NON-string literals but fails closed on variables and
        // expression templates — a code body held in a variable is still
        // code (R12-8).
        const calleeName =
          callee.type === 'Identifier'
            ? callee.name
            : callee.type === 'MemberExpression'
              ? staticPropertyName(callee.property, callee.computed)
              : undefined;
        if (
          node.arguments.length > 0 &&
          (calleeName === 'eval' ||
            calleeName === 'Function' ||
            calleeName === 'constructor')
        ) {
          if (calleeName === 'constructor') {
            const first = node.arguments[0];
            if (first.type === 'Literal' && typeof first.value !== 'string') {
              return; // statically non-string: cannot be a code body
            }
            reportUnknown(node);
          } else {
            reportUnknown(node);
          }
          return;
        }

        // Worker invoked as a plain function — direct or reached through
        // a resolved opaque shape ([Worker][0]('...'), R13-7). The
        // guarded trees have no legitimate Worker-named factories, and
        // the member match mirrors the object-agnostic new-Worker arm
        // (#8084 R13-6).
        if (
          node.arguments.length > 0 &&
          (calleeName === 'Worker' ||
            (callee.type === 'Identifier' && workerAliases.has(callee.name)))
        ) {
          reportUnknown(node);
          return;
        }

        // node:vm string-execution surface — runInThisContext /
        // runInNewContext / runInContext / compileFunction compile or run
        // arbitrary string code. Scoped to vm imports (default/namespace
        // objects and renamed named imports), the bare `vm` name, and
        // inline lazy imports — `(await import('node:vm')).runInContext`
        // is canonical ESM and needs no aliasing (R12-9).
        if (node.arguments.length > 0) {
          const vmProperty =
            callee.type === 'MemberExpression'
              ? staticPropertyName(callee.property, callee.computed)
              : undefined;
          if (
            (vmProperty !== undefined &&
              vmExecNames.test(vmProperty) &&
              isVmObject(callee.object)) ||
            (callee.type === 'Identifier' && vmBareExecAliases.has(callee.name))
          ) {
            reportUnknown(node);
            return;
          }
        }

        // vi.mock / vi.doMock / vi.importActual / vi.importMock — vitest
        // resolves (and, without a factory, loads) the real module. The
        // object is deliberately NOT matched (rightmost-segment matching
        // covers `globalThis.vi`, `vitest.vi`, nested member objects):
        // aliased spellings evade identifier checks (round-8 entrance),
        // and the guarded trees contain no non-vitest callers with these
        // method names. Only specifiers resolving INTO serve/ report, so
        // this cannot false-positive on other packages' modules.
        if (
          memberCall(callee, null, vitestLoaderNames) &&
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
        // `import { importActual } from 'vitest'; importActual(...)`,
        // RENAMED included (`import { importActual as ia }`, R12-6: a
        // renamed destructuring is still a destructured spelling). Same
        // rationale as the member form; we only report when the specifier
        // resolves INTO serve/, so a non-vitest loader of a non-serve module
        // is never flagged.
        if (
          callee.type === 'Identifier' &&
          (vitestLoaderNames.test(callee.name) ||
            vitestLoaderAliases.has(callee.name)) &&
          node.arguments.length > 0
        ) {
          checkSource(node.arguments[0]);
          return;
        }

        // process.getBuiltinModule(...) hands out module objects
        // (createRequire) without any import statement (round-8 entrance).
        // isProcessObject covers `process`, `globalThis.process` and
        // `global.process` in every statically resolvable property
        // spelling; builtinModuleProperty likewise; the bare identifier
        // is the destructured spelling; Reflect indirection is unwrapped
        // below.
        if (
          (callee.type === 'MemberExpression' &&
            isProcessObject(callee.object) &&
            builtinModuleProperty(callee)) ||
          // Opaque object side: `globalThis[p].getBuiltinModule(...)` —
          // the callee's own property resolves, but the OBJECT is an
          // opaque computed member of a guarded-global family, which
          // isProcessObject cannot see (#8084 R13-4).
          (callee.type === 'MemberExpression' &&
            builtinModuleProperty(callee) &&
            namedGuardedObjectWithOpaqueKey(callee.object)) ||
          // Bare identifier: destructured/extracted spellings resolve
          // through the alias set (R13-5 binding propagation).
          (callee.type === 'Identifier' &&
            (callee.name === 'getBuiltinModule' ||
              bareGetBuiltinModuleAliases.has(callee.name)))
        ) {
          reportUnknown(node, 'moduleBuiltin');
          return;
        }

        // Reflect.apply / Reflect.construct with a guarded target: the
        // arguments travel inside an array this rule does not resolve —
        // fail closed (the getBuiltinModule target keeps its messageId).
        // The target lists mirror the direct-call arms: Function and the
        // vm exec/Script surface forward CODE; require/fork/Worker and
        // the vitest loaders forward specifiers; alias sets included
        // (R12-4).
        if (memberCall(callee, ['Reflect'], /^(?:apply|construct)$/)) {
          const target = unwrapSequence(node.arguments[0]);
          const targetMember = target?.type === 'MemberExpression';
          const targetName = targetMember
            ? staticPropertyName(target.property, target.computed)
            : target?.type === 'Identifier'
              ? target.name
              : undefined;
          if (
            targetMember &&
            isProcessObject(target.object) &&
            builtinModuleProperty(target)
          ) {
            reportUnknown(node, 'moduleBuiltin');
            return;
          }
          // Opaque composition as the Reflect target:
          // `Reflect.apply(process[k], ...)` — targetName one hop down is
          // undefined and every name-based check below misses it; fail
          // closed at composition depth (#8084 R13-4).
          if (targetMember && namedGuardedObjectWithOpaqueKey(target)) {
            reportUnknown(node, opaqueGuardMessage(target));
            return;
          }
          if (targetMember) {
            if (
              targetName === 'eval' ||
              targetName === 'Function' ||
              targetName === 'fork' ||
              // Worker mirrors the object-agnostic new-Worker arm; the
              // alias sets keep this list mirrored with the direct-call
              // arms (R13-6).
              targetName === 'Worker' ||
              (targetName !== undefined && workerAliases.has(targetName)) ||
              (targetName !== undefined &&
                vmExecNames.test(targetName) &&
                isVmObject(target.object)) ||
              (targetName === 'Script' && isVmObject(target.object)) ||
              (targetName !== undefined && vitestLoaderNames.test(targetName))
            ) {
              reportUnknown(node);
            }
          } else if (target?.type === 'Identifier') {
            if (
              /^(?:require|eval|fork|Function)$/.test(targetName ?? '') ||
              targetName === 'Worker' ||
              workerAliases.has(targetName ?? '') ||
              forkAliases.has(targetName ?? '') ||
              scriptAliases.has(targetName ?? '') ||
              vmBareExecAliases.has(targetName ?? '') ||
              vitestLoaderNames.test(targetName ?? '') ||
              vitestLoaderAliases.has(targetName ?? '')
            ) {
              reportUnknown(node);
            }
          }
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
        // namespace form must not evade the guard), the bare identifier
        // covers destructured `fork`, and forkAliases covers renamed
        // imports; only specifiers resolving INTO serve/ report, so a
        // non-serve fork target is never flagged.
        if (
          (memberCall(callee, null, /^fork$/) ||
            (callee.type === 'Identifier' &&
              (callee.name === 'fork' || forkAliases.has(callee.name)))) &&
          node.arguments.length > 0
        ) {
          checkSource(node.arguments[0]);
          return;
        }
      },
      NewExpression(node) {
        // Recursive sequence unwrap, same invariant as CallExpression
        // (`new (0, (0, Worker))(…)` is transparent too, R12-2); the
        // statically-known callee shapes resolve as well (R13-7).
        const callee = unwrapCallee(node.callee);

        // Callee opacity, constructor spelling (#8084 R13-7): same
        // narrow fail-closed shapes as the call arm — an undecided
        // conditional callee and a non-static element access into an
        // array callee.
        if (callee.type === 'ConditionalExpression') {
          reportUnknown(node);
          return;
        }
        if (
          callee.type === 'MemberExpression' &&
          callee.computed &&
          callee.object.type === 'ArrayExpression'
        ) {
          reportUnknown(node);
          return;
        }

        // new Function(body) / new globalThis.Function(body) compiles
        // arbitrary string code that can import() anything — fail closed
        // like computed sources (eval's sibling).
        if (
          node.arguments.length > 0 &&
          ((callee.type === 'Identifier' && callee.name === 'Function') ||
            (callee.type === 'MemberExpression' &&
              staticPropertyName(callee.property, callee.computed) ===
                'Function'))
        ) {
          reportUnknown(node);
          return;
        }

        // new vm.Script(code) / new Script(code) — string-code
        // compilation, same class as Function (vm import spellings,
        // including inline lazy imports, R12-9).
        if (
          node.arguments.length > 0 &&
          ((callee.type === 'MemberExpression' &&
            staticPropertyName(callee.property, callee.computed) === 'Script' &&
            isVmObject(callee.object)) ||
            (callee.type === 'Identifier' && scriptAliases.has(callee.name)))
        ) {
          reportUnknown(node);
          return;
        }

        // new Worker('../serve/...') / new wt.Worker('...') / new W
        // (renamed import) — string module paths resolve relative to the
        // importing module (worker_threads does the same). Object-agnostic
        // member match covers namespace/default-import spellings.
        const workerCallee =
          callee.type === 'Identifier'
            ? callee.name === 'Worker' || workerAliases.has(callee.name)
            : callee.type === 'MemberExpression' &&
              staticPropertyName(callee.property, callee.computed) === 'Worker';
        if (workerCallee && node.arguments.length > 0) {
          // new Worker(codeString, { eval: true }) executes arg0 as CODE,
          // not as a specifier. Contract (R12-1, modeled once in R13-3):
          // fail closed on ANYTHING whose effect on the final `eval`
          // value is statically undecided. Runtime object-literal
          // semantics the scan must reproduce: the LAST `eval` key wins
          // (duplicates included); an options object WITHOUT `eval`
          // defaults to false (arg0 stays a specifier); a spread makes
          // the final value unverifiable unless a LATER literal `eval`
          // wins; a statically UNRESOLVABLE computed key may BE `eval`;
          // and a non-computed `__proto__` key installs a PROTOTYPE, so
          // `eval` can be inherited through the prototype chain even
          // when no own `eval` exists.
          const opts = node.arguments[1];
          if (opts) {
            let evalState = 'absent'; // 'absent' | 'false' | 'true' | 'unknown'
            if (opts.type === 'ObjectExpression') {
              for (const property of opts.properties) {
                if (property.type !== 'Property') {
                  // SpreadElement (or anything else) can set or override
                  // `eval` at runtime — only a LATER literal wins.
                  evalState = 'unknown';
                  continue;
                }
                const key = staticPropertyName(property.key, property.computed);
                if (key === undefined) {
                  // A statically unresolvable computed key may be 'eval'
                  // at runtime — same posture as a spread: only a LATER
                  // literal `eval` settles the final value (R13-3).
                  evalState = 'unknown';
                  continue;
                }
                if (key === '__proto__' && !property.computed) {
                  // Non-computed `__proto__` sets the prototype; Node
                  // reads `opts.eval` with prototype lookup, so an
                  // inherited `eval: true` executes arg0 as code. Only a
                  // static null severs the chain (R13-3).
                  if (
                    property.value.type === 'Literal' &&
                    property.value.value === null
                  ) {
                    continue;
                  }
                  evalState = 'unknown';
                  continue;
                }
                if (key !== 'eval') continue;
                if (
                  property.value.type === 'Literal' &&
                  typeof property.value.value === 'boolean'
                ) {
                  evalState = property.value.value ? 'true' : 'false';
                } else {
                  evalState = 'unknown';
                }
              }
            } else {
              evalState = 'unknown'; // dynamic options object
            }
            if (evalState === 'unknown' || evalState === 'true') {
              reportUnknown(node);
              return;
            }
          }
          // new Worker(new URL(spec, import.meta.url)) is resolved by the
          // new-URL arm below; checking it here too would fail-close a
          // fully static, boundary-clean construct and double-report the
          // serve-targeting form.
          const arg = node.arguments[0];
          if (!isNewUrlWithImportMetaUrl(arg)) checkSource(arg);
          return;
        }

        // new URL('../serve/...', import.meta.url) — Worker/asset loads
        // (round-8 entrance). The base argument is a MemberExpression
        // wrapping the import.meta MetaProperty; resolve the first
        // argument against this module. Only import.meta.URL is a
        // statically known base — import.meta.<anything else> cannot be
        // resolved, so fail closed instead of assuming the module base.
        if (
          callee.type === 'Identifier' &&
          callee.name === 'URL' &&
          node.arguments.length >= 2 &&
          node.arguments[1].type === 'MemberExpression' &&
          node.arguments[1].object.type === 'MetaProperty'
        ) {
          if (
            staticPropertyName(
              node.arguments[1].property,
              node.arguments[1].computed,
            ) === 'url'
          ) {
            checkSource(node.arguments[0]);
          } else {
            reportUnknown(node);
          }
        }
      },
    };
  },
};
