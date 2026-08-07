/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import * as net from 'node:net';
import {
  ALL_PROVIDERS,
  resolveBaseUrl,
  resolveProviderModels,
  shouldShowStep,
} from '@qwen-code/qwen-code-core';
import type { ModelSpec } from '@qwen-code/qwen-code-core';
import type {
  ServeAuthProviderCatalog,
  ServeAuthProviderDescriptor,
  ServeAuthProviderInstallRequest,
  ServeAuthProviderModel,
} from '../types.js';

const AUTH_PROVIDER_STEPS: ServeAuthProviderDescriptor['steps'] = [
  'protocol',
  'baseUrl',
  'apiKey',
  'models',
  'advancedConfig',
];

function serializeProviderModel(model: ModelSpec): ServeAuthProviderModel {
  return {
    id: model.id,
    ...(model.contextWindowSize !== undefined
      ? { contextWindowSize: model.contextWindowSize }
      : {}),
    ...(model.enableThinking !== undefined
      ? { enableThinking: model.enableThinking }
      : {}),
    ...(model.modalities ? { modalities: model.modalities } : {}),
    ...(model.description ? { description: model.description } : {}),
  };
}

// A throwing function-form derivation must only cost the broken provider its
// derived field; an uncaught throw fails the whole catalog map and removes
// every provider from the serve/Web Shell /auth list. Mirrors
// resolveProviderEnvKey/resolveProviderDocumentationUrl in acpAgent.ts.
function resolveDescriptorDocumentationUrl(
  provider: (typeof ALL_PROVIDERS)[number],
  baseUrl: string,
): string | undefined {
  if (typeof provider.documentationUrl !== 'function') {
    return provider.documentationUrl;
  }
  try {
    return provider.documentationUrl(baseUrl);
  } catch {
    return undefined;
  }
}

function resolveDescriptorEnvKey(
  provider: (typeof ALL_PROVIDERS)[number],
  baseUrl: string,
): string | undefined {
  if (typeof provider.envKey !== 'function') return provider.envKey;
  try {
    return provider.envKey(provider.protocol, baseUrl);
  } catch {
    return undefined;
  }
}

function buildAuthProviderDescriptor(
  provider: (typeof ALL_PROVIDERS)[number],
): ServeAuthProviderDescriptor {
  const steps = AUTH_PROVIDER_STEPS.filter((step) =>
    shouldShowStep(provider, step),
  );
  const defaultBaseUrl = resolveBaseUrl(provider);
  const models = resolveProviderModels(provider, defaultBaseUrl);
  const documentationUrl = resolveDescriptorDocumentationUrl(
    provider,
    defaultBaseUrl,
  );
  const envKey =
    typeof provider.envKey === 'string'
      ? provider.envKey
      : provider.baseUrl !== undefined
        ? resolveDescriptorEnvKey(provider, defaultBaseUrl)
        : undefined;
  const baseUrl = Array.isArray(provider.baseUrl)
    ? provider.baseUrl.map((option) => ({
        ...option,
        ...(typeof provider.envKey === 'function'
          ? { envKey: resolveDescriptorEnvKey(provider, option.url) }
          : { envKey: provider.envKey }),
        ...(option.models
          ? { models: option.models.map(serializeProviderModel) }
          : {}),
      }))
    : provider.baseUrl;
  return {
    id: provider.id,
    label: provider.label,
    description: provider.description,
    ...(provider.uiGroup ? { uiGroup: provider.uiGroup } : {}),
    protocol: provider.protocol,
    ...(provider.protocolOptions
      ? { protocolOptions: [...provider.protocolOptions] }
      : {}),
    ...(baseUrl !== undefined ? { baseUrl } : {}),
    ...(envKey ? { envKey } : {}),
    ...(models
      ? {
          models: models.map(serializeProviderModel),
        }
      : {}),
    ...(provider.modelsEditable !== undefined
      ? { modelsEditable: provider.modelsEditable }
      : {}),
    ...(provider.apiKeyPlaceholder
      ? { apiKeyPlaceholder: provider.apiKeyPlaceholder }
      : {}),
    ...(documentationUrl ? { documentationUrl } : {}),
    ...(provider.showAdvancedConfig !== undefined
      ? { showAdvancedConfig: provider.showAdvancedConfig }
      : {}),
    ...(provider.uiLabels ? { uiLabels: provider.uiLabels } : {}),
    steps,
  };
}

export function buildAuthProviderCatalog(
  workspaceCwd: string,
): ServeAuthProviderCatalog {
  const providers = ALL_PROVIDERS.map(buildAuthProviderDescriptor);
  const providerIdsByGroup = (group: string) =>
    providers
      .filter((provider) => provider.uiGroup === group)
      .map((provider) => provider.id);
  return {
    v: 1,
    workspaceCwd,
    providers,
    groups: [
      {
        id: 'alibaba',
        label: 'Alibaba ModelStudio',
        description:
          'Official recommended setup: Coding Plan, Token Plan, or Standard API Key',
        providerIds: providerIdsByGroup('alibaba'),
      },
      {
        id: 'third-party',
        label: 'Third-party Providers',
        description: 'Choose a built-in provider and connect with an API key',
        providerIds: providerIdsByGroup('third-party'),
      },
      {
        id: 'custom',
        label: 'Custom Provider',
        description:
          'Manually connect a local server, proxy, or unsupported provider',
        providerIds: providerIdsByGroup('custom'),
      },
    ],
  };
}

function parseStringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const result = value
    .map((item) => (typeof item === 'string' ? item.trim() : ''))
    .filter((item) => item.length > 0);
  return result.length > 0 ? [...new Set(result)] : undefined;
}

function parsePositiveBoundedInteger(
  value: unknown,
  max: number,
): number | undefined {
  if (
    typeof value !== 'number' ||
    !Number.isInteger(value) ||
    !Number.isFinite(value) ||
    value <= 0 ||
    value > max
  ) {
    return undefined;
  }
  return value;
}

function parseIPv4MappedHexSuffix(suffix: string): string | undefined {
  const hexParts = suffix.split(':');
  if (hexParts.length !== 2) return undefined;

  const [hiRaw, loRaw] = hexParts;
  if (!/^[0-9a-f]{1,4}$/i.test(hiRaw) || !/^[0-9a-f]{1,4}$/i.test(loRaw)) {
    return undefined;
  }

  const hi = Number.parseInt(hiRaw, 16);
  const lo = Number.parseInt(loRaw, 16);
  return `${(hi >> 8) & 0xff}.${hi & 0xff}.${(lo >> 8) & 0xff}.${lo & 0xff}`;
}

function parseIPv6FirstHextet(host: string): number | undefined {
  const first = host.split(':', 1)[0];
  if (!first || !/^[0-9a-f]{1,4}$/i.test(first)) return undefined;
  return Number.parseInt(first, 16);
}

function parseLegacyIPv4Part(value: string, max: number): number | undefined {
  let parsed: number;
  if (/^0x[0-9a-f]+$/i.test(value)) {
    parsed = Number.parseInt(value.slice(2), 16);
  } else if (/^0[0-7]+$/.test(value)) {
    parsed = Number.parseInt(value, 8);
  } else if (/^[0-9]+$/.test(value)) {
    parsed = Number.parseInt(value, 10);
  } else {
    return undefined;
  }
  return parsed <= max ? parsed : undefined;
}

// Match URL parsers that still accept inet_aton-style IPv4 aliases, so blocked
// host checks also catch SSH sources such as git@0177.1:owner/repo.git.
function parseLegacyIPv4Host(host: string): string | undefined {
  const parts = host.split('.');
  if (parts.length < 1 || parts.length > 4 || parts.some((part) => !part)) {
    return undefined;
  }

  // In legacy one-, two-, and three-part IPv4 forms, the final part carries the
  // remaining bytes rather than a single octet.
  const maxLastPart = [0xffffffff, 0xffffff, 0xffff, 0xff][parts.length - 1];
  if (maxLastPart === undefined) return undefined;

  const parsed = parts.map((part, index) =>
    parseLegacyIPv4Part(part, index === parts.length - 1 ? maxLastPart : 0xff),
  );
  if (parsed.some((part) => part === undefined)) return undefined;

  const values = parsed as number[];
  const numeric =
    values.length === 1
      ? values[0]
      : values.length === 2
        ? values[0] * 0x1000000 + values[1]
        : values.length === 3
          ? values[0] * 0x1000000 + values[1] * 0x10000 + values[2]
          : values[0] * 0x1000000 +
            values[1] * 0x10000 +
            values[2] * 0x100 +
            values[3];

  return [
    Math.floor(numeric / 0x1000000) & 0xff,
    Math.floor(numeric / 0x10000) & 0xff,
    Math.floor(numeric / 0x100) & 0xff,
    numeric & 0xff,
  ].join('.');
}

export function isBlockedAuthProviderHost(hostname: string): boolean {
  const stripped = hostname.endsWith('.') ? hostname.slice(0, -1) : hostname;
  const host = stripped.toLowerCase();
  if (host === 'localhost' || host.endsWith('.localhost')) return true;

  const bareHost =
    host.startsWith('[') && host.endsWith(']') ? host.slice(1, -1) : host;
  const blocklistHost = parseLegacyIPv4Host(bareHost) ?? bareHost;
  const ipVersion = net.isIP(blocklistHost);
  if (ipVersion === 4) {
    const parts = blocklistHost.split('.').map((part) => Number(part));
    const [a, b] = parts;
    return (
      a === 0 ||
      a === 10 ||
      a === 127 ||
      (a === 100 && b !== undefined && b >= 64 && b <= 127) ||
      (a === 169 && b === 254) ||
      (a === 172 && b !== undefined && b >= 16 && b <= 31) ||
      (a === 192 && b === 168)
    );
  }

  if (ipVersion === 6) {
    if (blocklistHost === '::' || blocklistHost === '::1') return true;
    const firstHextet = parseIPv6FirstHextet(blocklistHost);
    if (
      firstHextet !== undefined &&
      ((firstHextet >= 0xfe80 && firstHextet <= 0xfebf) ||
        (firstHextet & 0xfe00) === 0xfc00)
    ) {
      return true;
    }
    if (blocklistHost.startsWith('::ffff:')) {
      const suffix = blocklistHost.slice('::ffff:'.length);
      if (net.isIP(suffix) === 4) {
        return isBlockedAuthProviderHost(suffix);
      }
      const mappedIPv4 = parseIPv4MappedHexSuffix(suffix);
      return mappedIPv4 ? isBlockedAuthProviderHost(mappedIPv4) : true;
    }
  }

  return false;
}

function parseAuthProviderBaseUrl(
  value: unknown,
  allowPrivateBaseUrl: boolean,
): string | undefined | null {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (!trimmed) return undefined;
  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    return null;
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null;
  if (parsed.username || parsed.password) return null;
  if (!allowPrivateBaseUrl && isBlockedAuthProviderHost(parsed.hostname)) {
    return null;
  }
  return parsed.toString().replace(/\/$/, '');
}

type AuthProviderParseResult =
  | { ok: true; value: ServeAuthProviderInstallRequest }
  | { ok: false; code: string; error: string };

export function parseAuthProviderInstallRequest(
  body: Record<string, unknown>,
  options?: { allowPrivateBaseUrl?: boolean },
): AuthProviderParseResult {
  const providerId = body['providerId'];
  const apiKey = body['apiKey'];
  if (
    typeof providerId !== 'string' ||
    providerId.trim().length === 0 ||
    typeof apiKey !== 'string' ||
    apiKey.trim().length === 0
  ) {
    return {
      ok: false,
      code: 'invalid_request',
      error: '`providerId` and `apiKey` are required',
    };
  }
  const protocol = body['protocol'];
  const baseUrl = parseAuthProviderBaseUrl(
    body['baseUrl'],
    options?.allowPrivateBaseUrl === true,
  );
  if (baseUrl === null) {
    return {
      ok: false,
      code: 'invalid_base_url',
      error:
        '`baseUrl` must be an http(s) URL without credentials or blocked private-network host',
    };
  }
  const modelIds = parseStringArray(body['modelIds']);
  const rawAdvanced =
    body['advancedConfig'] && typeof body['advancedConfig'] === 'object'
      ? (body['advancedConfig'] as Record<string, unknown>)
      : undefined;
  const rawMultimodal =
    rawAdvanced?.['multimodal'] && typeof rawAdvanced['multimodal'] === 'object'
      ? (rawAdvanced['multimodal'] as Record<string, unknown>)
      : undefined;
  const contextWindowSize = parsePositiveBoundedInteger(
    rawAdvanced?.['contextWindowSize'],
    10_000_000,
  );
  const maxTokens = parsePositiveBoundedInteger(
    rawAdvanced?.['maxTokens'],
    10_000_000,
  );
  const advancedConfig = rawAdvanced
    ? {
        ...(typeof rawAdvanced['enableThinking'] === 'boolean'
          ? { enableThinking: rawAdvanced['enableThinking'] }
          : {}),
        ...(rawMultimodal
          ? {
              multimodal: {
                ...(typeof rawMultimodal['image'] === 'boolean'
                  ? { image: rawMultimodal['image'] }
                  : {}),
                ...(typeof rawMultimodal['pdf'] === 'boolean'
                  ? { pdf: rawMultimodal['pdf'] }
                  : {}),
                ...(typeof rawMultimodal['audio'] === 'boolean'
                  ? { audio: rawMultimodal['audio'] }
                  : {}),
                ...(typeof rawMultimodal['video'] === 'boolean'
                  ? { video: rawMultimodal['video'] }
                  : {}),
              },
            }
          : {}),
        ...(contextWindowSize !== undefined ? { contextWindowSize } : {}),
        ...(maxTokens !== undefined ? { maxTokens } : {}),
      }
    : undefined;
  return {
    ok: true,
    value: {
      providerId: providerId.trim(),
      ...(typeof protocol === 'string' && protocol.trim()
        ? {
            protocol:
              protocol.trim() as ServeAuthProviderInstallRequest['protocol'],
          }
        : {}),
      ...(baseUrl ? { baseUrl } : {}),
      apiKey,
      ...(modelIds ? { modelIds } : {}),
      ...(advancedConfig ? { advancedConfig } : {}),
    },
  };
}
