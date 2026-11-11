/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { MODEL_ONLY_HINTS } from '../codemode/types.js';
import {
  UPDATE_TOPIC_TOOL_NAME,
  UPDATE_TOPIC_DISPLAY_NAME,
  TOPIC_PARAM_TITLE,
  TOPIC_PARAM_SUMMARY,
  TOPIC_PARAM_STRATEGIC_INTENT,
} from './definitions/coreTools.js';
import {
  BaseDeclarativeTool,
  BaseToolInvocation,
  Kind,
  type PayloadResult,
  type ToolResult,
} from './tools.js';
import { runLogger } from '../utils/runLogger.js';
import { truncateString } from '../utils/textUtils.js';
import { getUpdateTopicDeclaration } from './definitions/dynamic-declaration-helpers.js';
import type { Config } from '../config/config.js';
import { boundedProducerPayload } from './producer-result-bounds.js';

interface UpdateTopicParams {
  [TOPIC_PARAM_TITLE]?: string;
  [TOPIC_PARAM_SUMMARY]?: string;
  [TOPIC_PARAM_STRATEGIC_INTENT]?: string;
}

class UpdateTopicInvocation extends BaseToolInvocation<
  UpdateTopicParams,
  ToolResult
> {
  constructor(
    params: UpdateTopicParams,
    toolName: string,
    private readonly config: Config,
  ) {
    super(params, toolName);
  }

  getDescription(): string {
    const title = this.params[TOPIC_PARAM_TITLE];
    const intent = this.params[TOPIC_PARAM_STRATEGIC_INTENT];
    if (title) {
      return `Update topic to: "${title}"`;
    }
    return `Update tactical intent: "${intent || '...'}"`;
  }

  async execute(): Promise<ToolResult> {
    const title = this.params[TOPIC_PARAM_TITLE];
    const summary = this.params[TOPIC_PARAM_SUMMARY];
    const strategicIntent = this.params[TOPIC_PARAM_STRATEGIC_INTENT];

    runLogger.log(
      `[TopicTool] execute called with title="${title ?? ''}", summary="${summary ? truncateString(summary, 80, '...') : ''}", intent="${strategicIntent ?? ''}"`,
    );

    const activeTopic = this.config.topicState.getTopic();
    const isNewTopic = !!(
      title &&
      title.trim() !== '' &&
      title.trim() !== activeTopic
    );

    if (!this.config.topicState.setTopic(title, strategicIntent)) {
      runLogger.warn(`[TopicTool] setTopic returned false`);
    }

    const currentTopic = this.config.topicState.getTopic() || '...';
    const currentIntent =
      strategicIntent || this.config.topicState.getIntent() || '...';

    runLogger.log(
      `[TopicTool] Update: Topic="${currentTopic}", Intent="${currentIntent}", isNew=${isNewTopic}`,
    );

    let llmContent = '';
    let returnDisplay = '';

    if (isNewTopic) {
      // Handle New Topic Header & Summary
      llmContent = `Current topic: "${currentTopic}"\nTopic summary: ${summary || '...'}`;
      returnDisplay = `## 📂 Topic: **${currentTopic}**\n\n**Summary:**\n${summary || '...'}`;

      if (strategicIntent && strategicIntent.trim()) {
        llmContent += `\n\nStrategic Intent: ${strategicIntent.trim()}`;
        returnDisplay += `\n\n> [!STRATEGY]\n> **Intent:** ${strategicIntent.trim()}`;
      }
    } else {
      // Tactical update only
      llmContent = `Strategic Intent: ${currentIntent}`;
      returnDisplay = `> [!STRATEGY]\n> **Intent:** ${currentIntent}`;
    }

    return {
      llmContent,
      returnDisplay,
      toolUseResult: {
        summary: returnDisplay,
        payload: boundedProducerPayload(summary || strategicIntent || ''),
      } satisfies PayloadResult,
    };
  }
}

/**
 * Tool to update semantic topic context and tactical intent for UI grouping and model focus.
 */
export class UpdateTopicTool extends BaseDeclarativeTool<
  UpdateTopicParams,
  ToolResult
> {
  override get exposureHints() {
    return MODEL_ONLY_HINTS;
  }
  constructor(private readonly config: Config) {
    const declaration = getUpdateTopicDeclaration();
    super(
      UPDATE_TOPIC_TOOL_NAME,
      UPDATE_TOPIC_DISPLAY_NAME,
      declaration.description ?? '',
      Kind.Think,
      declaration.parametersJsonSchema,
    );
  }

  protected createInvocation(params: UpdateTopicParams): UpdateTopicInvocation {
    return new UpdateTopicInvocation(params, this.name, this.config);
  }
}
