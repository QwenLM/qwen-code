/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import type {
  GitProvider,
  RepoInfo,
  ReleaseDownloadResult,
  GitAuth,
} from './types.js';

export abstract class BaseGitProvider implements GitProvider {
  protected auth: GitAuth = {};

  setAuth(auth: GitAuth): void {
    this.auth = { ...this.auth, ...auth };
  }

  abstract getRepoInfo(source: string): RepoInfo;
  abstract getLatestRelease(
    owner: string,
    repo: string,
    proxy?: string,
  ): Promise<string>;
  abstract getFileContent(
    owner: string,
    repo: string,
    path: string,
    ref?: string,
  ): Promise<string>;
  abstract clone(
    source: string,
    destination: string,
    ref?: string,
  ): Promise<void>;
  abstract downloadRelease(
    source: string,
    destination: string,
    ref?: string,
  ): Promise<ReleaseDownloadResult>;
}
