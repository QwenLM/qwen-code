/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type { MutableRefObject } from 'react';
import {
  assertModelConfigSupported,
  getErrorMessage,
  isContextWindowSelectionEnabled,
  ModelNotFoundError,
  tokenLimit,
  type Config,
  type Model,
  type ModelConfig,
  type PermissionMode,
  type PermissionModeChangeTelemetryContext,
  type ReasoningEffortLevel,
} from '@qwen-code/core';
import type { SessionHandle, SessionSettings } from '../../session/session.js';
import { sessionModelToOptionsModel } from '../commands/modelOptionsCommandUtils.js';

/** Compatibility for existing UI/command Config calls; never given to an executor. */
export function createSessionConfig(
  config: Config,
  binding: MutableRefObject<{
    session: SessionHandle;
    settings: SessionSettings;
    kind?: 'local' | 'external';
  }>,
  reportError: (message: string) => void,
): Config {
  let modelRevision = 0;
  const send = (operation: string, request: Promise<unknown>) => {
    void request.catch((error: unknown) =>
      reportError(`Failed to ${operation}: ${getErrorMessage(error)}`),
    );
  };
  const getSessionModel = (key: string): Model | undefined => {
    const entry = binding.current.session
      .getState()
      .models?.find((model) => model.modelId === key || model.value === key);
    return entry ? sessionModelToOptionsModel(entry).preferenceModel : undefined;
  };
  let sessionManager: ReturnType<Config['getModelProviderManager']> | undefined;
  const getSessionManager = () => {
    sessionManager ??= new Proxy(config.getModelProviderManager(), {
      get(target, property) {
        if (property === 'getMainModel')
          return async (): Promise<Model> => {
            const key = binding.current.settings.model;
            const model = getSessionModel(key);
            if (!model) {
              throw new ModelNotFoundError(
                `Main model "${key}" not found in the bound session's catalog.`,
                404,
              );
            }
            return model;
          };
        if (property === 'getModel')
          return async (key: string): Promise<Model | undefined> =>
            getSessionModel(key) ?? target.getModel(key);
        if (property === 'getModelConfig')
          return (model: Model): ModelConfig | undefined =>
            model.key === binding.current.settings.model
              ? {
                  reasoning: {
                    effort: binding.current.settings.reasoningEffort,
                  },
                  context: {
                    contextWindow: binding.current.settings.contextWindow,
                  },
                }
              : undefined;
        if (property === 'setModelConfig')
          return (model: Model, patch: ModelConfig): boolean => {
            if (model.key !== binding.current.settings.model) return false;
            assertModelConfigSupported(model, patch);
            if (patch.reasoning && 'effort' in patch.reasoning) {
              const effort = patch.reasoning.effort;
              binding.current.settings = {
                ...binding.current.settings,
                reasoningEffort: effort,
              };
              send(
                'set reasoning effort',
                binding.current.session.setModel(model.key, effort),
              );
            }
            if (patch.context && 'contextWindow' in patch.context) {
              const contextWindow = patch.context.contextWindow;
              binding.current.settings = {
                ...binding.current.settings,
                contextWindow,
              };
              send(
                'set context window',
                binding.current.session.setContextWindow(contextWindow),
              );
            }
            return true;
          };
        const value = (target as unknown as Record<PropertyKey, unknown>)[
          property
        ];
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
    return sessionManager;
  };
  const view = new Proxy(config, {
    get(target, property) {
      // Native model selection and preferences keep their original Config methods.
      if (
        binding.current.kind === 'local' &&
        property !== 'config' &&
        (!binding.current.session ||
          (property !== 'getPermissionMode' &&
            property !== 'setPermissionMode' &&
            property !== 'setModel' &&
            property !== 'persistSessionTitle'))
      ) {
        const value = (target as unknown as Record<PropertyKey, unknown>)[
          property
        ];
        return typeof value === 'function' ? value.bind(target) : value;
      }
      if (property === 'config') return view;
      if (property === 'getModelProviderManager') return getSessionManager;
      if (property === 'getModel' || property === 'getActiveModel')
        return () => binding.current.settings.model;
      if (property === 'getReasoningEffort')
        return (model?: string) =>
          model === undefined || model === binding.current.settings.model
            ? binding.current.settings.reasoningEffort
            : undefined;
      if (property === 'getContextWindow')
        return () =>
          isContextWindowSelectionEnabled()
            ? binding.current.settings.contextWindow
            : undefined;
      if (property === 'getEffectiveContextWindow')
        return (
          model: Model | undefined,
          modelId = model?.key ?? binding.current.settings.model,
        ) =>
          isContextWindowSelectionEnabled()
            ? config.resolveEffectiveContextWindow(
                model,
                binding.current.settings.contextWindow,
                modelId,
              )
            : tokenLimit(model);
      if (property === 'setModel')
        return async (
          model: string,
          sessionOnly?: boolean,
          reasoningEffort?: ReasoningEffortLevel,
          contextWindow?: number,
        ) => {
          if (binding.current.kind === 'local') {
            const saved = await binding.current.session.setModel(
              model,
              undefined,
              undefined,
              { sessionOnly },
            );
            return saved !== false;
          }
          const revision = ++modelRevision;
          const identity = config.getModelRequestIdentity();
          const sessionId = config.getSessionId();
          const session = binding.current.session;
          await session.setModel(model, reasoningEffort, contextWindow);
          if (
            revision !== modelRevision ||
            session !== binding.current.session ||
            identity !== config.getModelRequestIdentity() ||
            sessionId !== config.getSessionId()
          )
            return false;
          binding.current.settings = {
            ...binding.current.settings,
            model,
            ...(reasoningEffort !== undefined ? { reasoningEffort } : {}),
            ...(contextWindow !== undefined ? { contextWindow } : {}),
          };
          return true;
        };
      if (property === 'setReasoningEffort')
        return (reasoningEffort?: ReasoningEffortLevel) => {
          binding.current.settings = {
            ...binding.current.settings,
            reasoningEffort,
          };
          send(
            'set reasoning effort',
            binding.current.session.setModel(
              binding.current.settings.model,
              reasoningEffort,
              undefined,
            ),
          );
        };
      if (property === 'setContextWindow')
        return (contextWindow?: number) => {
          binding.current.settings = {
            ...binding.current.settings,
            contextWindow,
          };
          send(
            'set context window',
            binding.current.session.setContextWindow(contextWindow),
          );
        };
      if (property === 'setModelPreference') return () => undefined;
      if (property === 'getPermissionMode')
        return () => binding.current.settings.permissionMode;
      if (property === 'setPermissionMode')
        return (
          permissionMode: PermissionMode,
          context?: PermissionModeChangeTelemetryContext,
        ) => {
          const previous = binding.current.settings.permissionMode;
          binding.current.settings = {
            ...binding.current.settings,
            permissionMode,
          };
          try {
            send(
              'set permission mode',
              binding.current.kind === 'local'
                ? binding.current.session.setPermissionMode(
                    permissionMode,
                    context,
                  )
                : binding.current.session.setPermissionMode(permissionMode),
            );
          } catch (error) {
            binding.current.settings = {
              ...binding.current.settings,
              permissionMode: previous,
            };
            throw error;
          }
        };
      if (property === 'persistSessionTitle')
        return (title: string) => binding.current.session.setTitle(title);
      const value = (target as unknown as Record<PropertyKey, unknown>)[
        property
      ];
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
  return view;
}
