/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { createHash } from 'node:crypto';
import { AuthType } from '@qwen-code/qwen-code-core/core/contentGenerator.js';
import { ModelsConfig } from '@qwen-code/qwen-code-core/models/modelsConfig.js';
import { loadSettings } from '../config/settings.js';
import {
  getAuthTypeFromEnv,
  resolveCliGenerationConfig,
} from '../utils/modelConfigUtils.js';
import {
  signedManagedHeaders,
  type ManagedLocalWebOptions,
} from './managed-local-web.js';

export interface ManagedLocalModel {
  modelId: string;
  label: string;
}

export function loadManagedLocalModels(): {
  models: ManagedLocalModel[];
  defaultModelId?: string;
} {
  const { merged } = loadSettings(process.cwd(), {
    skipLoadEnvironment: true,
    skipWorkspaceSettings: true,
    workspaceTrusted: false,
  });
  const configured = new ModelsConfig({
    modelProvidersConfig: merged.modelProviders,
    providerProtocolConfig: merged.providerProtocol,
  }).getAllConfiguredModels();
  const selection = resolveCliGenerationConfig({
    argv: {},
    settings: merged,
    selectedAuthType:
      merged.security?.auth?.selectedType ?? getAuthTypeFromEnv(),
  });
  const models = configured
    .filter(
      (model) =>
        model.authType !== AuthType.QWEN_OAUTH &&
        !model.fastOnly &&
        !model.voiceOnly &&
        !model.visionOnly &&
        !model.imageOnly &&
        configured.filter((candidate) => candidate.id === model.id).length ===
          1,
    )
    .map((model) => ({ modelId: model.id, label: model.label || model.id }));
  const selected = models.findIndex(
    (model) =>
      model.modelId === selection.model &&
      configured.some(
        (candidate) =>
          candidate.id === model.modelId &&
          candidate.authType === selection.authType,
      ),
  );
  if (selected > 0) models.unshift(...models.splice(selected, 1));
  return {
    models,
    defaultModelId: selected >= 0 ? selection.model : undefined,
  };
}

export async function registerManagedLocalModels(
  options: Pick<
    ManagedLocalWebOptions,
    'javaUrl' | 'signingKey' | 'tenantId' | 'actorId'
  >,
  models: readonly ManagedLocalModel[],
): Promise<Array<{ agentId: string; label: string }>> {
  const presets = [];
  for (const model of models) {
    const route = '/v1/agents';
    const body = Buffer.from(
      JSON.stringify({
        model: { id: model.modelId },
        instructions: '',
        tools: [
          { type: 'hosted_profile', profile: 'hosted-workspace-shell/1' },
        ],
        permission_policy: { approval_mode: 'default' },
      }),
    );
    const idempotencyKey = `managed-local-model-v1-${createHash('sha256').update(body).digest('hex')}`;
    const response = await fetch(`${options.javaUrl}${route}`, {
      method: 'POST',
      headers: {
        ...signedManagedHeaders({
          ...options,
          method: 'POST',
          path: route,
          body,
          idempotencyKey,
        }),
        'Content-Type': 'application/json',
      },
      body,
      signal: AbortSignal.timeout(30_000),
    });
    if (!response.ok) {
      await response.body?.cancel();
      throw new Error(`Local model registration failed (${response.status}).`);
    }
    const definition: unknown = await response.json().catch(() => null);
    if (
      !definition ||
      typeof definition !== 'object' ||
      !('id' in definition) ||
      typeof definition.id !== 'string' ||
      !/^agent_[0-9a-f]{32}$/u.test(definition.id)
    ) {
      throw new Error('Local model registration returned an invalid agent ID.');
    }
    presets.push({ agentId: definition.id, label: model.label });
  }
  return presets;
}
