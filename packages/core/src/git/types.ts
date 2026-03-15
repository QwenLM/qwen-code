/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

export interface RepoInfo {
  owner: string;
  repo: string;
}

export interface GitAuth {
  token?: string;
  username?: string;
  password?: string;
}

export interface ReleaseDownloadResult {
  tagName: string;
  type: 'git' | 'github-release' | 'gitlab-release';
}

export interface GitProvider {
  /**
   * Set authentication for this provider.
   */
  setAuth(auth: GitAuth): void;
  /**
   * Returns the owner and repository for a given URL.
   */
  getRepoInfo(source: string): RepoInfo;

  /**
   * Returns the latest release tag for a repository.
   */
  getLatestRelease(
    owner: string,
    repo: string,
    proxy?: string,
  ): Promise<string>;

  /**
   * Fetches the content of a file from a repository.
   */
  getFileContent(
    owner: string,
    repo: string,
    path: string,
    ref?: string,
  ): Promise<string>;

  /**
   * Clones a repository to a local path.
   */
  clone(source: string, destination: string, ref?: string): Promise<void>;

  /**
   * Downloads a release from a repository.
   */
  downloadRelease(
    source: string,
    destination: string,
    ref?: string,
  ): Promise<ReleaseDownloadResult>;

  /**
   * Converts a blob URL to a raw URL for the given source.
   */
  convertToRawUrl(url: string): string;
}
