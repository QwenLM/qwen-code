/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import { BaseDeclarativeTool, BaseToolInvocation, Kind } from './tools.js';
import { ToolNames, ToolDisplayNames } from './tool-names.js';
import type { ToolResult, ToolResultDisplay } from './tools.js';
import type { Config } from '../config/config.js';
import type { ResolvedModelConfig } from '../models/types.js';
import {
  MultiModelReviewService,
  type CollectedReview,
} from '../services/multiModelReviewService.js';
import { createDebugLogger } from '../utils/debugLogger.js';

const debugLogger = createDebugLogger('MULTI_MODEL_REVIEW_TOOL');

export interface MultiModelReviewParams {
  diff: string;
}

/**
 * Tool for multi-model code review.
 * Sends the diff to multiple configured review models in parallel,
 * then arbitrates results into a unified report.
 */
export class MultiModelReviewTool extends BaseDeclarativeTool<
  MultiModelReviewParams,
  ToolResult
> {
  static readonly Name: string = ToolNames.MULTI_MODEL_REVIEW;

  constructor(private readonly config: Config) {
    const schema = {
      type: 'object',
      properties: {
        diff: {
          type: 'string',
          description: 'The code diff to review',
        },
      },
      required: ['diff'],
      additionalProperties: false,
      $schema: 'http://json-schema.org/draft-07/schema#',
    };

    super(
      MultiModelReviewTool.Name,
      ToolDisplayNames.MULTI_MODEL_REVIEW,
      'Run multi-model code review. Sends the diff to multiple configured review models in parallel, then produces a unified review report. Requires review.models to be configured in settings with at least 2 models.',
      Kind.Read,
      schema,
      true, // isOutputMarkdown
      false, // canUpdateOutput
    );
  }

  override validateToolParams(params: MultiModelReviewParams): string | null {
    if (
      !params.diff ||
      typeof params.diff !== 'string' ||
      !params.diff.trim()
    ) {
      return 'Parameter "diff" must be a non-empty string.';
    }
    return null;
  }

  protected createInvocation(params: MultiModelReviewParams) {
    return new MultiModelReviewInvocation(this.config, params);
  }
}

class MultiModelReviewInvocation extends BaseToolInvocation<
  MultiModelReviewParams,
  ToolResult
> {
  constructor(
    private readonly config: Config,
    params: MultiModelReviewParams,
  ) {
    super(params);
  }

  getDescription(): string {
    return 'Run multi-model code review';
  }

  override async shouldConfirmExecute(): Promise<false> {
    return false;
  }

  async execute(
    signal: AbortSignal,
    _updateOutput?: (output: ToolResultDisplay) => void,
  ): Promise<ToolResult> {
    // Resolve review models from config
    let reviewModels: ResolvedModelConfig[];
    try {
      reviewModels = this.config.getReviewModels();
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      debugLogger.error(`Failed to resolve review models: ${msg}`);
      return {
        llmContent: [
          {
            text: `Multi-model review configuration error: ${msg}`,
          },
        ],
        returnDisplay: `Configuration error: ${msg}`,
      };
    }

    if (reviewModels.length < 2) {
      // Return guidance — SKILL.md will naturally fall back to 4-agent flow
      const guidance = this.buildGuidanceText();
      return {
        llmContent: [{ text: guidance }],
        returnDisplay:
          'Multi-model review not available (< 2 models configured)',
      };
    }

    const service = new MultiModelReviewService(this.config);

    // Phase 1: Collect reviews
    const collected = await service.collectReviews(
      this.params.diff,
      reviewModels,
      signal,
    );

    const failureSummary = this.formatFailureSummary(collected);

    if (collected.modelResults.length === 0) {
      return {
        llmContent: [
          {
            text: `All review models failed. Please proceed with standard single-model review using the 4-agent approach.\n\n${failureSummary}`,
          },
        ],
        returnDisplay: `All review models failed: ${collected.failedModels.map((r) => r.modelId).join(', ')}`,
      };
    }

    if (collected.modelResults.length === 1) {
      // Only one model succeeded — arbitration adds no value, return its review directly
      const single = collected.modelResults[0];
      return {
        llmContent: [
          {
            text: `**Review model:** ${single.modelId}\n**Note:** Only 1 of ${reviewModels.length} review models succeeded. Arbitration skipped.\n${failureSummary}\n\n${single.reviewText}`,
          },
        ],
        returnDisplay: `Single model review (${reviewModels.length - 1} model(s) failed)`,
      };
    }

    // Phase 2: Arbitration
    let arbitratorFallbackReason: string | undefined;
    let arbitratorModel: ResolvedModelConfig | undefined;
    try {
      arbitratorModel = this.config.getArbitratorModel();
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : String(error);
      debugLogger.warn(
        `Failed to resolve arbitrator model, falling back to session model: ${errorMsg}`,
      );
      arbitratorFallbackReason = `Configured arbitrator model could not be resolved (${errorMsg}), falling back to session model.`;
    }

    if (arbitratorModel) {
      // Independent arbitration
      try {
        const result = await service.arbitrateIndependently(
          collected,
          arbitratorModel,
          signal,
        );

        const header = this.buildReportHeader(
          collected,
          arbitratorModel.id,
          failureSummary,
        );
        return {
          llmContent: [{ text: `${header}\n\n${result.report}` }],
          returnDisplay: `Multi-model review complete (${collected.modelResults.length} models + arbitrator)`,
        };
      } catch (error) {
        const errorMsg = error instanceof Error ? error.message : String(error);
        debugLogger.warn(
          `Independent arbitration failed, falling back to session model arbitration: ${errorMsg}`,
        );
        arbitratorFallbackReason = `Arbitrator model '${arbitratorModel.id}' failed (${errorMsg}), falling back to session model.`;
        // Fall through to session model arbitration
      }
    }

    // Session model arbitration: return collected reviews for the session model
    const arbitrationPrompt = service.buildSessionArbitrationPrompt(collected);
    const header = this.buildReportHeader(
      collected,
      'session model',
      failureSummary,
    );

    const fallbackNote = arbitratorFallbackReason
      ? `\n\n> **Note:** ${arbitratorFallbackReason}\n`
      : '';

    return {
      llmContent: [
        {
          text: `${header}${fallbackNote}\n\nThe following reviews were collected from ${collected.modelResults.length} models. Please act as the arbitrator and produce the final unified review report.\n\n${arbitrationPrompt}`,
        },
      ],
      returnDisplay: `Collected ${collected.modelResults.length} model reviews for arbitration`,
    };
  }

  private buildReportHeader(
    collected: CollectedReview,
    arbitratorId: string,
    failureSummary: string,
  ): string {
    const modelNames = collected.modelResults.map((r) => r.modelId).join(', ');
    const header = `**Review models:** ${modelNames}\n**Arbitrator:** ${arbitratorId}`;
    return failureSummary ? `${header}\n${failureSummary}` : header;
  }

  private formatFailureSummary(collected: CollectedReview): string {
    if (collected.failedModels.length === 0) {
      return '';
    }
    const details = collected.failedModels
      .map((r) => `- ${r.modelId}: ${r.error ?? 'unknown error'}`)
      .join('\n');
    return `**Failed models (${collected.failedModels.length}):**\n${details}`;
  }

  private buildGuidanceText(): string {
    const availableModels = this.config.getAllConfiguredModels();
    const modelList =
      availableModels.length > 0
        ? availableModels.map((m) => `  - ${m.id} (${m.authType})`).join('\n')
        : '  (none configured)';

    return `Multi-model review requires at least 2 configured models.

Available models from modelProviders:
${modelList}

To enable multi-model review, add to settings.json:
  "review": { "models": ["model-a", "model-b"] }

Please proceed with standard single-model review using the 4-agent approach.`;
  }
}
