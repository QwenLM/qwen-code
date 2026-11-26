/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type { SettingsService } from '@qwen-code/resource';
import { parse as parseJsonc, type ParseError } from 'jsonc-parser';
import {
  resolveProxyFromEnvironment,
  shouldBypassProxy,
} from '../../utils/fetch.js';
import { normalizeProxyUrl } from '../../utils/proxy.js';
import { runLogger } from '../../utils/runLogger.js';

export interface CreateProxyInstanceOptions {
  /** Process-level settings source, read synchronously at construction. */
  readonly settingsService: SettingsService;
}

/**
 * Process-level proxy: resolves the proxy URL once at construction and
 * evaluates per-origin bypass policy.
 *
 * Resolution order at construction: `--proxy` argv, then the settings gate
 * (`advanced.useProxyFromEnvironment`) deciding whether environment discovery
 * is allowed, then the proxy environment variables.
 */
export class ProxyInstance {
  private readonly settingsService: SettingsService;
  /** Mutable so process-level surfaces can replace it via `set`. */
  private proxyUrl: string | undefined;

  constructor(options: CreateProxyInstanceOptions) {
    this.settingsService = options.settingsService;
    this.proxyUrl = this.resolveInitialProxy();
  }

  /** Returns the resolved proxy URL, or undefined for direct egress. */
  resolve(): string | undefined {
    return this.proxyUrl;
  }

  /** Whether this origin must bypass the resolved proxy. */
  bypass(origin: string): boolean {
    return shouldBypassProxy(new URL(origin));
  }

  /**
   * Replaces the resolved proxy at runtime; `undefined` means direct egress.
   * Used by process-level settings surfaces (daemon setproxy, SDK handshake).
   */
  set(proxy: string | undefined): void {
    this.proxyUrl = proxy === undefined ? undefined : normalizeProxyUrl(proxy);
  }

  private resolveInitialProxy(): string | undefined {
    const argvProxy = this.parseProxyFromArgv();
    if (argvProxy !== undefined) return normalizeProxyUrl(argvProxy);
    if (!this.isEnvironmentDiscoveryEnabled()) return undefined;
    return resolveProxyFromEnvironment()?.proxy;
  }

  /** `settings.advanced.useProxyFromEnvironment`, enabled unless set to false. */
  private isEnvironmentDiscoveryEnabled(): boolean {
    const text = this.readUserSettingsText();
    if (text === undefined) return true;
    const errors: ParseError[] = [];
    const parsed: unknown = parseJsonc(text.replace(/^\uFEFF/, ''), errors, {
      allowTrailingComma: true,
    });
    if (errors.length > 0 || typeof parsed !== 'object' || parsed === null) {
      return true;
    }
    const advanced = (parsed as Record<string, unknown>)['advanced'];
    if (typeof advanced !== 'object' || advanced === null) return true;
    return (
      (advanced as Record<string, unknown>)['useProxyFromEnvironment'] !== false
    );
  }

  private readUserSettingsText(): string | undefined {
    try {
      return this.settingsService.peekUserSettingsSource()?.read();
    } catch (error) {
      runLogger.warn(
        '[proxy] failed to read user settings; assuming environment discovery is enabled',
        { error_type: error instanceof Error ? error.name : typeof error },
      );
      return undefined;
    }
  }

  /** Reads `--proxy <url>` and `--proxy=<url>` until the argv separator. */
  private parseProxyFromArgv(
    argv: readonly string[] = process.argv,
  ): string | undefined {
    for (let i = 0; i < argv.length; i++) {
      const arg = argv[i];
      if (arg === '--') break;
      if (arg === '--proxy') return argv[i + 1] || undefined;
      if (arg.startsWith('--proxy=')) {
        return arg.slice('--proxy='.length) || undefined;
      }
    }
    return undefined;
  }
}
