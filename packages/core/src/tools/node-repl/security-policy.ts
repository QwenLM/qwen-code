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

/**
 * Host-side security policy for the node_repl runtime.
 *
 * Trust is decided ONLY here: a package is trusted iff its module root,
 * canonical package target, package name, entry path, and every loaded-file
 * sha256 match a host-configured entry. Package dependency edges and direct
 * model visibility are separate host-only allowlists.
 * Model code and model-supplied paths (node_repl_add_node_module_dir) can
 * never create or widen trust — they only add *untrusted* resolution roots.
 *
 * Phase 1 ships with an empty trusted set; the mechanism exists and is
 * tested so phase 2 can register real SDK packages without redesign.
 */
export class NodeReplSecurityPolicy {
  private readonly trusted: TrustedPackageEntry[];

  constructor(trustedPackages: TrustedPackagePolicyEntry[] = []) {
    this.trusted = trustedPackages.map((entry) =>
      this.normalizeTrustedPackage(entry),
    );
    const names = new Set(this.trusted.map((entry) => entry.packageName));
    if (names.size !== this.trusted.length) {
      throw new Error('duplicate trusted package identity');
    }
    for (const entry of this.trusted) {
      for (const dependency of entry.dependencies) {
        if (!names.has(dependency)) {
          throw new Error(
            `trusted package ${entry.packageName} declares unknown dependency: ${dependency}`,
          );
        }
      }
    }
  }

  static default(): NodeReplSecurityPolicy {
    return new NodeReplSecurityPolicy([]);
  }

  getTrustedPackages(): TrustedPackageEntry[] {
    return this.trusted.map((entry) => ({
      ...entry,
      additionalFiles: entry.additionalFiles.map((file) => ({ ...file })),
      dependencies: [...entry.dependencies],
    }));
  }

  /**
   * Validate a module root path supplied via node_repl_add_node_module_dir.
   * Returns the resolved real path, or throws with a user-facing message.
   * Granting a root only widens *untrusted* resolution — never trust.
   */
  validateModuleRoot(rawPath: string): string {
    if (typeof rawPath !== 'string' || rawPath.trim().length === 0) {
      throw new Error('path must be a non-empty string');
    }
    if (!path.isAbsolute(rawPath)) {
      throw new Error(`path must be absolute, got: ${rawPath}`);
    }
    let real: string;
    try {
      real = fs.realpathSync(rawPath);
    } catch {
      throw new Error(`directory does not exist: ${rawPath}`);
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
    if (path.basename(real).toLowerCase() !== 'node_modules') {
      throw new Error(
        `path must identify a node_modules directory: ${rawPath}`,
      );
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
    const dependencies = [...(entry.dependencies ?? [])];
    const dependencyNames = new Set<string>();
    for (const dependency of dependencies) {
      if (
        !this.isValidPackageName(dependency) ||
        dependency === entry.packageName
      ) {
        throw new Error(
          `invalid trusted dependency for ${entry.packageName}: ${dependency}`,
        );
      }
      if (dependencyNames.has(dependency)) {
        throw new Error(
          `duplicate trusted dependency for ${entry.packageName}: ${dependency}`,
        );
      }
      dependencyNames.add(dependency);
    }
    return {
      root,
      packageName: entry.packageName,
      packageDir: canonicalPackageDir,
      entryPath,
      entrySha256: entry.entrySha256.toLowerCase(),
      additionalFiles,
      dependencies,
      allowModelImport: entry.allowModelImport === true,
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
