/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * @fileoverview /context slash command — visualizes the current context
 * window usage as a coloured progress bar with per-category token breakdown.
 */

import { systemPromptToText } from '@qwen-code/core';
import {
  CommandKind,
  type CommandContext,
  type SlashCommand,
} from './types.js';
import { ContextWindowPanel } from '../components/ContextWindowPanel.js';
import type { SkillDetail } from '../components/ContextWindowPanel.js';
import type { PromptBuildResult } from '@qwen-code/core';
import { collectContextUsage } from '../../services/contextUsage/contextUsageCollector.js';

export const contextCommand: SlashCommand = {
  name: 'context',
  description: 'Visualize current context window usage',
  kind: CommandKind.BUILT_IN,
  autoExecute: true,
  isSafeConcurrent: true,
  action: async (context: CommandContext) => {
    const config = context.services.agentContext?.config;
    if (!config) {
      return {
        type: 'message',
        messageType: 'error',
        content: 'Config not loaded.',
      };
    }

    const messages = context.messages ?? [];
    let promptBuildResult: PromptBuildResult | undefined =
      context.services.agentContext?.getPromptBuildResult?.();
    if (!promptBuildResult) {
      promptBuildResult = await context.ensurePromptBuildResult?.();
    }
    const snapshot = await collectContextUsage({
      config,
      messages,
      requestSnapshot: config.getCacheSafeQuerySnapshot?.(),
      cachedSystemPrompt: promptBuildResult?.blocks,
      // 渲染文本就是 build result 的 text，别再走第二个 accessor。
      cachedRenderedSystemPrompt: promptBuildResult
        ? systemPromptToText(promptBuildResult.blocks)
        : undefined,
      cachedParentToolSchemas:
        context.services.agentContext?.getParentToolSchemas?.(),
      session: {
        metrics: context.session.stats.metrics,
      },
    });

    return {
      type: 'custom_dialog',
      component: (
        <ContextWindowPanel
          model={snapshot.model}
          contextWindowSize={snapshot.rawContextWindowTokens}
          tokenUsage={snapshot.tokenUsage}
          messageCount={messages.length}
          tokenStats={snapshot.tokenStats}
          systemPromptTokens={snapshot.systemPromptTokens}
          toolSchemaTokens={snapshot.toolSchemaTokens}
          skillDetails={snapshot.skillDetails as SkillDetail[]}
          skillFrontmatterTokens={snapshot.skillFrontmatterTokens}
          promptBuild={promptBuildResult}
          sessionStats={{
            ...context.session.stats,
            promptCount: snapshot.session.promptCount,
          }}
          onClose={() => context.ui.removeComponent()}
        />
      ),
    };
  },
};
