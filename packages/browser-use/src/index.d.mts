/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

export interface NodeReplBrowserRuntime {
  emitImage(image: unknown): Promise<void>;
}

export interface BrowserAgent {
  readonly browsers: {
    get(id: string): Promise<Browser>;
  };
}

export interface Browser {
  readonly user: {
    history(options?: object): Promise<unknown[]>;
  };
  readonly tabs: {
    new: () => Promise<BrowserTab>;
  };
  documentation(): Promise<string>;
}

export interface BrowserTab {
  readonly playwright: {
    getByRole(role: string, options?: object): BrowserLocator;
  };
  screenshot(): Promise<{
    mediaType: string;
    base64: string;
    mimeType: string;
    bytes: Uint8Array;
  }>;
}

export interface BrowserLocator {
  first(): BrowserLocator;
  click(options?: object): Promise<void>;
}

export function setupBrowserRuntime(
  runtime: NodeReplBrowserRuntime,
): Promise<BrowserAgent>;

export function closeBrowserRuntime(): Promise<void>;
