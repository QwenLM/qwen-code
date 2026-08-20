/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import vm from 'node:vm';
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { createHash } from 'node:crypto';
import { builtinModules } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';

const MAX_MODULE_SOURCE_BYTES = 32 * 1024 * 1024;
const MAX_PACKAGE_JSON_BYTES = 1024 * 1024;
const BUILTINS = new Set([
  ...builtinModules,
  ...builtinModules.map((name) => `node:${name}`),
]);

export function createModuleLoader(options) {
  const {
    untrustedContext,
    trustedContext,
    cwd,
    moduleRoots,
    trustedPackages,
    readableRoots,
    onTrustedModuleLoad,
  } = options;

  const trustedCache = new Map();
  const trustedByName = new Map(
    trustedPackages.map((entry) => [entry.packageName, entry]),
  );
  const cellBaseDir = fs.realpathSync(cwd);
  const realmErrors = new Map([
    [untrustedContext, vm.runInContext('Error', untrustedContext)],
    [trustedContext, vm.runInContext('Error', trustedContext)],
  ]);

  function realmError(context, error) {
    let message = 'module loading failed';
    try {
      message = String(error?.message ?? error);
    } catch {
      // Keep the context-owned fallback.
    }
    const ErrorConstructor = realmErrors.get(context);
    return new ErrorConstructor(message);
  }

  async function importDynamicSafely(specifier, record) {
    try {
      return await importDynamic(specifier, record);
    } catch (error) {
      throw realmError(record.context, error);
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

  function allowedRoots(extraRoots = []) {
    const roots = [];
    for (const candidate of [...readableRoots, ...moduleRoots, ...extraRoots]) {
      try {
        const real = canonicalDirectory(candidate);
        if (sameCanonicalPath(candidate, real)) roots.push(real);
      } catch {
        // A removed root simply stops resolving new imports.
      }
    }
    return roots;
  }

  function assertReadable(filePath, extraRoots = []) {
    let real;
    try {
      real = fs.realpathSync(filePath);
    } catch {
      throw new Error(`module file not found: ${filePath}`);
    }
    if (!allowedRoots(extraRoots).some((root) => isUnder(real, root))) {
      throw new Error(`import is outside the allowed roots: ${filePath}`);
    }
    const stat = fs.statSync(real);
    if (!stat.isFile()) throw new Error(`module is not a file: ${filePath}`);
    if (stat.size > MAX_MODULE_SOURCE_BYTES) {
      throw new Error(
        `module exceeds the ${MAX_MODULE_SOURCE_BYTES}-byte source limit: ${filePath}`,
      );
    }
    return real;
  }

  function assertCandidateReadable(candidate, extraRoots = []) {
    const resolved = path.resolve(candidate);
    let canonicalCandidate = resolved;
    try {
      canonicalCandidate = path.join(
        fs.realpathSync(path.dirname(resolved)),
        path.basename(resolved),
      );
    } catch {
      // The boundary check below remains fail-closed.
    }
    if (
      !allowedRoots(extraRoots).some((root) =>
        isUnder(canonicalCandidate, root),
      )
    ) {
      throw new Error(`import is outside the allowed roots: ${candidate}`);
    }
  }

  function readJson(filePath, extraRoots = []) {
    let real;
    try {
      real = fs.realpathSync(filePath);
    } catch {
      throw new Error(`invalid package.json: ${filePath}`);
    }
    if (!allowedRoots(extraRoots).some((root) => isUnder(real, root))) {
      throw new Error(`package.json is outside the allowed roots: ${filePath}`);
    }
    const stat = fs.statSync(real);
    if (!stat.isFile() || stat.size > MAX_PACKAGE_JSON_BYTES) {
      throw new Error(`invalid package.json: ${filePath}`);
    }
    return JSON.parse(fs.readFileSync(real, 'utf8'));
  }

  function resolveFileCandidate(candidate) {
    const attempts = [
      candidate,
      `${candidate}.js`,
      `${candidate}.mjs`,
      path.join(candidate, 'index.js'),
      path.join(candidate, 'index.mjs'),
    ];
    for (const attempt of attempts) {
      try {
        if (fs.statSync(attempt).isFile()) return attempt;
      } catch {
        // Continue resolving.
      }
    }
    throw new Error(`cannot resolve ESM module: ${candidate}`);
  }

  function nearestPackageType(filePath, extraRoots = []) {
    let directory = path.dirname(filePath);
    for (let depth = 0; depth < 40; depth++) {
      const packageJson = path.join(directory, 'package.json');
      try {
        return readJson(packageJson, extraRoots).type === 'module'
          ? 'module'
          : 'commonjs';
      } catch {
        // Keep walking.
      }
      const parent = path.dirname(directory);
      if (parent === directory) break;
      directory = parent;
    }
    return 'commonjs';
  }

  function assertEsm(filePath, localDefaultEsm, extraRoots = []) {
    if (filePath.endsWith('.mjs')) return;
    if (filePath.endsWith('.js')) {
      if (
        localDefaultEsm ||
        nearestPackageType(filePath, extraRoots) === 'module'
      ) {
        return;
      }
      throw new Error(
        `CommonJS is not supported by node_repl; ${filePath} is not in a type=module package`,
      );
    }
    throw new Error(`node_repl imports only .js and .mjs ESM: ${filePath}`);
  }

  function parseBareSpecifier(specifier) {
    const parts = specifier.split('/');
    const packageName = specifier.startsWith('@')
      ? parts.slice(0, 2).join('/')
      : parts[0];
    const remainder = specifier.slice(packageName.length);
    return {
      packageName,
      subpath: remainder.length > 0 ? `.${remainder}` : '.',
    };
  }

  function pickExportTarget(value) {
    if (typeof value === 'string') return value;
    if (Array.isArray(value)) {
      for (const candidate of value) {
        const target = pickExportTarget(candidate);
        if (target) return target;
      }
      return null;
    }
    if (value && typeof value === 'object') {
      for (const condition of ['import', 'default']) {
        if (!(condition in value)) continue;
        const target = pickExportTarget(value[condition]);
        if (target) return target;
      }
    }
    return null;
  }

  function resolvePackageEntry(packageDir, subpath, packageJson) {
    const resolveInsidePackage = (target) => {
      const candidate = path.resolve(packageDir, target);
      if (!isUnder(candidate, packageDir)) {
        throw new Error('package target escapes its package directory');
      }
      return resolveFileCandidate(candidate);
    };
    if (packageJson.exports !== undefined) {
      const exportsField = packageJson.exports;
      let selected = exportsField;
      if (
        exportsField &&
        typeof exportsField === 'object' &&
        !Array.isArray(exportsField)
      ) {
        const keys = Object.keys(exportsField);
        if (keys.some((key) => key.startsWith('.'))) {
          selected = exportsField[subpath];
        } else if (subpath !== '.') {
          selected = undefined;
        }
      } else if (subpath !== '.') {
        selected = undefined;
      }
      const target = pickExportTarget(selected);
      if (!target || !target.startsWith('./')) {
        throw new Error(
          `package subpath '${subpath}' has no supported ESM export`,
        );
      }
      return resolveInsidePackage(target);
    }
    if (subpath !== '.') {
      return resolveInsidePackage(subpath.slice(2));
    }
    return resolveInsidePackage(
      packageJson.module ?? packageJson.main ?? 'index.js',
    );
  }

  function trustedFilePolicy(packagePolicy, filePath) {
    if (sameCanonicalPath(filePath, packagePolicy.entryPath)) {
      return {
        path: packagePolicy.entryPath,
        sha256: packagePolicy.entrySha256,
      };
    }
    return packagePolicy.additionalFiles.find((file) =>
      sameCanonicalPath(file.path, filePath),
    );
  }

  function verifiedTrustedSource(packagePolicy, filePath) {
    const filePolicy = trustedFilePolicy(packagePolicy, filePath);
    if (!filePolicy) {
      throw new Error(
        `trusted package '${packagePolicy.packageName}' imported an unapproved file`,
      );
    }
    const sourceBytes = fs.readFileSync(filePath);
    const digest = createHash('sha256').update(sourceBytes).digest('hex');
    if (digest !== filePolicy.sha256) {
      throw new Error(
        `trusted package '${packagePolicy.packageName}' failed sha256 verification for an approved file`,
      );
    }
    return { source: sourceBytes.toString('utf8'), digest };
  }

  function trustedOwner(filePath) {
    return trustedPackages.find((entry) => isUnder(filePath, entry.packageDir));
  }

  function resolveBare(specifier) {
    const { packageName, subpath } = parseBareSpecifier(specifier);
    const configuredTrust = trustedByName.get(packageName);
    const configuredRoots = configuredTrust
      ? [configuredTrust.root]
      : moduleRoots;
    for (const configuredRoot of configuredRoots) {
      let root;
      try {
        root = canonicalDirectory(configuredRoot);
      } catch {
        continue;
      }
      if (!sameCanonicalPath(configuredRoot, root)) {
        if (configuredTrust) {
          throw new Error(`trusted package root changed: ${packageName}`);
        }
        continue;
      }
      const packageDirCandidate = path.resolve(root, packageName);
      let packageDir;
      try {
        packageDir = canonicalDirectory(packageDirCandidate);
      } catch {
        continue;
      }
      if (
        sameCanonicalPath(packageDir, root) ||
        (configuredTrust
          ? !sameCanonicalPath(packageDir, configuredTrust.packageDir)
          : !isUnder(packageDir, root))
      ) {
        if (configuredTrust) {
          throw new Error(`trusted package directory changed: ${packageName}`);
        }
        continue;
      }

      let packageJson;
      try {
        packageJson = readJson(
          path.join(packageDir, 'package.json'),
          configuredTrust ? [configuredTrust.packageDir] : [],
        );
      } catch {
        continue;
      }
      const entry = assertReadable(
        resolvePackageEntry(packageDir, subpath, packageJson),
        configuredTrust ? [configuredTrust.packageDir] : [],
      );
      if (!isUnder(entry, packageDir)) {
        throw new Error(
          `package export escapes its package directory: ${specifier}`,
        );
      }
      assertEsm(
        entry,
        false,
        configuredTrust ? [configuredTrust.packageDir] : [],
      );

      if (!configuredTrust) {
        if (trustedOwner(entry)) {
          throw new Error(
            'trusted package files require an approved package import',
          );
        }
        return {
          filePath: entry,
          trusted: false,
          localDefaultEsm: false,
        };
      }
      if (subpath !== '.') {
        throw new Error(
          `trusted package subpath '${subpath}' is not approved by the host`,
        );
      }
      if (!sameCanonicalPath(entry, configuredTrust.entryPath)) {
        throw new Error(
          `trusted package '${packageName}' resolved an unapproved entry path`,
        );
      }
      const verified = verifiedTrustedSource(configuredTrust, entry);
      return {
        filePath: entry,
        trusted: true,
        localDefaultEsm: false,
        packageName,
        packageDir: configuredTrust.packageDir,
        packagePolicy: configuredTrust,
        packageVersion:
          typeof packageJson.version === 'string' ? packageJson.version : null,
        moduleSha256: verified.digest,
        trustedSource: verified.source,
      };
    }
    throw new Error(
      `cannot resolve package '${specifier}' from ${configuredRoots.length} module roots`,
    );
  }

  function resolveSpecifier(specifier, referencingRecord) {
    if (specifier === '@prev') {
      throw new Error('@prev is available only to the generated REPL cell');
    }
    if (BUILTINS.has(specifier)) {
      throw new Error(
        `Node builtin '${specifier}' is not available in node_repl modules`,
      );
    }
    if (specifier.startsWith('file:')) specifier = fileURLToPath(specifier);
    if (
      specifier.startsWith('./') ||
      specifier.startsWith('../') ||
      path.isAbsolute(specifier)
    ) {
      const candidate = path.resolve(referencingRecord.baseDir, specifier);
      if (referencingRecord.trusted) {
        const packagePolicy = referencingRecord.packagePolicy;
        if (!packagePolicy || !isUnder(candidate, packagePolicy.packageDir)) {
          throw new Error(
            `trusted import is outside its package: ${specifier}`,
          );
        }
        const filePath = assertReadable(resolveFileCandidate(candidate), [
          packagePolicy.packageDir,
        ]);
        if (!isUnder(filePath, packagePolicy.packageDir)) {
          throw new Error(
            `trusted import is outside its package: ${specifier}`,
          );
        }
        assertEsm(filePath, false, [packagePolicy.packageDir]);
        const verified = verifiedTrustedSource(packagePolicy, filePath);
        return {
          filePath,
          trusted: true,
          localDefaultEsm: false,
          packageName: packagePolicy.packageName,
          packageDir: packagePolicy.packageDir,
          packagePolicy,
          packageVersion: referencingRecord.packageVersion,
          moduleSha256: verified.digest,
          trustedSource: verified.source,
        };
      }
      assertCandidateReadable(candidate);
      const filePath = assertReadable(resolveFileCandidate(candidate));
      if (trustedOwner(filePath)) {
        throw new Error(
          'trusted package files require an approved package import',
        );
      }
      assertEsm(filePath, referencingRecord.localDefaultEsm);
      return {
        filePath,
        trusted: false,
        localDefaultEsm: referencingRecord.localDefaultEsm,
      };
    }
    if (referencingRecord.trusted) {
      throw new Error(
        `trusted package '${referencingRecord.packagePolicy.packageName}' cannot import bare dependency '${specifier}'`,
      );
    }
    return resolveBare(specifier);
  }

  function contextFor(resolved) {
    return resolved.trusted ? trustedContext : untrustedContext;
  }

  function cacheFor(resolved, scope) {
    if (resolved.trusted) return trustedCache;
    return scope;
  }

  function constructRecord(resolved, scope) {
    const cache = cacheFor(resolved, scope);
    const key = `${resolved.trusted ? 'T' : 'U'}:${resolved.filePath}`;
    const cached = cache.get(key);
    if (cached) return cached;

    const context = contextFor(resolved);
    const source =
      resolved.trustedSource ?? fs.readFileSync(resolved.filePath, 'utf8');
    const identifier = pathToFileURL(resolved.filePath).href;
    const record = {
      module: null,
      context,
      filePath: resolved.filePath,
      baseDir: path.dirname(resolved.filePath),
      trusted: resolved.trusted,
      packagePolicy: resolved.packagePolicy ?? null,
      packageVersion: resolved.packageVersion ?? null,
      localDefaultEsm: resolved.localDefaultEsm,
      scope,
      evaluatePromise: null,
    };
    record.module = new vm.SourceTextModule(source, {
      context,
      identifier,
      initializeImportMeta(meta) {
        meta.url = identifier;
      },
      importModuleDynamically: (specifier) =>
        importDynamicSafely(specifier, record),
    });
    cache.set(key, record);
    if (resolved.trusted) {
      onTrustedModuleLoad({
        packageName: resolved.packageName,
        modulePath: resolved.filePath,
        version: resolved.packageVersion,
        moduleSha256: resolved.moduleSha256,
      });
    }
    return record;
  }

  function syntheticFromNamespace(namespace, context, identifier) {
    const keys = Object.keys(namespace);
    return new vm.SyntheticModule(
      keys,
      function initialize() {
        for (const key of keys) this.setExport(key, namespace[key]);
      },
      { context, identifier },
    );
  }

  async function linker(specifier, referencingRecord, previousModule) {
    if (specifier === '@prev' && previousModule) return previousModule;
    const resolved = resolveSpecifier(specifier, referencingRecord);
    const record = constructRecord(resolved, referencingRecord.scope);
    if (record.context === referencingRecord.context) return record.module;

    await evaluateRecord(record);
    return syntheticFromNamespace(
      record.module.namespace,
      referencingRecord.context,
      `${record.module.identifier}#bridge`,
    );
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
    const record = constructRecord(resolved, referencingRecord.scope);
    await evaluateRecord(record);
    if (record.context === referencingRecord.context) return record.module;

    const bridge = syntheticFromNamespace(
      record.module.namespace,
      referencingRecord.context,
      `${record.module.identifier}#dynamic-bridge`,
    );
    await bridge.link(() => {
      throw new Error('namespace bridge has no imports');
    });
    await bridge.evaluate();
    return bridge;
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
      filePath: null,
      baseDir: cellBaseDir,
      trusted: false,
      packagePolicy: null,
      packageVersion: null,
      localDefaultEsm: true,
      scope: cellCache,
      evaluatePromise: null,
    };
    record.module = new vm.SourceTextModule(source, {
      context: untrustedContext,
      identifier,
      initializeImportMeta(meta) {
        meta.url = identifier;
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
