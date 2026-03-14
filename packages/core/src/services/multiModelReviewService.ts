/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import pLimit from 'p-limit';
import {
  type ContentGeneratorConfig,
  createContentGenerator,
} from '../core/contentGenerator.js';
import type { Config } from '../config/config.js';
import type { ResolvedModelConfig } from '../models/types.js';
import { getErrorMessage } from '../utils/errors.js';
import { createDebugLogger } from '../utils/debugLogger.js';

const debugLogger = createDebugLogger('MULTI_MODEL_REVIEW');

const CONCURRENCY_LIMIT = 4;

const REVIEW_PROMPT_PREFIX = `Review the following code changes. Cover these dimensions:
1. Correctness & Security — bugs, edge cases, vulnerabilities
2. Code Quality — naming, duplication, style consistency
3. Performance — bottlenecks, memory, unnecessary work
4. Anything else that looks off

For each finding, include: file path, line number (if applicable), severity (Critical / Suggestion / Nice to have), what's wrong, and suggested fix.

End with a verdict: Approve, Request Changes, or Comment.

<diff>`;

const REVIEW_PROMPT_SUFFIX = `</diff>`;

const ARBITRATION_PROMPT_TEMPLATE = `You are the senior code reviewer. Multiple models independently reviewed the same code changes. Your job is to produce the final unified review report.

Tasks:
1. **Merge & deduplicate**: Identify findings that refer to the same issue (even if described differently or pointing to nearby lines). Consolidate them, noting which models identified each issue.
2. **Resolve severity conflicts**: When models disagree on severity for the same issue, evaluate the actual code and choose the appropriate level. Default to the HIGHER severity when uncertain.
3. **Validate isolated findings**: For findings raised by only one model, verify against the code. Keep valid ones, dismiss false positives with reasoning.
4. **Final verdict**: Approve / Request Changes / Comment, with reasoning.

Output format:
- Group findings by severity (Critical → Suggestion → Nice to have)
- For each finding: [model names] file:line — title, description, suggested fix
- End with verdict and one-sentence reasoning

Each model's full review is provided below, followed by the diff.
Do NOT discard findings just because only one model raised them.`;

/**
 * Result from a single review model.
 */
export interface ModelReviewResult {
  modelId: string;
  reviewText: string;
  error?: string;
}

/**
 * Collected reviews from all models.
 */
export interface CollectedReview {
  modelResults: ModelReviewResult[];
  diff: string;
}

/**
 * Final arbitrated review report.
 */
export interface ArbitratedReview {
  report: string;
}

/**
 * Service for multi-model code review.
 * Phase 1: Parallel collection of reviews from multiple models.
 * Phase 2: Arbitration by a designated or session model.
 */
export class MultiModelReviewService {
  constructor(private readonly config: Config) {}

  /**
   * Phase 1: Collect reviews from multiple models in parallel.
   */
  async collectReviews(
    diff: string,
    reviewModels: ResolvedModelConfig[],
    signal?: AbortSignal,
  ): Promise<CollectedReview> {
    const limit = pLimit(CONCURRENCY_LIMIT);

    const prompt = `${REVIEW_PROMPT_PREFIX}\n${diff}\n${REVIEW_PROMPT_SUFFIX}`;

    const results = await Promise.all(
      reviewModels.map((model) =>
        limit(async (): Promise<ModelReviewResult> => {
          if (signal?.aborted) {
            return { modelId: model.id, reviewText: '', error: 'Aborted' };
          }
          try {
            debugLogger.info(`Starting review with model: ${model.id}`);
            const generatorConfig = this.buildGeneratorConfig(model);
            const generator = await createContentGenerator(
              generatorConfig,
              this.config,
            );

            const response = await generator.generateContent(
              {
                model: model.id,
                contents: [{ role: 'user', parts: [{ text: prompt }] }],
                config: {
                  abortSignal: signal,
                },
              },
              `review-${model.id}`,
            );

            const text =
              response.candidates?.[0]?.content?.parts
                ?.map((p) => p.text || '')
                .join('') || '';

            debugLogger.info(`Review complete from model: ${model.id}`);
            return { modelId: model.id, reviewText: text };
          } catch (error) {
            const errorMsg = getErrorMessage(error);
            debugLogger.error(
              `Review failed for model ${model.id}: ${errorMsg}`,
            );
            return { modelId: model.id, reviewText: '', error: errorMsg };
          }
        }),
      ),
    );

    const successful = results.filter((r) => !r.error);
    const failed = results.filter((r) => r.error);

    if (failed.length > 0) {
      debugLogger.warn(
        `${failed.length}/${results.length} review models failed: ${failed.map((r) => `${r.modelId} (${r.error})`).join(', ')}`,
      );
    }

    return {
      modelResults: successful,
      diff,
    };
  }

  /**
   * Phase 2: Independent arbitration using a configured arbitrator model.
   * Used when review.arbitratorModel is set.
   */
  async arbitrateIndependently(
    collected: CollectedReview,
    arbitratorModel: ResolvedModelConfig,
    signal?: AbortSignal,
  ): Promise<ArbitratedReview> {
    debugLogger.info(
      `Starting independent arbitration with model: ${arbitratorModel.id}`,
    );

    const modelReviews = collected.modelResults
      .map((r) => `## Review by ${r.modelId}\n\n${r.reviewText}`)
      .join('\n\n---\n\n');

    const fullPrompt = `${ARBITRATION_PROMPT_TEMPLATE}\n\n${modelReviews}\n\n<diff>\n${collected.diff}\n</diff>`;

    const generatorConfig = this.buildGeneratorConfig(arbitratorModel);
    const generator = await createContentGenerator(
      generatorConfig,
      this.config,
    );

    const response = await generator.generateContent(
      {
        model: arbitratorModel.id,
        contents: [{ role: 'user', parts: [{ text: fullPrompt }] }],
        config: {
          abortSignal: signal,
        },
      },
      'review-arbitrator',
    );

    const text =
      response.candidates?.[0]?.content?.parts
        ?.map((p) => p.text || '')
        .join('') || '';

    debugLogger.info('Independent arbitration complete');
    return { report: text };
  }

  /**
   * Build the arbitration prompt for session-model arbitration.
   * Returns the prompt text that the session model should use to produce the final report.
   */
  buildSessionArbitrationPrompt(collected: CollectedReview): string {
    const modelReviews = collected.modelResults
      .map((r) => `## Review by ${r.modelId}\n\n${r.reviewText}`)
      .join('\n\n---\n\n');

    return `${ARBITRATION_PROMPT_TEMPLATE}\n\n${modelReviews}\n\n<diff>\n${collected.diff}\n</diff>`;
  }

  /**
   * Map ResolvedModelConfig to ContentGeneratorConfig.
   */
  private buildGeneratorConfig(
    model: ResolvedModelConfig,
  ): ContentGeneratorConfig {
    const apiKey = model.envKey ? process.env[model.envKey] : undefined;
    return {
      ...model.generationConfig,
      model: model.id,
      authType: model.authType,
      apiKey,
      apiKeyEnvKey: model.envKey,
      baseUrl: model.baseUrl,
    };
  }
}
