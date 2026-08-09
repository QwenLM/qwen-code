/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type { AvailableModel } from '@qwen-code/qwen-code-core';

export type AcpModelDisplayInput = {
  model: AvailableModel;
  modelId: string;
};

export type AcpModelDisplayFields = {
  name: string;
  description: string | null | undefined;
  providerLabel?: string;
  legacyName?: string;
};

const SHORTEN_EXACT: ReadonlyMap<string, string> = new Map([
  ['ModelStudio Token Plan for Global/Intl', 'Token Plan (Intl)'],
  ['ModelStudio Token Plan', 'Token Plan'],
  ['ModelStudio Coding Plan for Global/Intl', 'Coding Plan (Intl)'],
  ['ModelStudio Coding Plan', 'Coding Plan'],
  ['ModelStudio Standard', 'ModelStudio'],
]);

export function parseLeadingBracketPrefix(label: string): string | undefined {
  const match = label.match(/^\[([^\]]+)\]\s*/);
  if (!match) return undefined;
  const raw = match[1]?.trim();
  return raw && raw.length > 0 ? raw : undefined;
}

export function shortenProviderLabel(rawPrefix: string): string {
  const trimmed = rawPrefix.trim();
  return SHORTEN_EXACT.get(trimmed) ?? trimmed;
}

function endpointSnip(model: AvailableModel): string | undefined {
  const endpoint = model.registryBaseUrl ?? model.baseUrl;
  if (!endpoint) return undefined;
  try {
    const url = new URL(endpoint);
    const segments = url.pathname.split('/').filter(Boolean);
    const last = segments[segments.length - 1];
    if (last && !/^v\d+$/i.test(last)) {
      return last;
    }
    return url.hostname || undefined;
  } catch {
    const parts = endpoint.replace(/\/+$/, '').split('/');
    const last = parts[parts.length - 1];
    return last && last.length > 0 ? last : undefined;
  }
}

function resolveBadge(model: AvailableModel): string {
  const parsed = parseLeadingBracketPrefix(model.label);
  if (parsed) {
    return shortenProviderLabel(parsed);
  }
  if (model.envKey) {
    return model.envKey;
  }
  return endpointSnip(model) ?? '';
}

function collisionBadge(modelId: string, primaryBadge: string): string {
  return primaryBadge || modelId.slice(-6);
}

/** Collision-aware: pass the full emission list once. */
export function buildAcpModelDisplayFields(
  options: readonly AcpModelDisplayInput[],
): AcpModelDisplayFields[] {
  const badges = options.map(({ model }) => resolveBadge(model));

  const groups = new Map<string, number[]>();
  for (let i = 0; i < options.length; i++) {
    const bare = options[i]!.model.id;
    const list = groups.get(bare);
    if (list) {
      list.push(i);
    } else {
      groups.set(bare, [i]);
    }
  }

  const names = new Array<string>(options.length);
  for (const [, indices] of groups) {
    if (indices.length === 1) {
      const i = indices[0]!;
      names[i] = options[i]!.model.id;
      continue;
    }

    const used = new Set<string>();
    for (const i of indices) {
      const { model, modelId } = options[i]!;
      const bare = model.id;
      const badge = collisionBadge(modelId, badges[i]!);
      let name = `${bare} · ${badge}`;
      if (used.has(name)) {
        let n = 2;
        while (used.has(`${bare} · ${n}`)) {
          n++;
        }
        name = `${bare} · ${n}`;
      }
      used.add(name);
      names[i] = name;
    }
  }

  return options.map(({ model }, i) => {
    const name = names[i]!;
    const badge = badges[i]!;
    const hasDescription =
      model.description != null && model.description !== '';
    let description = model.description;
    if (!hasDescription && badge) {
      description = badge;
    }

    const fields: AcpModelDisplayFields = {
      name,
      description,
    };
    if (badge) {
      fields.providerLabel = badge;
    }
    if (model.label !== name) {
      fields.legacyName = model.label;
    }
    return fields;
  });
}
