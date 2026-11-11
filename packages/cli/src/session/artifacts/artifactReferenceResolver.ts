/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type { SDKArtifactInfo } from '@qwen-code/core';

import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { artifactMimeForPath } from './artifactFileTypes.js';

import type { ArtifactClassification } from './artifactRegistryState.js';

const FORMAT_CONTROL = /\p{Cf}/u;

interface ArtifactReferenceResolverOptions {
  workingDirectory: string;
  initialWorkspaceRoots: readonly string[];
}

interface ArtifactCandidateResolutionOptions {
  /** Skip automatic-discovery MIME eligibility for an explicit App snapshot. */
  allowUnknownMime?: boolean;
}

function isInsideRoot(candidate: string, root: string): boolean {
  const relative = path.relative(root, candidate);
  return (
    relative === '' ||
    (relative !== '..' &&
      !relative.startsWith(`..${path.sep}`) &&
      !path.isAbsolute(relative))
  );
}

function sanitizePathSegment(segment: string): string {
  let sanitized = '';
  for (const character of segment) {
    const codePoint = character.codePointAt(0) ?? 0;
    sanitized +=
      character === '\\' ||
      codePoint <= 0x1f ||
      (codePoint >= 0x7f && codePoint <= 0x9f) ||
      FORMAT_CONTROL.test(character)
        ? '_'
        : character;
  }
  const safeDots = sanitized.replace(/^\.+$/, (dots) =>
    '_'.repeat(dots.length),
  );
  return safeDots || '_';
}

function safeRelativePath(root: string, candidate: string): string {
  return path
    .relative(root, candidate)
    .split(path.sep)
    .map(sanitizePathSegment)
    .join('/');
}

function safeAbsolutePath(candidate: string): string {
  const root = path.parse(candidate).root;
  return path.join(root, ...safeRelativePath(root, candidate).split('/'));
}

function decodeRegularHref(href: string): string | undefined {
  try {
    return decodeURIComponent(href);
  } catch {
    return undefined;
  }
}

function isUnsafeNonFileHref(href: string): boolean {
  const isWindowsAbsolutePath = /^[a-z]:[\\/]/i.test(href);
  return (
    href.length === 0 ||
    href.includes('\0') ||
    href.includes('?') ||
    href.includes('#') ||
    href.startsWith('//') ||
    (!isWindowsAbsolutePath && /^[a-z][a-z\d+.-]*:/i.test(href))
  );
}

export class ArtifactReferenceResolver {
  private readonly workingDirectory: string;
  private readonly canonicalRoots: Promise<string[]>;

  constructor(options: ArtifactReferenceResolverOptions) {
    this.workingDirectory = path.resolve(options.workingDirectory);
    this.canonicalRoots = this.resolveInitialRoots(
      options.initialWorkspaceRoots,
    );
  }

  localCandidateFromHref(href: string): string | undefined {
    const candidate = this.localPathFromHref(href);
    return candidate && artifactMimeForPath(candidate) ? candidate : undefined;
  }

  localPresentationCandidateFromHref(href: string): string | undefined {
    return this.localPathFromHref(href);
  }

  private localPathFromHref(href: string): string | undefined {
    let candidate: string;
    if (/^file:/i.test(href)) {
      try {
        const url = new URL(href);
        const hostname = url.hostname.toLowerCase();
        if (
          url.protocol !== 'file:' ||
          (hostname.length > 0 && hostname !== 'localhost') ||
          url.search.length > 0 ||
          url.hash.length > 0
        ) {
          return undefined;
        }
        candidate = fileURLToPath(url);
        if (candidate.includes('\0')) return undefined;
      } catch {
        return undefined;
      }
    } else {
      if (isUnsafeNonFileHref(href)) return undefined;
      const decoded = decodeRegularHref(href);
      if (decoded === undefined || isUnsafeNonFileHref(decoded)) {
        return undefined;
      }
      candidate = path.isAbsolute(decoded)
        ? decoded
        : path.resolve(this.workingDirectory, decoded);
    }

    return candidate;
  }

  async resolveCandidate(
    candidate: string,
    classification: ArtifactClassification = { kind: 'presented' },
    options: ArtifactCandidateResolutionOptions = {},
  ): Promise<SDKArtifactInfo | undefined> {
    if (
      options.allowUnknownMime !== true &&
      classification.kind !== 'presented' &&
      !artifactMimeForPath(candidate)
    ) {
      return undefined;
    }

    let canonicalPath: string;
    let stats: Awaited<ReturnType<typeof fs.stat>>;
    try {
      canonicalPath = await fs.realpath(candidate);
      stats = await fs.stat(canonicalPath);
    } catch {
      return undefined;
    }
    if (!stats.isFile()) return undefined;

    const mime = artifactMimeForPath(canonicalPath);
    if (
      !mime &&
      options.allowUnknownMime !== true &&
      classification.kind !== 'presented'
    ) {
      return undefined;
    }

    const containingRoot = (await this.canonicalRoots).find((root) =>
      isInsideRoot(canonicalPath, root),
    );
    const relativePath = containingRoot
      ? safeRelativePath(containingRoot, canonicalPath)
      : undefined;
    return {
      path: canonicalPath,
      display_path: relativePath ?? safeAbsolutePath(canonicalPath),
      name: sanitizePathSegment(path.basename(canonicalPath)),
      ...classification,
      ...(relativePath === undefined ? {} : { relative_path: relativePath }),
      size: stats.size,
      ...(mime === undefined ? {} : { mime }),
      mtime: stats.mtimeMs,
    };
  }

  private async resolveInitialRoots(
    roots: readonly string[],
  ): Promise<string[]> {
    const canonicalRoots: string[] = [];
    for (const root of roots) {
      try {
        const canonicalRoot = await fs.realpath(path.resolve(root));
        if (!canonicalRoots.includes(canonicalRoot)) {
          canonicalRoots.push(canonicalRoot);
        }
      } catch {
        // A missing initial workspace root cannot provide relative display paths.
      }
    }
    return canonicalRoots;
  }
}
