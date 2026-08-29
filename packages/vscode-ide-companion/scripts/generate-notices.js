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
 * Standard MIT license text used when a package declares MIT but ships no
 * license file (some packages keep the text only in their README). The
 * copyright holder line is taken from package.json metadata when available.
 */
const MIT_FALLBACK_TEXT = `MIT License

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.`;

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

    repositoryUrl =
      normalizeRepositoryUrl(depPackageJson.repository) || repositoryUrl;

    const packageDir = path.dirname(depPackageJsonPath);
    const licenseFile = await findLicenseFile(
      packageDir,
      depPackageJson.licenseFile,
    );

    if (licenseFile) {
      try {
        licenseContent = await fs.readFile(licenseFile, 'utf-8');
      } catch (e) {
        console.warn(
          `Warning: Failed to read license file for ${depName}: ${e.message}`,
        );
      }
    } else {
      const fallbackLicense = getFallbackLicenseText(
        depPackageJson.license,
        depPackageJson.author,
      );
      if (fallbackLicense) {
        licenseContent = fallbackLicense;
      } else {
        console.warn(`Warning: Could not find license file for ${depName}`);
      }
    }

    // Some packages keep additional license texts outside the top level:
    // a `licenses/` directory (e.g. echarts ships licenses/LICENSE-d3 for
    // its embedded d3-derived files, referenced from its Apache LICENSE)
    // and an Apache-style NOTICE file (required by Apache-2.0 §4(d)).
    // Append both so the notices they accompany are actually shipped.
    const extraSections = [];
    for (const supplementaryFile of await findSupplementaryLicenseFiles(
      packageDir,
    )) {
      try {
        const content = await fs.readFile(supplementaryFile, 'utf-8');
        const relativeName = path
          .relative(packageDir, supplementaryFile)
          .split(path.sep)
          .join('/');
        extraSections.push(`--- ${relativeName} ---\n\n${content.trim()}`);
      } catch (e) {
        console.warn(
          `Warning: Failed to read supplementary license file for ${depName}: ${e.message}`,
        );
      }
    }

    const noticeFile = await findNoticeFile(packageDir);
    if (noticeFile) {
      try {
        const noticeContent = (await fs.readFile(noticeFile, 'utf-8')).trim();
        if (noticeContent) {
          extraSections.push(`--- NOTICE ---\n\n${noticeContent}`);
        }
      } catch (e) {
        console.warn(
          `Warning: Failed to read NOTICE file for ${depName}: ${e.message}`,
        );
      }
    }

    if (extraSections.length > 0) {
      licenseContent = `${licenseContent.replace(/\s+$/, '')}\n\n${extraSections.join('\n\n')}`;
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
 * Scan a directory and map lowercased entry names to the actual entry name.
 * The default macOS filesystem is case-insensitive while Linux (CI) is
 * case-sensitive, so a fixed-case candidate list finds a `License` file on
 * macOS but misses it on Linux, making the generated notices
 * platform-dependent. Comparing lowercased names gives the same result on
 * both.
 *
 * @param {string} dir - Directory to scan
 * @returns {Promise<Map<string, string>>} Lowercased name -> actual name
 */
async function entriesByLowerName(dir) {
  const dirEntries = await fs.readdir(dir).catch(() => []);
  const map = new Map();
  for (const entry of dirEntries) {
    const lower = entry.toLowerCase();
    if (!map.has(lower)) {
      map.set(lower, entry);
    }
  }
  return map;
}

/**
 * Resolve a dependency's license file case-insensitively.
 *
 * @param {string} packageDir - Directory containing the dependency's package.json
 * @param {string} [licenseFileHint] - License file name declared in package.json, if any
 * @returns {Promise<string | undefined>} Absolute path to the license file, or undefined
 */
export async function findLicenseFile(packageDir, licenseFileHint) {
  const candidates = [
    licenseFileHint,
    'LICENSE',
    'LICENSE.md',
    'LICENSE.txt',
    'LICENSE-MIT.txt',
    'LICENSE-MIT',
    'LICENCE.md',
    'license.md',
    'license',
  ]
    .filter(Boolean)
    .map((candidate) => candidate.toLowerCase());

  const entries = await entriesByLowerName(packageDir);

  for (const candidate of candidates) {
    const match = entries.get(candidate);
    if (match) {
      return path.join(packageDir, match);
    }
  }
  return undefined;
}

/**
 * Resolve a dependency's NOTICE file case-insensitively. Apache-2.0 §4(d)
 * requires redistribution to retain NOTICE attributions when the work ships
 * a NOTICE file.
 *
 * @param {string} packageDir - Directory containing the dependency's package.json
 * @returns {Promise<string | undefined>} Absolute path to the NOTICE file, or undefined
 */
export async function findNoticeFile(packageDir) {
  const candidates = ['notice', 'notice.txt', 'notice.md'];
  const entries = await entriesByLowerName(packageDir);

  for (const candidate of candidates) {
    const match = entries.get(candidate);
    if (match) {
      const matchPath = path.join(packageDir, match);
      const stat = await fs.stat(matchPath).catch(() => undefined);
      if (stat?.isFile()) {
        return matchPath;
      }
    }
  }
  return undefined;
}

/**
 * List supplementary license files kept in a package's top-level `licenses/`
 * directory (sorted for deterministic output). These are referenced from the
 * package's main license text (e.g. echarts' Apache LICENSE points at
 * licenses/LICENSE-d3 for its embedded d3-derived files) but were previously
 * never shipped with the notices. The match is exact-case on purpose: the
 * uppercase `LICENSES/` directory is the unrelated REUSE convention of
 * SPDX-keyed standard texts, which the package's own license entry already
 * covers.
 *
 * @param {string} packageDir - Directory containing the dependency's package.json
 * @returns {Promise<string[]>} Absolute paths of the supplementary license files
 */
export async function findSupplementaryLicenseFiles(packageDir) {
  const dirEntries = await fs.readdir(packageDir).catch(() => []);
  if (!dirEntries.includes('licenses')) {
    return [];
  }
  const licensesDir = path.join(packageDir, 'licenses');
  const dirStat = await fs.stat(licensesDir).catch(() => undefined);
  if (!dirStat?.isDirectory()) {
    return [];
  }

  const filePaths = [];
  const files = (await fs.readdir(licensesDir).catch(() => []))
    .slice()
    .sort((a, b) => a.localeCompare(b));
  for (const file of files) {
    const filePath = path.join(licensesDir, file);
    const fileStat = await fs.stat(filePath).catch(() => undefined);
    if (fileStat?.isFile()) {
      filePaths.push(filePath);
    }
  }
  return filePaths;
}

/**
 * Normalize the package.json `repository` field to a display URL.
 *
 * Object-form values are returned unchanged (preserving the historical
 * output). String-form values — which npm allows as a full URL, a
 * `github:user/repo` shortcut, or a bare `user/repo` GitHub shorthand — are
 * expanded to an https URL so they are not dropped as "No repository found".
 *
 * @param {string | {url?: string} | undefined} repository - The `repository` field from package.json
 * @returns {string | undefined} A display URL, or undefined when absent
 */
export function normalizeRepositoryUrl(repository) {
  if (typeof repository !== 'string') {
    return repository?.url;
  }

  let value = repository.trim();
  if (!value) {
    return undefined;
  }

  if (value.startsWith('git+') && /^git\+https?:/.test(value)) {
    value = value.slice('git+'.length);
  }
  if (value.startsWith('github:')) {
    return `https://github.com/${value.slice('github:'.length)}`;
  }
  const scpMatch = value.match(/^git@([^:]+):(.+)$/);
  if (scpMatch) {
    return `https://${scpMatch[1]}/${scpMatch[2]}`;
  }
  if (value.startsWith('git://')) {
    return `https://${value.slice('git://'.length)}`;
  }
  if (/^[\w.-]+\/[\w.-]+$/.test(value)) {
    return `https://github.com/${value}`;
  }
  return value;
}

/**
 * Produce fallback license text for packages that declare a known SPDX
 * license but ship no license file. Currently only MIT is covered, as it is
 * the only such declaration in the dependency graph.
 *
 * @param {unknown} license - The `license` field from package.json
 * @param {unknown} author - The `author` field from package.json
 * @returns {string | undefined} Fallback text, or undefined when no fallback applies
 */
export function getFallbackLicenseText(license, author) {
  if (typeof license !== 'string' || license.trim().toUpperCase() !== 'MIT') {
    return undefined;
  }
  const authorName =
    typeof author === 'string' && author.trim()
      ? // npm author strings may carry a trailing homepage in parentheses
        // ("Name <email> (url)"), which does not belong in a copyright line.
        author.trim().replace(/\s*\([^)]*\)$/, '')
      : typeof author?.name === 'string' && author.name.trim()
        ? author.name.trim()
        : undefined;
  const copyrightLine = authorName ? `Copyright (c) ${authorName}\n\n` : '';
  return `Standard MIT license text (package declares MIT but ships no license file; copyright holder from package.json metadata).\n\n${copyrightLine}${MIT_FALLBACK_TEXT}`;
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
 * @param {Set<string>} visitedKeys - Lockfile keys already traversed
 */
export function collectDependencies(
  packageName,
  packageLock,
  dependenciesMap,
  resolveFrom,
  visitedKeys,
) {
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

  // Traversal guard: skip if this exact lockfile path was already visited.
  // Keyed by resolved path (not package name) so different installed versions
  // of the same package are each traversed once.
  if (visitedKeys.has(resolvedKey)) {
    return;
  }
  visitedKeys.add(resolvedKey);

  // Workspace-linked packages: follow resolved pointer to collect their third-party deps
  if (packageInfo.link) {
    const realInfo = packageLock.packages[packageInfo.resolved];
    if (realInfo?.dependencies) {
      for (const depName of Object.keys(realInfo.dependencies)) {
        collectDependencies(
          depName,
          packageLock,
          dependenciesMap,
          packageInfo.resolved,
          visitedKeys,
        );
      }
    }
    return;
  }

  // Output dedup: emit each (name, version) pair once, even when the same
  // version is installed at multiple paths.
  const outputKey = `${packageName}@${packageInfo.version}`;
  if (!dependenciesMap.has(outputKey)) {
    dependenciesMap.set(outputKey, {
      name: packageName,
      version: packageInfo.version,
      resolvedKey,
    });
  }

  if (packageInfo.dependencies) {
    for (const depName of Object.keys(packageInfo.dependencies)) {
      // Resolve transitive deps from THIS package's location
      collectDependencies(
        depName,
        packageLock,
        dependenciesMap,
        resolvedKey,
        visitedKeys,
      );
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
    const visitedKeys = new Set();
    const directDependencies = Object.keys(packageJson.dependencies);
    const workspacePrefix = path.relative(projectRoot, packagePath);

    for (const depName of directDependencies) {
      collectDependencies(
        depName,
        packageLockJson,
        allDependencies,
        workspacePrefix,
        visitedKeys,
      );
    }

    const dependencyEntries = Array.from(allDependencies.values());

    const licensePromises = dependencyEntries.map(
      ({ name, version, resolvedKey }) =>
        getDependencyLicense(name, version, resolvedKey),
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

    // Normalize line endings to LF. Third-party license files may use CRLF,
    // which would otherwise be embedded verbatim and produce spurious diffs
    // (the file is declared `eol=lf` in .gitattributes).
    noticeText = noticeText.replace(/\r\n/g, '\n');

    await fs.writeFile(noticeFilePath, noticeText);
    console.log(`NOTICES.txt generated at ${noticeFilePath}`);
    console.log(`Total dependencies: ${dependencyEntries.length}`);
  } catch (error) {
    console.error('Error generating NOTICES.txt:', error);
    process.exit(1);
  }
}

export async function runNoticeGeneration(env = process.env) {
  const skipPrepare =
    env.npm_lifecycle_event === 'prepare' &&
    ['1', 'true'].includes((env.QWEN_SKIP_PREPARE ?? '').toLowerCase());

  if (skipPrepare) {
    console.log(
      'Skipping VS Code notice generation because QWEN_SKIP_PREPARE is set.',
    );
    return;
  }

  await main();
}

// Only run when executed directly (e.g. `npm run generate:notices`), not when
// imported by tests.
if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  runNoticeGeneration().catch(console.error);
}
