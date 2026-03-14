/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { simpleGit } from 'simple-git';
import * as https from 'node:https';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as tar from 'tar';
import extract from 'extract-zip';
import { BaseGitProvider } from './provider.js';
import type { RepoInfo, ReleaseDownloadResult } from './types.js';
import { getErrorMessage } from '../utils/errors.js';

interface GitlabReleaseData {
  tag_name: string;
  assets: {
    sources: Array<{
      format: string;
      url: string;
    }>;
    links: Array<{
      name: string;
      url: string;
    }>;
  };
}

export class GitLabProvider extends BaseGitProvider {
  static readonly providerName = 'gitlab';

  static canHandle(source: string): boolean {
    if (source.startsWith('git@gitlab.com:')) {
      return true;
    }
    try {
      const url = new URL(source);
      return url.hostname === 'gitlab.com';
    } catch {
      return false;
    }
  }

  private getGitLabToken(): string | undefined {
    return this.auth.token || process.env['GITLAB_TOKEN'];
  }

  getRepoInfo(source: string): RepoInfo {
    let urlToParse = source;
    if (source.startsWith('git@gitlab.com:')) {
      urlToParse =
        'https://gitlab.com/' + source.replace('git@gitlab.com:', '');
    }

    try {
      const parsedUrl = new URL(urlToParse);
      const pathname = parsedUrl.pathname.startsWith('/')
        ? parsedUrl.pathname.substring(1)
        : parsedUrl.pathname;
      const parts = pathname.replace('.git', '').split('/');

      if (parts.length < 2) {
        throw new Error(`Invalid GitLab repository source: ${source}`);
      }

      const repo = parts.pop()!;
      const owner = parts.join('/');

      return { owner, repo };
    } catch (error) {
      throw new Error(
        `Invalid GitLab repository source: ${source}. ${getErrorMessage(error)}`,
      );
    }
  }

  async getLatestRelease(
    owner: string,
    repo: string,
    _proxy?: string,
  ): Promise<string> {
    const projectPath = encodeURIComponent(`${owner}/${repo}`);
    const url = `https://gitlab.com/api/v4/projects/${projectPath}/releases?per_page=1`;
    const releases = await this.fetchJson<GitlabReleaseData[]>(url);
    if (!releases || releases.length === 0) {
      throw new Error(`No releases found for ${owner}/${repo}`);
    }
    return releases[0].tag_name;
  }

  async getFileContent(
    owner: string,
    repo: string,
    filePath: string,
    ref?: string,
  ): Promise<string> {
    const projectPath = encodeURIComponent(`${owner}/${repo}`);
    const encodedFilePath = encodeURIComponent(filePath);
    const url = `https://gitlab.com/api/v4/projects/${projectPath}/repository/files/${encodedFilePath}/raw?ref=${ref || 'HEAD'}`;
    return this.fetchText(url);
  }

  async clone(
    source: string,
    destination: string,
    ref?: string,
  ): Promise<void> {
    try {
      const git = simpleGit(destination);
      let sourceUrl = source;
      const token = this.getGitLabToken();

      if (token) {
        try {
          const parsedUrl = new URL(sourceUrl);
          if (parsedUrl.hostname === 'gitlab.com') {
            parsedUrl.username = 'oauth2';
            parsedUrl.password = token;
            sourceUrl = parsedUrl.toString();
          }
        } catch {
          // ignore
        }
      }

      await git.clone(sourceUrl, './', ['--depth', '1']);
      const remotes = await git.getRemotes(true);
      if (remotes.length === 0) {
        throw new Error(`Unable to find any remotes for repo ${source}`);
      }

      const refToFetch = ref || 'HEAD';
      await git.fetch(remotes[0].name, refToFetch);
      await git.checkout('FETCH_HEAD');
    } catch (error) {
      throw new Error(
        `Failed to clone GitLab repository from ${source}: ${getErrorMessage(error)}`,
      );
    }
  }

  async downloadRelease(
    source: string,
    destination: string,
    ref?: string,
  ): Promise<ReleaseDownloadResult> {
    const { owner, repo } = this.getRepoInfo(source);
    try {
      const projectPath = encodeURIComponent(`${owner}/${repo}`);
      const tag = ref || (await this.getLatestRelease(owner, repo));
      const url = `https://gitlab.com/api/v4/projects/${projectPath}/releases/${tag}`;
      const releaseData = await this.fetchJson<GitlabReleaseData>(url);

      // GitLab usually provides source code as tar.gz/zip in assets.sources
      const sourceAsset =
        releaseData.assets.sources.find((s) => s.format === 'tar.gz') ||
        releaseData.assets.sources[0];
      if (!sourceAsset) {
        throw new Error(`No source assets found for release ${tag}`);
      }

      const downloadedAssetPath = path.join(
        destination,
        `release-${tag}.tar.gz`,
      );
      await this.downloadFile(sourceAsset.url, downloadedAssetPath);
      await this.extractFile(downloadedAssetPath, destination);
      await fs.promises.unlink(downloadedAssetPath);

      return {
        tagName: tag,
        type: 'gitlab-release',
      };
    } catch (error) {
      throw new Error(
        `Failed to download GitLab release from ${source}: ${getErrorMessage(error)}`,
      );
    }
  }

  convertToRawUrl(url: string): string {
    if (url.includes('gitlab.com') && url.includes('/-/blob/')) {
      return url.replace('/-/blob/', '/-/raw/');
    }
    return url;
  }

  private async fetchJson<T>(url: string): Promise<T> {
    const text = await this.fetchText(url);
    return JSON.parse(text) as T;
  }

  private async fetchText(url: string): Promise<string> {
    const headers: Record<string, string> = {
      'User-Agent': 'qwen-code-cli',
    };
    const token = this.getGitLabToken();
    if (token) {
      headers['Private-Token'] = token;
    }

    return new Promise((resolve, reject) => {
      https
        .get(url, { headers }, (res) => {
          if (res.statusCode !== 200) {
            return reject(
              new Error(
                `GitLab API request failed with status ${res.statusCode}`,
              ),
            );
          }
          const chunks: Buffer[] = [];
          res.on('data', (chunk) => chunks.push(chunk));
          res.on('end', () => resolve(Buffer.concat(chunks).toString()));
        })
        .on('error', reject);
    });
  }

  private async downloadFile(url: string, dest: string): Promise<void> {
    const headers: Record<string, string> = {
      'User-Agent': 'qwen-code-cli',
    };
    const token = this.getGitLabToken();
    if (token) {
      headers['Private-Token'] = token;
    }

    return new Promise((resolve, reject) => {
      https
        .get(url, { headers }, (res) => {
          if (res.statusCode === 302 || res.statusCode === 301) {
            return this.downloadFile(res.headers.location!, dest)
              .then(resolve)
              .catch(reject);
          }
          if (res.statusCode !== 200) {
            return reject(
              new Error(`Download failed with status ${res.statusCode}`),
            );
          }
          const file = fs.createWriteStream(dest);
          res.pipe(file);
          file.on('finish', () => file.close(resolve as () => void));
        })
        .on('error', reject);
    });
  }

  private async extractFile(file: string, dest: string): Promise<void> {
    if (file.endsWith('.tar.gz')) {
      await tar.x({ file, cwd: dest });
    } else if (file.endsWith('.zip')) {
      await extract(file, { dir: dest });
    } else {
      throw new Error(`Unsupported archive format: ${file}`);
    }
  }
}
