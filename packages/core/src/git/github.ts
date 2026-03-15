/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { simpleGit } from 'simple-git';
import * as https from 'node:https';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import * as tar from 'tar';
import extract from 'extract-zip';
import { BaseGitProvider } from './provider.js';
import type { RepoInfo, ReleaseDownloadResult } from './types.js';
import { getErrorMessage } from '../utils/errors.js';

interface GithubReleaseData {
  assets: Asset[];
  tag_name: string;
  tarball_url?: string;
  zipball_url?: string;
}

interface Asset {
  name: string;
  browser_download_url: string;
}

export class GitHubProvider extends BaseGitProvider {
  static readonly providerName = 'github';

  static canHandle(source: string): boolean {
    if (source.startsWith('git@github.com:')) {
      return true;
    }
    try {
      const url = new URL(source);
      return url.hostname === 'github.com';
    } catch {
      // Shorthand "owner/repo"
      return source.split('/').length === 2;
    }
  }

  private getGitHubToken(): string | undefined {
    return this.auth.token || process.env['GITHUB_TOKEN'];
  }

  getRepoInfo(source: string): RepoInfo {
    let urlToParse = source;
    if (source.startsWith('git@github.com:')) {
      urlToParse = source.replace('git@github.com:', '');
    }

    // Default to a github repo path, so `source` can be just an org/repo
    const parsedUrl = URL.parse(urlToParse, 'https://github.com');
    // The pathname should be "/owner/repo".
    const pathname = parsedUrl?.pathname || '';
    const parts = (
      pathname.startsWith('/') ? pathname.substring(1) : pathname
    ).split('/');

    if (
      parts?.length !== 2 ||
      (parsedUrl?.host !== 'github.com' &&
        !source.startsWith('git@github.com:'))
    ) {
      throw new Error(
        `Invalid GitHub repository source: ${source}. Expected "owner/repo" or a github repo uri.`,
      );
    }
    const owner = parts[0];
    const repo = parts[1].replace('.git', '');

    return { owner, repo };
  }

  async getLatestRelease(
    owner: string,
    repo: string,
    _proxy?: string,
  ): Promise<string> {
    const url = `https://api.github.com/repos/${owner}/${repo}/releases/latest`;
    const data = await this.fetchJson<{ tag_name: string }>(url);
    if (!data.tag_name) {
      throw new Error(`Response did not include tag_name field`);
    }
    return data.tag_name;
  }

  async getFileContent(
    owner: string,
    repo: string,
    path: string,
    ref?: string,
  ): Promise<string> {
    const endpoint = ref ? `contents/${path}?ref=${ref}` : `contents/${path}`;
    const url = `https://api.github.com/repos/${owner}/${repo}/${endpoint}`;
    const data = await this.fetchJson<{ content: string; encoding: string }>(
      url,
    );
    if (data.encoding === 'base64') {
      return Buffer.from(data.content, 'base64').toString('utf8');
    }
    return data.content;
  }

  async clone(
    source: string,
    destination: string,
    ref?: string,
  ): Promise<void> {
    try {
      const git = simpleGit(destination);
      let sourceUrl = source;
      const token = this.getGitHubToken();
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
          // We let git handle the source as is.
        }
      }
      await git.clone(sourceUrl, './', [
        '-c',
        'core.symlinks=true',
        '--depth',
        '1',
      ]);

      const remotes = await git.getRemotes(true);
      if (remotes.length === 0) {
        throw new Error(`Unable to find any remotes for repo ${source}`);
      }

      const refToFetch = ref || 'HEAD';

      await git.fetch(remotes[0].name, refToFetch);
      await git.checkout('FETCH_HEAD');
    } catch (error) {
      throw new Error(
        `Failed to clone Git repository from ${source} ${getErrorMessage(error)}`,
        {
          cause: error,
        },
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
      const endpoint = ref ? `releases/tags/${ref}` : 'releases/latest';
      const url = `https://api.github.com/repos/${owner}/${repo}/${endpoint}`;
      const releaseData = await this.fetchJson<GithubReleaseData>(url);

      if (!releaseData) {
        throw new Error(
          `No release data found for ${owner}/${repo} at tag ${ref}`,
        );
      }

      const asset = this.findReleaseAsset(releaseData.assets);
      let archiveUrl: string | undefined;
      let isTar = false;
      let isZip = false;
      if (asset) {
        archiveUrl = asset.browser_download_url;
      } else {
        if (releaseData.tarball_url) {
          archiveUrl = releaseData.tarball_url;
          isTar = true;
        } else if (releaseData.zipball_url) {
          archiveUrl = releaseData.zipball_url;
          isZip = true;
        }
      }
      if (!archiveUrl) {
        throw new Error(
          `No assets found for release with tag ${releaseData.tag_name}`,
        );
      }
      let downloadedAssetPath = path.join(
        destination,
        path.basename(new URL(archiveUrl).pathname),
      );
      if (isTar && !downloadedAssetPath.endsWith('.tar.gz')) {
        downloadedAssetPath += '.tar.gz';
      } else if (isZip && !downloadedAssetPath.endsWith('.zip')) {
        downloadedAssetPath += '.zip';
      }

      await this.downloadFile(archiveUrl, downloadedAssetPath);
      await this.extractFile(downloadedAssetPath, destination);
      await fs.promises.unlink(downloadedAssetPath);

      return {
        tagName: releaseData.tag_name,
        type: 'github-release',
      };
    } catch (error) {
      throw new Error(
        `Failed to download release from ${source}: ${getErrorMessage(error)}`,
      );
    }
  }

  convertToRawUrl(url: string): string {
    try {
      const parsedUrl = new URL(url);
      if (parsedUrl.hostname !== 'github.com') {
        return url;
      }

      const segments = parsedUrl.pathname.split('/').filter(Boolean);
      const blobIndex = segments.indexOf('blob');
      if (blobIndex === -1 || blobIndex < 2) {
        return url;
      }

      const owner = segments[0];
      const repo = segments[1];
      const refAndPath = segments.slice(blobIndex + 1);
      if (refAndPath.length === 0) {
        return url;
      }

      parsedUrl.hostname = 'raw.githubusercontent.com';
      parsedUrl.pathname = `/${owner}/${repo}/${refAndPath.join('/')}`;
      return parsedUrl.toString();
    } catch {
      return url;
    }
  }

  private findReleaseAsset(assets: Asset[]): Asset | undefined {
    const platform = os.platform();
    const arch = os.arch();

    const platformArchPrefix = `${platform}.${arch}.`;
    const platformPrefix = `${platform}.`;

    // Check for platform + architecture specific asset
    const platformArchAsset = assets.find((asset) =>
      asset.name.toLowerCase().startsWith(platformArchPrefix),
    );
    if (platformArchAsset) {
      return platformArchAsset;
    }

    // Check for platform specific asset
    const platformAsset = assets.find((asset) =>
      asset.name.toLowerCase().startsWith(platformPrefix),
    );
    if (platformAsset) {
      return platformAsset;
    }

    // Check for generic asset if only one is available
    const genericAsset = assets.find(
      (asset) =>
        !asset.name.toLowerCase().includes('darwin') &&
        !asset.name.toLowerCase().includes('linux') &&
        !asset.name.toLowerCase().includes('win32'),
    );
    if (assets.length === 1) {
      return genericAsset;
    }

    return undefined;
  }

  private async downloadFile(url: string, dest: string): Promise<void> {
    const headers: { 'User-agent': string; Authorization?: string } = {
      'User-agent': 'gemini-cli',
    };
    const token = this.getGitHubToken();
    if (token) {
      headers.Authorization = `token ${token}`;
    }
    return new Promise((resolve, reject) => {
      https
        .get(url, { headers }, (res) => {
          if (res.statusCode === 302 || res.statusCode === 301) {
            this.downloadFile(res.headers.location!, dest)
              .then(resolve)
              .catch(reject);
            return;
          }
          if (res.statusCode !== 200) {
            return reject(
              new Error(`Request failed with status code ${res.statusCode}`),
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
      await tar.x({
        file,
        cwd: dest,
      });
    } else if (file.endsWith('.zip')) {
      await extract(file, { dir: dest });
    } else {
      throw new Error(`Unsupported file extension for extraction: ${file}`);
    }
  }

  private async fetchJson<T>(url: string): Promise<T> {
    const headers: { 'User-Agent': string; Authorization?: string } = {
      'User-Agent': 'gemini-cli',
    };
    const token = this.getGitHubToken();
    if (token) {
      headers.Authorization = `token ${token}`;
    }
    return new Promise((resolve, reject) => {
      https
        .get(url, { headers }, (res) => {
          if (res.statusCode !== 200) {
            return reject(
              new Error(`Request failed with status code ${res.statusCode}`),
            );
          }
          const chunks: Buffer[] = [];
          res.on('data', (chunk) => chunks.push(chunk));
          res.on('end', () => {
            const data = Buffer.concat(chunks).toString();
            try {
              resolve(JSON.parse(data) as T);
            } catch (e) {
              reject(e);
            }
          });
        })
        .on('error', reject);
    });
  }
}
