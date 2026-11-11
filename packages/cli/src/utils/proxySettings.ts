/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  normalizeProxyUrl,
  redactProxyUrl,
  resolveProxyFromEnvironment,
  runLogger,
  type ProxyEnvironmentVariable,
} from '@qwen-code/core';
import type { MergedSettings } from '../config/settings.js';

export interface ProxyResolutionOptions {
  /** SDK 通过启动接口显式传入的代理。 */
  explicitProxy?: string;
  /** 用于记录当前启动形态，不改变代理解析规则。 */
  sdkMode?: boolean;
}

export interface ProxyResolution {
  readonly proxy: string | undefined;
  readonly source: 'explicit' | 'environment' | 'direct';
  readonly environmentVariable?: ProxyEnvironmentVariable;
  readonly noProxyEnvironmentVariable?: 'NO_PROXY' | 'no_proxy';
  readonly directReason?:
    | 'environment-discovery-disabled'
    | 'environment-not-configured';
  readonly mode: 'sdk' | 'standalone';
}

let lastProxyResolutionLog: string | undefined;

/**
 * Resolves the proxy that the CLI should use during startup.
 *
 * An explicit startup proxy always wins. When it is omitted, both standalone
 * and SDK launches follow the user setting that controls environment proxy
 * discovery. Disabling that setting is the explicit direct-connection policy.
 */
export function resolveProxyFromSettings(
  settings: Pick<MergedSettings, 'advanced'>,
  options: ProxyResolutionOptions = {},
): ProxyResolution {
  const mode = options.sdkMode ? 'sdk' : 'standalone';
  const noProxyEnvironmentVariable = process.env['NO_PROXY']
    ? 'NO_PROXY'
    : process.env['no_proxy']
      ? 'no_proxy'
      : undefined;

  if (options.explicitProxy !== undefined) {
    return {
      proxy: normalizeProxyUrl(options.explicitProxy),
      source: 'explicit',
      noProxyEnvironmentVariable,
      mode,
    };
  }
  if (!settings.advanced.useProxyFromEnvironment) {
    return {
      proxy: undefined,
      source: 'direct',
      directReason: 'environment-discovery-disabled',
      mode,
    };
  }

  const environmentProxy = resolveProxyFromEnvironment();
  if (environmentProxy) {
    return {
      proxy: environmentProxy.proxy,
      source: 'environment',
      environmentVariable: environmentProxy.source,
      noProxyEnvironmentVariable,
      mode,
    };
  }

  return {
    proxy: undefined,
    source: 'direct',
    directReason: 'environment-not-configured',
    mode,
  };
}

export function logProxyResolution(resolution: ProxyResolution): void {
  let message: string;
  if (resolution.proxy) {
    message =
      `[proxy] Proxy configuration resolved: mode=${resolution.mode}, source=${resolution.source}, ` +
        `environmentVariable=${resolution.environmentVariable ?? 'none'}, ` +
        `noProxyEnvironmentVariable=${resolution.noProxyEnvironmentVariable ?? 'none'}, ` +
        `proxy=${redactProxyUrl(resolution.proxy)}`;
  } else {
    message =
      `[proxy] Proxy configuration resolved: mode=${resolution.mode}, source=direct, ` +
      `reason=${resolution.directReason ?? 'unspecified'}`;
  }

  if (message === lastProxyResolutionLog) return;
  lastProxyResolutionLog = message;
  runLogger.log(message);
}
