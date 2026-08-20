/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import fs from 'node:fs';
import path from 'node:path';
import type {
  TrustedPackageEntry,
  TrustedPackageFile,
  TrustedPackagePolicyEntry,
} from './protocol.js';

const PACKAGE_NAME_PATTERN =
  /^(?:@[A-Za-z0-9][A-Za-z0-9._~-]*\/)?[A-Za-z0-9][A-Za-z0-9._~-]*$/;
const SHA256_PATTERN = /^[a-f0-9]{64}$/i;

function canonicalizeFuturePath(filePath: string): string {
  let existingPrefix = filePath;
  const missingSegments: string[] = [];
  while (true) {
    try {
      return path.join(fs.realpathSync(existingPrefix), ...missingSegments);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      const parent = path.dirname(existingPrefix);
      if (parent === existingPrefix) throw error;
      missingSegments.unshift(path.basename(existingPrefix));
      existingPrefix = parent;
    }
  }
}

/**
 * Host-side security policy for the node_repl runtime.
 *
 * Trust is decided ONLY here: a package is trusted iff its module root,
 * canonical package target, package name, entry path, and every loaded-file
 * sha256 match a host-configured entry.
 * Model code and model-supplied paths (node_repl_add_node_module_dir) can
 * never create or widen privilege — they only add ordinary resolution roots.
 *
 * Phase 1 ships with an empty trusted set. Activating this generic mechanism
 * later requires an explicit host policy. SDKs use normal package loading.
 */
export class NodeReplSecurityPolicy {
  private readonly trusted: TrustedPackageEntry[];

  constructor(trustedPackages: TrustedPackagePolicyEntry[] = []) {
    this.trusted = trustedPackages.map((entry) =>
      this.normalizeTrustedPackage(entry),
    );
    if (
      new Set(this.trusted.map((entry) => entry.packageName)).size !==
      this.trusted.length
    ) {
      throw new Error('duplicate trusted package identity');
    }
  }

  static default(): NodeReplSecurityPolicy {
    return new NodeReplSecurityPolicy([]);
  }

  getTrustedPackages(): TrustedPackageEntry[] {
    return this.trusted.map((entry) => ({
      ...entry,
      additionalFiles: entry.additionalFiles.map((file) => ({ ...file })),
    }));
  }

  /**
   * Validate a module root path supplied via node_repl_add_node_module_dir.
   * Existing roots are canonicalized; a not-yet-created node_modules path is
   * retained so package installation can happen after registration.
   */
  validateModuleRoot(rawPath: string): string {
    if (typeof rawPath !== 'string' || rawPath.trim().length === 0) {
      throw new Error('path must be a non-empty string');
    }
    if (!path.isAbsolute(rawPath)) {
      throw new Error(`path must be absolute, got: ${rawPath}`);
    }
    const normalized = path.resolve(rawPath);
    if (path.basename(normalized).toLowerCase() !== 'node_modules') {
      throw new Error(
        `path must identify a node_modules directory: ${rawPath}`,
      );
    }
    let real: string;
    try {
      real = fs.realpathSync(normalized);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') {
        return canonicalizeFuturePath(normalized);
      }
      throw new Error(`cannot resolve directory: ${rawPath}`);
    }
    let stat: fs.Stats;
    try {
      stat = fs.statSync(real);
    } catch {
      throw new Error(`directory does not exist: ${rawPath}`);
    }
    if (!stat.isDirectory()) {
      throw new Error(`path is not a directory: ${rawPath}`);
    }
    return real;
  }

  private normalizeTrustedPackage(
    entry: TrustedPackagePolicyEntry,
  ): TrustedPackageEntry {
    const root = this.validateModuleRoot(entry.root);
    if (!this.isValidPackageName(entry.packageName)) {
      throw new Error(`invalid trusted package name: ${entry.packageName}`);
    }
    if (!SHA256_PATTERN.test(entry.entrySha256)) {
      throw new Error(
        `trusted package ${entry.packageName} must provide a sha256 digest`,
      );
    }
    const packageDir = path.resolve(root, entry.packageName);
    const relative = path.relative(root, packageDir);
    if (
      relative.startsWith('..') ||
      path.isAbsolute(relative) ||
      relative.length === 0
    ) {
      throw new Error(
        `trusted package escapes its module root: ${entry.packageName}`,
      );
    }
    let canonicalPackageDir: string;
    let entryPath: string;
    try {
      canonicalPackageDir = fs.realpathSync(packageDir);
      entryPath = fs.realpathSync(entry.entryPath);
    } catch {
      throw new Error(
        `trusted package entry does not exist: ${entry.packageName}`,
      );
    }
    if (
      !path.isAbsolute(entry.entryPath) ||
      !fs.statSync(canonicalPackageDir).isDirectory() ||
      !fs.statSync(entryPath).isFile() ||
      !this.isUnder(entryPath, canonicalPackageDir)
    ) {
      throw new Error(
        `trusted package entry escapes its package directory: ${entry.packageName}`,
      );
    }
    const additionalFiles = (entry.additionalFiles ?? []).map((file) =>
      this.normalizeTrustedFile(file, canonicalPackageDir, entry.packageName),
    );
    const filePaths = new Set<string>([entryPath]);
    for (const file of additionalFiles) {
      if (filePaths.has(file.path)) {
        throw new Error(
          `trusted package ${entry.packageName} contains a duplicate trusted file: ${file.path}`,
        );
      }
      filePaths.add(file.path);
    }
    return {
      root,
      packageName: entry.packageName,
      packageDir: canonicalPackageDir,
      entryPath,
      entrySha256: entry.entrySha256.toLowerCase(),
      additionalFiles,
    };
  }

  private normalizeTrustedFile(
    file: TrustedPackageFile,
    packageDir: string,
    packageName: string,
  ): TrustedPackageFile {
    if (!path.isAbsolute(file.path) || !SHA256_PATTERN.test(file.sha256)) {
      throw new Error(
        `trusted package ${packageName} must pin each additional file by absolute path and sha256`,
      );
    }
    let canonical: string;
    try {
      canonical = fs.realpathSync(file.path);
    } catch {
      throw new Error(
        `trusted package file does not exist: ${packageName}: ${file.path}`,
      );
    }
    if (
      !fs.statSync(canonical).isFile() ||
      !this.isUnder(canonical, packageDir)
    ) {
      throw new Error(
        `trusted package file escapes its package directory: ${packageName}: ${file.path}`,
      );
    }
    return { path: canonical, sha256: file.sha256.toLowerCase() };
  }

  private isValidPackageName(packageName: string): boolean {
    return (
      typeof packageName === 'string' &&
      packageName.length <= 214 &&
      PACKAGE_NAME_PATTERN.test(packageName)
    );
  }

  private isUnder(child: string, parent: string): boolean {
    const relative = path.relative(parent, child);
    return (
      relative === '' ||
      (!relative.startsWith('..') && !path.isAbsolute(relative))
    );
  }
}
