/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { GitHubProvider } from './github.js';
import { GitLabProvider } from './gitlab.js';
import type { GitProvider } from './types.js';
import { GitAuthManager } from './auth.js';

export interface GitProviderConstructor {
  new (): GitProvider;
  canHandle(source: string): boolean;
  readonly providerName: string;
}

export class GitProviderFactory {
  private static providers: GitProviderConstructor[] = [
    GitHubProvider,
    GitLabProvider,
  ];

  static register(provider: GitProviderConstructor): void {
    this.providers.unshift(provider);
  }

  static getProvider(source: string): GitProvider {
    for (const Provider of this.providers) {
      if (Provider.canHandle(source)) {
        const provider = new Provider();
        provider.setAuth(GitAuthManager.resolveAuth(Provider.providerName));
        return provider;
      }
    }

    throw new Error(`No Git provider found for source: ${source}`);
  }
}
