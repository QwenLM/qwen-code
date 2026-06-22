/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

type DisposableProvider = {
  dispose(): void;
};

/**
 * Tracks chat providers by host type while exposing a combined list for flows
 * like permission handling and diff suppression.
 */
export class ChatProviderRegistry<T extends DisposableProvider> {
  private editorProviders: T[] = [];
  private viewProviders: T[] = [];

  constructor(private readonly createProvider: () => T) {}

  createEditorProvider(provider: T = this.createProvider()): T {
    this.editorProviders.push(provider);
    return provider;
  }

  createViewProvider(provider: T = this.createProvider()): T {
    this.viewProviders.push(provider);
    return provider;
  }

  getEditorProviders(): T[] {
    return [...this.editorProviders];
  }

  getPermissionAwareProviders(): T[] {
    return [...this.editorProviders, ...this.viewProviders];
  }

  disposeAll(): void {
    for (const provider of this.getPermissionAwareProviders()) {
      provider.dispose();
    }
    this.editorProviders = [];
    this.viewProviders = [];
  }
}
