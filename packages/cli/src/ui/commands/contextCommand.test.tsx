/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { afterEach, describe, expect, it, vi } from 'vitest';
import { isValidElement, type ReactElement } from 'react';
import { testListedModel } from '../../../../core/src/test-utils/listed-model.js';
import {
  uiTelemetryService,
  createUserMessage,
  type Message,
  type Config,
  type PromptBuildResult,
} from '@qwen-code/core';
import { createSessionConfig } from '../session/sessionConfig.js';
import type { SessionHandle } from '../../session/session.js';
import { contextCommand } from './contextCommand.js';
import { createMockCommandContext } from '../../test-utils/mockCommandContext.js';

interface ContextWindowPanelProps {
  model: string;
  contextWindowSize: number;
  tokenUsage: number;
  systemPromptTokens: number;
  sessionStats: { promptCount: number };
  promptBuild?: PromptBuildResult;
}

async function getContextDialogProps(
  messages: readonly Message[],
  promptBuildResult?: PromptBuildResult,
  ensurePromptBuildResult?: () => Promise<PromptBuildResult | undefined>,
  suppliedConfig?: Config,
): Promise<ContextWindowPanelProps> {
  const config =
    suppliedConfig ??
    ({
      getModel: vi.fn(() => 'test-model'),
      getModelProviderManager: () => ({
        getMainModel: vi.fn(async () => testListedModel('test-model')),
      }),
      getWorkingDir: () => '/context-command-test',
      getSessionArtifactProjectRoot: () => '/context-command-test',
      getSessionId: () => 'context-command-test',
      getEffectiveContextWindow: vi.fn(() => 100_000),
      getSkillManager: vi.fn(() => ({
        getDisplayableSkills: vi.fn(() => []),
      })),
      isContextManagementEnabled: vi.fn(() => true),
    } as unknown as Config);
  const context = createMockCommandContext({
    messages,
    services: {
      agentContext: {
        config,
        getSystemPrompt: vi.fn(() => [
          { type: 'text', text: 'cached system prompt' },
        ]),
        getPromptBuildResult: vi.fn(() => promptBuildResult),
        getParentToolSchemas: vi.fn(() => [
          { name: 'Read', description: 'Read', parameters: {} },
        ]),
      },
    },
  });
  Object.assign(context, { ensurePromptBuildResult });
  const result = await contextCommand.action!(context, '');

  expect(result).toMatchObject({ type: 'custom_dialog' });
  if (!result || result.type !== 'custom_dialog') {
    throw new Error('Expected custom_dialog result');
  }

  const element = result.component;
  expect(isValidElement(element)).toBe(true);
  if (!isValidElement(element)) {
    throw new Error('Expected React element result');
  }

  return (element as ReactElement<ContextWindowPanelProps>).props;
}

describe('contextCommand', () => {
  afterEach(() => {
    uiTelemetryService.clear('context-command-test');
  });

  it('reads model and effective window through the session config without command-specific branching', async () => {
    const localManager = {
      getMainModel: vi.fn(async () => testListedModel('local-model')),
      getModel: vi.fn(async () => testListedModel('local-model')),
    };
    const local = {
      getModel: vi.fn(() => 'local-model'),
      getModelProviderManager: () => localManager,
      getSessionArtifactProjectRoot: () => '/context-command-test',
      getSessionId: () => 'context-command-test',
      getEffectiveContextWindow: vi.fn(() => 100_000),
      resolveEffectiveContextWindow: vi.fn(
        (_model: string, selected?: number) => selected ?? 200_000,
      ),
      getSkillManager: () => ({ getDisplayableSkills: () => [] }),
      isContextManagementEnabled: () => true,
    };
    const view = createSessionConfig(
      local as unknown as Config,
      {
        current: {
          session: {
            getState: () => ({
              models: [
                {
                  modelId: 'qwen3.7-max',
                  displayName: 'Remote model',
                  source: 'system',
                  defaultContextWindow: 200_000,
                  availableContextWindows: [200_000, 1_000_000],
                },
              ],
            }),
          } as unknown as SessionHandle,
          settings: {
            model: 'qwen3.7-max',
            contextWindow: 1_000_000,
            permissionMode: 'default',
          },
        },
      },
      vi.fn(),
    );
    const props = await getContextDialogProps([], undefined, undefined, view);
    expect(props.model).toBe('qwen3.7-max');
    expect(props.contextWindowSize).toBe(1_000_000);
    expect(local.getModel).not.toHaveBeenCalled();
    expect(local.getEffectiveContextWindow).not.toHaveBeenCalled();
    expect(localManager.getMainModel).not.toHaveBeenCalled();
    expect(localManager.getModel).not.toHaveBeenCalled();
  });

  it('re-estimates resumed history instead of using stale status-line telemetry', async () => {
    uiTelemetryService.setLastPromptTokenCount(45_000);

    const props = await getContextDialogProps([
      createUserMessage('resumed transcript without assistant usage'),
    ]);

    expect(props.tokenUsage).toBeGreaterThan(0);
    expect(props.tokenUsage).toBeLessThan(100);
  });

  it('shows the selected model and window without requiring a new request', async () => {
    let model = 'fast';
    let contextWindow = 1_000_000;
    const requestSnapshot = { model: 'fast', contextWindow: 1_000_000 };
    const config = {
      getModel: () => model,
      getModelProviderManager: () => ({
        getMainModel: async () => testListedModel(model),
      }),
      getCacheSafeQuerySnapshot: () => requestSnapshot,
      getSessionArtifactProjectRoot: () => '/context-command-test',
      getSessionId: () => 'context-command-test',
      getEffectiveContextWindow: () => contextWindow,
      getSkillManager: () => ({ getDisplayableSkills: () => [] }),
      isContextManagementEnabled: () => true,
    } as unknown as Config;

    const before = await getContextDialogProps([], undefined, undefined, config);
    expect(before.model).toBe('fast');
    expect(before.contextWindowSize).toBe(1_000_000);

    model = 'ultimate';
    contextWindow = 200_000;
    const switched = await getContextDialogProps([], undefined, undefined, config);
    expect(switched.model).toBe('ultimate');
    expect(switched.contextWindowSize).toBe(200_000);

    contextWindow = 400_000;
    const adjusted = await getContextDialogProps([], undefined, undefined, config);
    expect(adjusted.model).toBe('ultimate');
    expect(adjusted.contextWindowSize).toBe(400_000);
    expect(requestSnapshot).toEqual({ model: 'fast', contextWindow: 1_000_000 });
  });

  it('uses persisted human inputs for the displayed prompt count', async () => {
    const props = await getContextDialogProps([
      createUserMessage('fix the bug', {
        humanInput: { text: 'fix the bug', mode: 'prompt' },
      }),
      createUserMessage('internal context', { isMeta: true }),
    ]);

    expect(props.sessionStats.promptCount).toBe(1);
  });

  it('forwards the last real prompt build result', async () => {
    const props = await getContextDialogProps([], {
      blocks: [{ type: 'text', text: 'rendered prompt' }],
      source: 'default',
      bundle: 'lean',
    });

    expect(props.promptBuild).toEqual({
      blocks: [{ type: 'text', text: 'rendered prompt' }],
      source: 'default',
      bundle: 'lean',
    });
  });

  it('builds the current prompt when a resumed session has no cached prompt', async () => {
    const ensurePromptBuildResult = vi.fn(async () => ({
      blocks: [{ type: 'text' as const, text: 'rebuilt system prompt' }],
      source: 'default' as const,
      bundle: 'lean' as const,
    }));

    const props = await getContextDialogProps(
      [],
      undefined,
      ensurePromptBuildResult,
    );

    expect(ensurePromptBuildResult).toHaveBeenCalledOnce();
    expect(props.promptBuild).toEqual({
      blocks: [{ type: 'text', text: 'rebuilt system prompt' }],
      source: 'default',
      bundle: 'lean',
    });
    expect(props.systemPromptTokens).toBeGreaterThan(0);
  });
});
