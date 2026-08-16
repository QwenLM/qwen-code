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

    /** Static name of a member property node: Identifier for dot access,
     *  string Literal or expression-free TemplateLiteral for computed
     *  (`vi[`mock`]` is as resolvable as vi.mock). */
    function staticPropertyName(propertyNode, computed) {
      if (!computed) {
        return propertyNode.type === 'Identifier'
          ? propertyNode.name
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
     *  member objects must not evade object-scoped arms. */
    function rightmostObjectName(objectNode) {
      if (objectNode.type === 'Identifier') return objectNode.name;
      if (objectNode.type === 'MemberExpression') {
        return staticPropertyName(objectNode.property, objectNode.computed);
      }
      return undefined;
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
      if (node.type === 'Identifier') return node.name === 'process';
      if (node.type !== 'MemberExpression') return false;
      const objectName = rightmostObjectName(node.object);
      return (
        (objectName === 'globalThis' || objectName === 'global') &&
        staticPropertyName(node.property, node.computed) === 'process'
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
    // `import { Worker as W }`, vm surfaces. Anything unresolvable stays
    // out of these sets (documented residue, not fail-closed bait).
    const forkAliases = new Set();
    const workerAliases = new Set();
    const scriptAliases = new Set();
    const vmObjectNames = new Set(['vm']);
    const vmExecNames =
      /^(?:runInThisContext|runInNewContext|runInContext|compileFunction)$/;
    const vmBareExecAliases = new Set();

    return {
      ImportDeclaration(node) {
        const value = node.source?.value;
        // The `module` builtin hands out createRequire, which aliases
        // require() past every import-shaped guard (round-7 entrance).
        if (typeof value === 'string' && /^(?:node:)?module$/.test(value)) {
          reportUnknown(node.source, 'moduleBuiltin');
          return;
        }
        if (typeof value === 'string') {
          const bare = value.startsWith('node:') ? value.slice(5) : value;
          for (const spec of node.specifiers) {
            const imported =
              spec.type === 'ImportSpecifier'
                ? (spec.imported?.name ?? spec.imported?.value)
                : undefined;
            if (bare === 'child_process' && imported === 'fork') {
              forkAliases.add(spec.local.name);
            } else if (bare === 'worker_threads' && imported === 'Worker') {
              workerAliases.add(spec.local.name);
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
        // `(0, x)(...)` resolves to the last sequence element — unwrap
        // once, uniformly, before every callee-shape check below.
        const callee =
          node.callee.type === 'SequenceExpression'
            ? node.callee.expressions[node.callee.expressions.length - 1]
            : node.callee;

        // Function.prototype.call/apply/bind indirection on guarded
        // callees: `.call` unwraps like a direct call with the specifier
        // shifted one argument right; `.apply`/`.bind` forward their
        // arguments in shapes this rule does not resolve — fail closed
        // (same treatment Reflect.apply already gets).
        if (callee.type === 'MemberExpression') {
          const indirect = staticPropertyName(callee.property, callee.computed);
          if (
            indirect === 'call' ||
            indirect === 'apply' ||
            indirect === 'bind'
          ) {
            const innerName = rightmostObjectName(callee.object);
            if (innerName === 'eval') {
              // The forwarded argument is code, not a specifier.
              reportUnknown(node);
              return;
            }
            if (innerName === 'getBuiltinModule') {
              if (node.arguments.length > 0) {
                reportUnknown(node, 'moduleBuiltin');
              }
              return;
            }
            if (
              /^(?:require|fork|mock|doMock|importActual|importMock)$/.test(
                innerName ?? '',
              )
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
        // closed like computed sources. `.constructor` is only a code
        // shape when called WITH a string argument; eval/Function fail
        // closed on any argument.
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
            const stringCode =
              (first.type === 'Literal' && typeof first.value === 'string') ||
              (first.type === 'TemplateLiteral' &&
                staticTemplateValue(first) !== undefined);
            if (stringCode) reportUnknown(node);
          } else {
            reportUnknown(node);
          }
          return;
        }

        // node:vm string-execution surface — runInThisContext /
        // runInNewContext / runInContext / compileFunction compile or run
        // arbitrary string code. Scoped to vm imports (default/namespace
        // objects and renamed named imports) plus the bare `vm` name.
        if (node.arguments.length > 0) {
          const vmObjectName =
            callee.type === 'MemberExpression'
              ? rightmostObjectName(callee.object)
              : undefined;
          const vmProperty =
            callee.type === 'MemberExpression'
              ? staticPropertyName(callee.property, callee.computed)
              : undefined;
          if (
            (vmProperty !== undefined &&
              vmExecNames.test(vmProperty) &&
              vmObjectName !== undefined &&
              vmObjectNames.has(vmObjectName)) ||
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
        // `global.process` in every statically resolvable property
        // spelling; builtinModuleProperty likewise; the bare identifier
        // is the destructured spelling; Reflect indirection is unwrapped
        // below.
        if (
          (callee.type === 'MemberExpression' &&
            isProcessObject(callee.object) &&
            builtinModuleProperty(callee)) ||
          (callee.type === 'Identifier' && callee.name === 'getBuiltinModule')
        ) {
          reportUnknown(node, 'moduleBuiltin');
          return;
        }

        // Reflect.apply / Reflect.construct with a guarded target: the
        // arguments travel inside an array this rule does not resolve —
        // fail closed (the getBuiltinModule target keeps its messageId).
        if (memberCall(callee, ['Reflect'], /^(?:apply|construct)$/)) {
          const target = node.arguments[0];
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
          } else if (
            targetMember
              ? /^(?:fork|eval)$/.test(targetName ?? '')
              : /^(?:require|eval|fork)$/.test(targetName ?? '') ||
                targetName === 'Worker' ||
                workerAliases.has(targetName ?? '') ||
                forkAliases.has(targetName ?? '')
          ) {
            reportUnknown(node);
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
        const callee =
          node.callee.type === 'SequenceExpression'
            ? node.callee.expressions[node.callee.expressions.length - 1]
            : node.callee;

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
        // compilation, same class as Function (vm import spellings).
        if (
          node.arguments.length > 0 &&
          ((callee.type === 'MemberExpression' &&
            staticPropertyName(callee.property, callee.computed) === 'Script' &&
            vmObjectNames.has(rightmostObjectName(callee.object) ?? '')) ||
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
          // not as a specifier. Fail closed unless the option is
          // statically false (a dynamic option or a non-object second
          // argument cannot be verified).
          const opts = node.arguments[1];
          if (opts) {
            const evalProp =
              opts.type === 'ObjectExpression' &&
              opts.properties.find(
                (property) =>
                  property.type === 'Property' &&
                  staticPropertyName(property.key, property.computed) ===
                    'eval',
              );
            const staticallyFalse =
              evalProp &&
              evalProp.value.type === 'Literal' &&
              evalProp.value.value === false;
            if (!staticallyFalse) {
              reportUnknown(node);
              return;
            }
          }
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
            arg.arguments[1].type === 'MemberExpression' &&
            arg.arguments[1].object.type === 'MetaProperty' &&
            staticPropertyName(
              arg.arguments[1].property,
              arg.arguments[1].computed,
            ) === 'url';
          if (!handledByUrlArm) checkSource(arg);
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
