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
 * @param {string} packageDir - Directory the package is installed in
 * @returns {Promise<{name: string, version: string, repository: string, license: string}>}
 */
async function getDependencyLicense(depName, depVersion, packageDir) {
  let licenseContent = 'License text not found.';
  let repositoryUrl = 'No repository found';

  const depPackageJsonPath = path.join(packageDir, 'package.json');

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
 * Find where `packageName` resolves from `fromDir` by walking up the
 * node_modules chain the way Node.js does. This reads the installed tree
 * rather than a lockfile, so the notices describe what the extension actually
 * bundles, whichever package manager laid that tree out.
 *
 * @param {string} packageName - Package to find
 * @param {string} fromDir - Real directory of the package that depends on it
 * @returns {Promise<{dir: string, manifest: object} | null>}
 */
async function resolveInstalled(packageName, fromDir) {
  let dir = fromDir;
  for (;;) {
    const candidate = path.join(dir, 'node_modules', packageName);
    try {
      const manifest = JSON.parse(
        await fs.readFile(path.join(candidate, 'package.json'), 'utf-8'),
      );
      return { dir: await fs.realpath(candidate), manifest };
    } catch (error) {
      if (error.code !== 'ENOENT' && error.code !== 'ENOTDIR') throw error;
    }
    const parent = path.dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

/**
 * Recursively collect third-party dependencies from the installed tree,
 * resolving each one from the real location of the package that needs it.
 *
 * @param {string} packageName - Package to resolve
 * @param {string} fromDir - Real directory to resolve from
 * @param {Map<string, {name: string, version: string, dir: string}>} dependenciesMap - Accumulated results
 * @param {Set<string>} visitedDirs - Installed directories already traversed
 */
export async function collectDependencies(
  packageName,
  fromDir,
  dependenciesMap,
  visitedDirs,
) {
  const resolved = await resolveInstalled(packageName, fromDir);
  if (!resolved) {
    console.warn(
      `Warning: ${packageName} is not installed where ${fromDir} resolves it.`,
    );
    return;
  }

  const { dir, manifest } = resolved;

  // Traversal guard: keyed by real directory, not package name, so different
  // installed versions of the same package are each traversed once.
  if (visitedDirs.has(dir)) {
    return;
  }
  visitedDirs.add(dir);

  // A workspace package resolves outside every node_modules directory: follow
  // it for its third-party dependencies without listing it.
  if (dir.split(path.sep).includes('node_modules')) {
    // Output dedup: emit each (name, version) pair once, even when the same
    // version is installed at multiple paths.
    const outputKey = `${packageName}@${manifest.version}`;
    if (!dependenciesMap.has(outputKey)) {
      dependenciesMap.set(outputKey, {
        name: packageName,
        version: manifest.version,
        dir,
      });
    }
  }

  for (const depName of Object.keys(manifest.dependencies ?? {})) {
    await collectDependencies(depName, dir, dependenciesMap, visitedDirs);
  }
}

async function main() {
  try {
    const packageJsonPath = path.join(packagePath, 'package.json');
    const packageJsonContent = await fs.readFile(packageJsonPath, 'utf-8');
    const packageJson = JSON.parse(packageJsonContent);

    const allDependencies = new Map();
    const visitedDirs = new Set();
    const directDependencies = Object.keys(packageJson.dependencies);

    // Sequential on purpose: the traversal order is the file's order, and it
    // must not depend on which filesystem read finishes first.
    for (const depName of directDependencies) {
      await collectDependencies(
        depName,
        packagePath,
        allDependencies,
        visitedDirs,
      );
    }

    const dependencyEntries = Array.from(allDependencies.values());

    const licensePromises = dependencyEntries.map(({ name, version, dir }) =>
      getDependencyLicense(name, version, dir),
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
  const skipGeneration = ['1', 'true'].includes(
    (env.QWEN_SKIP_NOTICE_GENERATION ?? '').toLowerCase(),
  );

  if (skipGeneration) {
    console.log(
      'Skipping VS Code notice generation during worktree bootstrap.',
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
