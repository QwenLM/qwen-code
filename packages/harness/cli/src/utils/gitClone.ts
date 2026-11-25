/**
 * @license
 * Copyright 2025 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { execInternalGit } from './internalGit.js';
import {
  getErrorMessage,
  type ExtensionInstallMetadata,
} from '@qwen-code/core';

/**
 * Clones a Git repository to a specified local path.
 * @param installMetadata The repository source and optional ref to check out.
 * @param destination The destination path to clone the repository to.
 */
export async function cloneFromGit(
  installMetadata: ExtensionInstallMetadata,
  destination: string,
): Promise<void> {
  try {
    let sourceUrl = installMetadata.source;
    const token = process.env['GITHUB_TOKEN'];
    if (token) {
      try {
        const parsedUrl = new URL(sourceUrl);
        if (
          parsedUrl.protocol === 'https:' &&
          parsedUrl.hostname === 'github.com'
        ) {
          if (!parsedUrl.username) {
            parsedUrl.username = token;
          }
          sourceUrl = parsedUrl.toString();
        }
      } catch {
        // If source is not a valid URL, we don't inject the token.
      }
    }
    await execInternalGit(
      ['clone', '--depth', '1', '--', sourceUrl, './'],
      destination,
    );

    const remotes = (await execInternalGit(['remote'], destination))
      .trim()
      .split('\n')
      .filter(Boolean);
    if (remotes.length === 0) {
      throw new Error(
        `Unable to find any remotes for repo ${installMetadata.source}`,
      );
    }

    const refToFetch = installMetadata.ref || 'HEAD';

    await execInternalGit(['fetch', '--', remotes[0], refToFetch], destination);

    // After fetching, checkout FETCH_HEAD to get the content of the fetched ref.
    await execInternalGit(['checkout', 'FETCH_HEAD'], destination);
  } catch (error) {
    throw new Error(
      `Failed to clone Git repository from ${installMetadata.source} ${getErrorMessage(error)}`,
      {
        cause: error,
      },
    );
  }
}
