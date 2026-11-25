/**
 * @license
 * Copyright 2026 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import type { Config } from '../config/config.js';
import { ENV_AGENT_SDK_ENTRYPOINT, ENV_CLIENT_VERSION, ENV_PARENT_SURFACE, ENV_CLI_PARENT_SURFACE, ENV_JB_IDE, ENV_REMOTE_WORKER, BRAND_FIXED_ENV_PREFIX, getClientMetadata } from '../config/brand.js';
import { getVersion } from '../utils/version.js';
import {
  COMMON_EXTENSION_KEYS,
  type ExtensionFeatures,
} from './extension-features.js';

export async function captureExtensionCommonFeatures(
  config: Config,
  eventId: string,
  eventTs: string,
): Promise<Partial<ExtensionFeatures>> {
  // 查版本号需要 await，先保存当前身份和环境，避免等待期间归属发生变化。
  const truthy = (name: string) => ['1', 'true', 'yes', 'on'].includes(process.env[name]?.trim().toLowerCase() ?? '');
  const rawParent = process.env[ENV_PARENT_SURFACE] ?? process.env[ENV_CLI_PARENT_SURFACE];
  const parentSurface = ['jb_plugin', 'mobile_rc', 'direct_cli', 'ci', 'unknown'].includes(rawParent ?? '')
    ? rawParent
    : process.env[ENV_JB_IDE]?.trim()
      ? 'jb_plugin'
      : truthy(ENV_REMOTE_WORKER) || truthy(`${BRAND_FIXED_ENV_PREFIX}REMOTE_CONTROLLER`)
        ? 'mobile_rc'
        : ['CI', 'GITHUB_ACTIONS', 'GITLAB_CI', 'BUILDKITE', 'TF_BUILD'].some(truthy) || process.env['JENKINS_URL']?.trim() || process.env['TEAMCITY_VERSION']?.trim()
          ? 'ci'
          : 'direct_cli';
  const offset = -new Date().getTimezoneOffset();
  const fields: Partial<ExtensionFeatures> = {
    sessionId: config.getSessionId(),
    agentSdkEntrypoint: process.env[ENV_AGENT_SDK_ENTRYPOINT]?.trim() ?? '',
    agentSdkVersion: process.env[`${BRAND_FIXED_ENV_PREFIX}AGENT_SDK_VERSION`]?.trim() ?? '',
    agentSdkLanguage: process.env[`${BRAND_FIXED_ENV_PREFIX}AGENT_SDK_LANGUAGE`]?.trim() ?? '',
    parentSurface,
    os: process.platform === 'win32' ? 'windows' : ['darwin', 'linux', 'android'].includes(process.platform) ? process.platform : 'unknown',
    locale: process.env['LC_ALL'] ?? process.env['LC_MESSAGES'] ?? process.env['LANG'] ?? process.env['LANGUAGE'],
    tzOffsetMin: Number.isFinite(offset) ? offset : '',
  };
  const common = Object.fromEntries(COMMON_EXTENSION_KEYS.map((key) => [key, fields[key] ?? '']));
  return {
    ...common,
    eventId,
    eventTs,
    product: getClientMetadata().business_product,
    productVersion: process.env[ENV_CLIENT_VERSION] ?? '',
    cliVersion: await getVersion(),
  };
}
