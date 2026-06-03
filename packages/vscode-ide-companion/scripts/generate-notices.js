/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const projectRoot = path.resolve(
  path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..'),
);
const packagePath = path.join(projectRoot, 'packages', 'vscode-ide-companion');
const noticeFilePath = path.join(packagePath, 'NOTICES.txt');

/**
 * Read license information for a dependency from its on-disk location.
 *
 * @param {string} depName - Package name
 * @param {string} depVersion - Resolved version string
 * @param {string} resolvedKey - Lockfile key indicating where the package is installed
 * @returns {Promise<{name: string, version: string, repository: string, license: string}>}
 */
async function getDependencyLicense(depName, depVersion, resolvedKey) {
  let licenseContent = 'License text not found.';
  let repositoryUrl = 'No repository found';

  // Derive the on-disk path directly from the lockfile key
  const depPackageJsonPath = path.join(
    projectRoot,
    resolvedKey,
    'package.json',
  );

  try {
    const depPackageJsonContent = await fs.readFile(
      depPackageJsonPath,
      'utf-8',
    );
    const depPackageJson = JSON.parse(depPackageJsonContent);

    repositoryUrl = depPackageJson.repository?.url || repositoryUrl;

    const packageDir = path.dirname(depPackageJsonPath);
    const licenseFileCandidates = [
      depPackageJson.licenseFile,
      'LICENSE',
      'LICENSE.md',
      'LICENSE.txt',
      'LICENSE-MIT.txt',
      'license.md',
      'license',
    ].filter(Boolean);

    let licenseFile;
    for (const candidate of licenseFileCandidates) {
      const potentialFile = path.join(packageDir, candidate);
      if (await fs.stat(potentialFile).catch(() => false)) {
        licenseFile = potentialFile;
        break;
      }
    }

    if (licenseFile) {
      try {
        licenseContent = await fs.readFile(licenseFile, 'utf-8');
      } catch (e) {
        console.warn(
          `Warning: Failed to read license file for ${depName}: ${e.message}`,
        );
      }
    } else {
      console.warn(`Warning: Could not find license file for ${depName}`);
    }
  } catch (e) {
    console.warn(
      `Warning: Could not find package.json for ${depName} at ${depPackageJsonPath}: ${e.message}`,
    );
  }

  return {
    name: depName,
    version: depVersion,
    repository: repositoryUrl,
    license: licenseContent,
  };
}

/**
 * Resolve a package in the lockfile by walking up the node_modules chain,
 * mirroring Node.js module resolution algorithm.
 *
 * @param {string} packageName - Package to find
 * @param {object} packages - packageLock.packages map
 * @param {string} resolveFrom - Lockfile key to start resolution from
 * @returns {{info: object, key: string} | null}
 */
function resolveInLockfile(packageName, packages, resolveFrom) {
  // Walk up from resolveFrom, trying each node_modules level
  let current = resolveFrom;
  while (current) {
    const candidate = `${current}/node_modules/${packageName}`;
    if (packages[candidate]) {
      return { info: packages[candidate], key: candidate };
    }
    // Move up: strip the last /node_modules/... segment
    const lastNm = current.lastIndexOf('/node_modules/');
    if (lastNm === -1) break;
    current = current.slice(0, lastNm);
  }
  // Finally try root hoisted level
  const hoistedKey = `node_modules/${packageName}`;
  if (packages[hoistedKey]) {
    return { info: packages[hoistedKey], key: hoistedKey };
  }
  return null;
}

/**
 * Recursively collect third-party dependencies by walking the lockfile.
 * Mirrors Node.js module resolution: walks up the node_modules chain from
 * the current package's location.
 *
 * @param {string} packageName - Package to resolve
 * @param {object} packageLock - Parsed package-lock.json
 * @param {Map<string, {version: string, resolvedKey: string}>} dependenciesMap - Accumulated results
 * @param {string} resolveFrom - Lockfile key prefix to resolve from (e.g. "packages/vscode-ide-companion")
 */
function collectDependencies(
  packageName,
  packageLock,
  dependenciesMap,
  resolveFrom,
) {
  if (dependenciesMap.has(packageName)) {
    return;
  }

  const resolved = resolveInLockfile(
    packageName,
    packageLock.packages,
    resolveFrom,
  );
  if (!resolved) {
    console.warn(
      `Warning: Could not find package info for ${packageName} in package-lock.json.`,
    );
    return;
  }

  const { info: packageInfo, key: resolvedKey } = resolved;

  // Workspace-linked packages: follow resolved pointer to collect their third-party deps
  if (packageInfo.link) {
    const realInfo = packageLock.packages[packageInfo.resolved];
    if (realInfo?.dependencies) {
      for (const depName of Object.keys(realInfo.dependencies)) {
        collectDependencies(depName, packageLock, dependenciesMap, resolveFrom);
      }
    }
    return;
  }

  dependenciesMap.set(packageName, {
    version: packageInfo.version,
    resolvedKey,
  });

  if (packageInfo.dependencies) {
    for (const depName of Object.keys(packageInfo.dependencies)) {
      // Resolve transitive deps from THIS package's location
      collectDependencies(depName, packageLock, dependenciesMap, resolvedKey);
    }
  }
}

async function main() {
  try {
    const packageJsonPath = path.join(packagePath, 'package.json');
    const packageJsonContent = await fs.readFile(packageJsonPath, 'utf-8');
    const packageJson = JSON.parse(packageJsonContent);

    const packageLockJsonPath = path.join(projectRoot, 'package-lock.json');
    const packageLockJsonContent = await fs.readFile(
      packageLockJsonPath,
      'utf-8',
    );
    const packageLockJson = JSON.parse(packageLockJsonContent);

    const allDependencies = new Map();
    const directDependencies = Object.keys(packageJson.dependencies);
    const workspacePrefix = path.relative(projectRoot, packagePath);

    for (const depName of directDependencies) {
      collectDependencies(
        depName,
        packageLockJson,
        allDependencies,
        workspacePrefix,
      );
    }

    const dependencyEntries = Array.from(allDependencies.entries());

    const licensePromises = dependencyEntries.map(
      ([depName, { version, resolvedKey }]) =>
        getDependencyLicense(depName, version, resolvedKey),
    );

    const dependencyLicenses = await Promise.all(licensePromises);

    let noticeText =
      'This file contains third-party software notices and license terms.\n\n';

    for (const dep of dependencyLicenses) {
      noticeText +=
        '============================================================\n';
      noticeText += `${dep.name}@${dep.version}\n`;
      noticeText += `(${dep.repository})\n\n`;
      noticeText += `${dep.license}\n\n`;
    }

    await fs.writeFile(noticeFilePath, noticeText);
    console.log(`NOTICES.txt generated at ${noticeFilePath}`);
    console.log(`Total dependencies: ${dependencyEntries.length}`);
  } catch (error) {
    console.error('Error generating NOTICES.txt:', error);
    process.exit(1);
  }
}

main().catch(console.error);
