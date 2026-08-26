/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import vm from 'node:vm';
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { builtinModules, createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';

const MAX_MODULE_SOURCE_BYTES = 32 * 1024 * 1024;
const MAX_PACKAGE_JSON_BYTES = 1024 * 1024;
const BUILTINS = new Set([
  ...builtinModules,
  ...builtinModules.map((name) => `node:${name}`),
]);
const DENIED_BUILTINS = new Set(['process', 'node:process']);
const IMPORT_CONDITIONS = new Set(['node', 'import']);

export function createModuleLoader(options) {
  const { untrustedContext, cwd, moduleRoots, readableRoots } = options;

  const nativeModuleCaches = new WeakMap();
  const nativeNamespaceCache = new Map();
  const requireByBase = new Map();
  const cellBaseDir = fs.realpathSync(cwd);
  // Errors thrown into the cell must be constructed with the cell realm's Error
  // so `catch (e) { e instanceof Error }` holds inside the VM.
  const realmErrorConstructor = vm.runInContext('Error', untrustedContext);

  function realmError(error) {
    let message = 'module loading failed';
    try {
      message = String(error?.message ?? error);
    } catch {
      // Keep the context-owned fallback.
    }
    const wrapped = new realmErrorConstructor(message);
    // Carry over the diagnostically useful fields so a host-realm error thrown
    // by imported code (e.g. an fs ENOENT) does not collapse to message-only:
    // `catch (e) { if (e.code === 'ENOENT') ... }` is a ubiquitous Node idiom.
    try {
      if (error && typeof error === 'object') {
        if (typeof error.name === 'string') wrapped.name = error.name;
        if (error.code !== undefined) wrapped.code = error.code;
        if (error.errno !== undefined) wrapped.errno = error.errno;
        if (error.syscall !== undefined) wrapped.syscall = error.syscall;
        if (error.cause !== undefined) wrapped.cause = error.cause;
        if (typeof error.stack === 'string') wrapped.stack = error.stack;
      }
    } catch {
      // A hostile getter must not defeat error wrapping.
    }
    return wrapped;
  }

  async function importDynamicSafely(specifier, record) {
    try {
      return await importDynamic(specifier, record);
    } catch (error) {
      // A throw from the imported module's own code is already a cell-realm
      // value: rethrow it untouched so its class, `code`, custom properties and
      // stack survive. Only loader-originated (host-realm) failures get
      // rewrapped, so that `catch (e) { e instanceof Error }` holds in the cell.
      if (error instanceof realmErrorConstructor) throw error;
      throw realmError(error);
    }
  }

  function isUnder(child, parent) {
    const relative = path.relative(parent, child);
    return (
      relative === '' ||
      (!relative.startsWith('..') && !path.isAbsolute(relative))
    );
  }

  function canonicalDirectory(directory) {
    const real = fs.realpathSync(directory);
    if (!fs.statSync(real).isDirectory()) {
      throw new Error(`not a directory: ${directory}`);
    }
    return real;
  }

  function sameCanonicalPath(left, right) {
    const normalizedLeft = path.resolve(left);
    const normalizedRight = path.resolve(right);
    return process.platform === 'win32'
      ? normalizedLeft.toLowerCase() === normalizedRight.toLowerCase()
      : normalizedLeft === normalizedRight;
  }

  function toNodeBuiltinSpecifier(specifier) {
    return specifier.startsWith('node:') ? specifier : `node:${specifier}`;
  }

  function isDeniedBuiltin(specifier) {
    const normalized = specifier.startsWith('node:')
      ? specifier.slice(5)
      : specifier;
    return DENIED_BUILTINS.has(specifier) || DENIED_BUILTINS.has(normalized);
  }

  function moduleSearchRoots() {
    const roots = [];
    for (const candidate of moduleRoots) {
      try {
        const real = canonicalDirectory(candidate.path);
        if (
          sameCanonicalPath(candidate.canonicalPath, real) &&
          !roots.some((root) => sameCanonicalPath(root.canonicalPath, real))
        ) {
          roots.push({ path: candidate.path, canonicalPath: real });
        }
      } catch {
        // Missing search roots do not participate in resolution.
      }
    }
    const cwdRoot = path.join(cellBaseDir, 'node_modules');
    // Only apply the implicit zero-config root when the cwd node_modules is not
    // itself a registered root: a registered entry carries a canonical baseline
    // and its own re-link/revocation guard above, which the implicit branch
    // must not undermine by independently following a swapped symlink.
    const cwdRootIsRegistered = moduleRoots.some((candidate) => {
      try {
        // Canonicalize the stable parent, not node_modules itself: the root
        // may have been replaced, and following it here would erase the
        // registration-time identity that the branch above just rejected.
        const anchoredPath = path.join(
          canonicalDirectory(path.dirname(candidate.path)),
          path.basename(candidate.path),
        );
        return sameCanonicalPath(anchoredPath, cwdRoot);
      } catch {
        return false;
      }
    });
    if (!cwdRootIsRegistered) {
      try {
        // The implicit root has no registration-time baseline, so there is no
        // re-link to guard against — resolve it and use the real target
        // directly. Requiring cwdRoot === realpath(cwdRoot) wrongly dropped a
        // symlinked node_modules, which is the norm under pnpm / monorepo
        // hoisting / shared CI caches, breaking zero-config resolution.
        const real = canonicalDirectory(cwdRoot);
        if (
          !roots.some((root) => sameCanonicalPath(root.canonicalPath, real))
        ) {
          roots.push({ path: cwdRoot, canonicalPath: real });
        }
      } catch {
        // The working directory does not need to contain node_modules.
      }
    }
    return roots;
  }

  function getRequireForBase(base) {
    let require = requireByBase.get(base);
    if (!require) {
      require = createRequire(path.join(base, '__qwen_node_repl__.cjs'));
      requireByBase.set(base, require);
    }
    return require;
  }

  function resolveNativePackage(specifier) {
    const roots = moduleSearchRoots();
    const bases = roots.map((root) => path.dirname(root.path));

    let firstError = null;
    for (const base of [...new Set(bases)]) {
      try {
        const resolved = getRequireForBase(base).resolve(specifier, {
          conditions: IMPORT_CONDITIONS,
        });
        const canonical = fs.realpathSync(resolved);
        if (!roots.some((root) => isUnder(canonical, root.canonicalPath))) {
          continue;
        }
        return {
          kind: 'native',
          filePath: canonical,
          specifier,
        };
      } catch (error) {
        if (
          error?.code === 'MODULE_NOT_FOUND' ||
          error?.code === 'ERR_MODULE_NOT_FOUND'
        ) {
          continue;
        }
        firstError ??= error;
      }
    }
    if (firstError) throw firstError;
    throw new Error(
      `cannot resolve package '${specifier}' from ${roots.length} module roots`,
    );
  }

  function allowedRoots() {
    const roots = [];
    for (const candidate of [
      ...readableRoots,
      ...moduleRoots.map((root) => root.canonicalPath),
    ]) {
      try {
        const real = canonicalDirectory(candidate);
        if (sameCanonicalPath(candidate, real)) roots.push(real);
      } catch {
        // A removed root simply stops resolving new imports.
      }
    }
    return roots;
  }

  function resolveLocalSource(candidate, localDefaultEsm) {
    let filePath;
    try {
      filePath = fs.realpathSync(candidate);
    } catch {
      throw new Error(`module file not found: ${candidate}`);
    }
    const stat = fs.statSync(filePath);
    if (!stat.isFile()) throw new Error(`module is not a file: ${candidate}`);
    if (stat.size > MAX_MODULE_SOURCE_BYTES) {
      throw new Error(
        `module exceeds the ${MAX_MODULE_SOURCE_BYTES}-byte source limit: ${candidate}`,
      );
    }
    assertEsm(filePath, localDefaultEsm);
    return filePath;
  }

  function readJson(filePath) {
    let real;
    try {
      real = fs.realpathSync(filePath);
    } catch {
      throw new Error(`invalid package.json: ${filePath}`);
    }
    if (!allowedRoots().some((root) => isUnder(real, root))) {
      throw new Error(`package.json is outside the allowed roots: ${filePath}`);
    }
    const stat = fs.statSync(real);
    if (!stat.isFile() || stat.size > MAX_PACKAGE_JSON_BYTES) {
      throw new Error(`invalid package.json: ${filePath}`);
    }
    return JSON.parse(fs.readFileSync(real, 'utf8'));
  }

  function nearestPackageType(filePath) {
    let directory = path.dirname(filePath);
    for (let depth = 0; depth < 40; depth++) {
      const packageJson = path.join(directory, 'package.json');
      try {
        return readJson(packageJson).type === 'module' ? 'module' : 'commonjs';
      } catch {
        // Keep walking.
      }
      const parent = path.dirname(directory);
      if (parent === directory) break;
      directory = parent;
    }
    return 'commonjs';
  }

  function assertEsm(filePath, localDefaultEsm) {
    if (filePath.endsWith('.mjs')) return;
    if (filePath.endsWith('.js')) {
      if (localDefaultEsm || nearestPackageType(filePath) === 'module') {
        return;
      }
      throw new Error(
        `local CommonJS file imports are not supported; ${filePath} is not in a type=module package`,
      );
    }
    throw new Error(
      `node_repl local file imports only support .js and .mjs ESM: ${filePath}`,
    );
  }

  function resolveSpecifier(specifier, referencingRecord) {
    if (specifier === '@prev') {
      throw new Error('@prev is available only to the generated REPL cell');
    }
    if (BUILTINS.has(specifier)) {
      if (isDeniedBuiltin(specifier)) {
        throw new Error(
          `Importing module "${specifier}" is not allowed in node_repl`,
        );
      }
      return {
        kind: 'builtin',
        specifier: toNodeBuiltinSpecifier(specifier),
      };
    }
    if (specifier.startsWith('file:')) specifier = fileURLToPath(specifier);
    if (
      specifier.startsWith('./') ||
      specifier.startsWith('../') ||
      path.isAbsolute(specifier)
    ) {
      const candidate = path.resolve(referencingRecord.baseDir, specifier);
      const filePath = resolveLocalSource(
        candidate,
        referencingRecord.localDefaultEsm,
      );
      return {
        kind: 'source',
        filePath,
        localDefaultEsm: referencingRecord.localDefaultEsm,
      };
    }
    return resolveNativePackage(specifier);
  }

  function importTarget(resolved) {
    if (resolved.kind === 'builtin' || resolved.kind === 'native') {
      return resolved.specifier;
    }
    return pathToFileURL(resolved.filePath).href;
  }

  function initializeImportMeta(meta, record, isMain) {
    const filename = record.filePath;
    meta.url = pathToFileURL(filename).href;
    meta.filename = filename;
    meta.dirname = path.dirname(filename);
    meta.main = isMain;
    meta.resolve = (specifier) =>
      importTarget(resolveSpecifier(specifier, record));
  }

  function constructRecord(resolved, scope) {
    if (resolved.kind !== 'source') {
      throw new Error(`cannot construct source module for ${resolved.kind}`);
    }
    const cached = scope.get(resolved.filePath);
    if (cached) return cached;

    const context = untrustedContext;
    const source = fs.readFileSync(resolved.filePath, 'utf8');
    const identifier = pathToFileURL(resolved.filePath).href;
    const record = {
      module: null,
      context,
      filePath: resolved.filePath,
      baseDir: path.dirname(resolved.filePath),
      localDefaultEsm: resolved.localDefaultEsm,
      scope,
      evaluatePromise: null,
    };
    record.module = new vm.SourceTextModule(source, {
      context,
      identifier,
      initializeImportMeta(meta) {
        initializeImportMeta(meta, record, false);
      },
      importModuleDynamically: (specifier) =>
        importDynamicSafely(specifier, record),
    });
    scope.set(resolved.filePath, record);
    return record;
  }

  function syntheticFromNamespace(namespace, context, identifier) {
    const keys = Object.getOwnPropertyNames(namespace);
    return new vm.SyntheticModule(
      keys,
      function initialize() {
        for (const key of keys) this.setExport(key, namespace[key]);
      },
      { context, identifier },
    );
  }

  function nativeCacheFor(context) {
    let cache = nativeModuleCaches.get(context);
    if (!cache) {
      cache = new Map();
      nativeModuleCaches.set(context, cache);
    }
    return cache;
  }

  async function loadNativeNamespace(resolved) {
    const key =
      resolved.kind === 'builtin'
        ? `builtin:${resolved.specifier}`
        : `package:${resolved.filePath}`;
    let promise = nativeNamespaceCache.get(key);
    if (!promise) {
      promise =
        resolved.kind === 'builtin'
          ? import(resolved.specifier)
          : import(pathToFileURL(resolved.filePath).href);
      nativeNamespaceCache.set(key, promise);
      // Cache successes (Node singleton semantics) but evict failures, so a
      // transient error (mid-install, EMFILE, a since-fixed syntax error) does
      // not poison the specifier for the kernel's whole lifetime.
      promise.catch(() => {
        if (nativeNamespaceCache.get(key) === promise) {
          nativeNamespaceCache.delete(key);
        }
      });
    }
    return promise;
  }

  async function loadSyntheticModule(resolved, context) {
    const key =
      resolved.kind === 'builtin'
        ? `builtin:${resolved.specifier}`
        : `package:${resolved.filePath}`;
    const cache = nativeCacheFor(context);
    let promise = cache.get(key);
    if (!promise) {
      promise = (async () => {
        const namespace = await loadNativeNamespace(resolved);
        return syntheticFromNamespace(
          namespace,
          context,
          `qwen-node-repl:${key}`,
        );
      })();
      cache.set(key, promise);
      promise.catch(() => {
        if (cache.get(key) === promise) cache.delete(key);
      });
    }
    return promise;
  }

  async function linker(specifier, referencingRecord, previousModule) {
    if (specifier === '@prev' && previousModule) return previousModule;
    const resolved = resolveSpecifier(specifier, referencingRecord);
    if (resolved.kind === 'builtin' || resolved.kind === 'native') {
      return loadSyntheticModule(resolved, referencingRecord.context);
    }
    // Every record lives in the single cell context, so no cross-realm bridge
    // is needed here.
    return constructRecord(resolved, referencingRecord.scope).module;
  }

  async function evaluateRecord(record) {
    if (!record.evaluatePromise) {
      record.evaluatePromise = (async () => {
        if (record.module.status === 'unlinked') {
          await record.module.link((specifier) =>
            linker(specifier, record, null),
          );
        }
        if (record.module.status === 'linked') {
          await record.module.evaluate();
        } else if (record.module.status === 'errored') {
          throw record.module.error;
        }
      })();
    }
    await record.evaluatePromise;
    if (record.module.status === 'errored') throw record.module.error;
    return record;
  }

  async function importDynamic(specifier, referencingRecord) {
    const resolved = resolveSpecifier(specifier, referencingRecord);
    if (resolved.kind === 'builtin' || resolved.kind === 'native') {
      return loadNativeNamespace(resolved);
    }
    const record = constructRecord(resolved, referencingRecord.scope);
    await evaluateRecord(record);
    // Single cell context: the record's module is directly usable.
    return record.module;
  }

  function createPreviousModule(previousBindings) {
    const names = [...previousBindings.keys()].sort();
    return new vm.SyntheticModule(
      names,
      function initialize() {
        for (const name of names) {
          this.setExport(name, previousBindings.get(name).value);
        }
      },
      { context: untrustedContext, identifier: '@prev' },
    );
  }

  function createCell(source, identifier, previousBindings) {
    const cellCache = new Map();
    const previousModule = createPreviousModule(previousBindings);
    const record = {
      module: null,
      context: untrustedContext,
      filePath: identifier,
      baseDir: cellBaseDir,
      localDefaultEsm: true,
      scope: cellCache,
      evaluatePromise: null,
    };
    record.module = new vm.SourceTextModule(source, {
      context: untrustedContext,
      identifier,
      // The generated prelude occupies exactly one physical line before the
      // user's source, so shift reported line numbers back by one to match the
      // code the caller actually wrote. Keep in sync with cell-transform.ts,
      // which joins the prelude without newlines for this reason.
      lineOffset: -1,
      initializeImportMeta(meta) {
        initializeImportMeta(meta, record, true);
      },
      importModuleDynamically: (specifier) =>
        importDynamicSafely(specifier, record),
    });
    return {
      module: record.module,
      async evaluate() {
        await record.module.link((specifier) =>
          linker(specifier, record, previousModule),
        );
        await record.module.evaluate();
      },
    };
  }

  return Object.freeze({ createCell });
}
