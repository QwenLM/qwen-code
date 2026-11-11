/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type { ForkedAgentCompletion } from '../core/fork-accounting.js';
import { runLogger } from '../utils/runLogger.js';

export interface ForkCompletionBilling {
  credits?: number;
  billableRequestCount: number;
  nonBillableRequestCount: number;
  requestDetails: ForkCompletionBillingRequestDetail[];
}

export interface ForkCompletionBillingRequestDetail {
  request_id: string;
  model: string;
  credits?: number;
  original_credits?: number;
  billable?: boolean;
  input_tokens: number;
  output_tokens: number;
  cache_read_tokens: number;
  cache_write_tokens: number;
  thinking_tokens: number;
  total_tokens: number;
}

export interface ForkModelRequestUsage
  extends Partial<
    Omit<ForkCompletionBillingRequestDetail, 'request_id' | 'model'>
  > {
  request_id: string;
  model: string;
  status: 'success' | 'failed' | 'unknown';
  attempt_count?: number;
  retry_count?: number;
  ttft_ms?: number;
  duration_ms?: number;
  finish_reason?: string;
  failure_reason?: string;
}

function isValidCreditValue(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}

function formatBillingValue(value: unknown): string {
  return value === undefined ? 'missing' : String(value);
}

function getCreditCalculation(
  rawCredits: unknown,
  validCredits: number | undefined,
): 'included' | 'ignored_missing' | 'ignored_invalid' {
  if (validCredits !== undefined) {
    return 'included';
  }
  return rawCredits === undefined ? 'ignored_missing' : 'ignored_invalid';
}

/**
 * Aggregates authoritative billing values returned by one fork completion.
 * Credits and the explicit billable flag both classify a request. Missing
 * values stay missing rather than being derived from tokens or model prices.
 * A request ID is counted at most once.
 */
export function getForkCompletionBilling(
  completion: Pick<ForkedAgentCompletion, 'modelRequests' | 'totalUsage'>,
): ForkCompletionBilling {
  let credits = 0;
  let hasCredits = false;
  let billableRequestCount = 0;
  let nonBillableRequestCount = 0;
  const requestDetails: ForkCompletionBillingRequestDetail[] = [];
  const seenRequestIds = new Set<string>();
  let duplicateRequestIdCount = 0;

  const indexedModelRequests = completion.modelRequests.map(
    (request, requestIndex) => ({ request, requestIndex }),
  );
  const uniqueModelRequests = indexedModelRequests.filter(
    ({ request, requestIndex }) => {
      if (!seenRequestIds.has(request.requestId)) {
        seenRequestIds.add(request.requestId);
        return true;
      }

      duplicateRequestIdCount++;
      runLogger.debug(
        `[ForkCompletionBilling] dedup requestIndex=${requestIndex}, requestId=${request.requestId}, model=${request.model}, credits=${formatBillingValue(request.usage.credits)}, originalCredits=${formatBillingValue(request.usage.original_credits)}, billable=${formatBillingValue(request.usage.billable)}, action=ignored_duplicate_request_id`,
      );
      return false;
    },
  );

  for (const { request, requestIndex } of uniqueModelRequests) {
    const requestCredits = isValidCreditValue(request.usage.credits)
      ? request.usage.credits
      : undefined;
    const requestOriginalCredits = isValidCreditValue(
      request.usage.original_credits,
    )
      ? request.usage.original_credits
      : undefined;
    requestDetails.push({
      request_id: request.requestId,
      model: request.model,
      ...(requestCredits !== undefined ? { credits: requestCredits } : {}),
      ...(requestOriginalCredits !== undefined
        ? { original_credits: requestOriginalCredits }
        : {}),
      ...(typeof request.usage.billable === 'boolean'
        ? { billable: request.usage.billable }
        : {}),
      input_tokens: request.usage.input_tokens,
      output_tokens: request.usage.output_tokens,
      cache_read_tokens: request.usage.cache_read_input_tokens,
      cache_write_tokens: request.usage.cache_creation_input_tokens,
      thinking_tokens: request.thinkingTokens,
      total_tokens:
        request.usage.input_tokens + request.usage.output_tokens,
    });
    const creditsBefore = credits;
    if (requestCredits !== undefined) {
      credits += requestCredits;
      hasCredits = true;
    }

    const isBillable =
      (requestCredits !== undefined && requestCredits > 0) ||
      request.usage.billable === true;
    const isNonBillable =
      !isBillable &&
      ((requestCredits !== undefined && requestCredits === 0) ||
        request.usage.billable === false);
    if (isBillable) {
      billableRequestCount++;
    } else if (isNonBillable) {
      nonBillableRequestCount++;
    }

    const billingClassification = isBillable
      ? 'billable'
      : isNonBillable
        ? 'non_billable'
        : 'unclassified';
    runLogger.debug(
      `[ForkCompletionBilling] requestIndex=${requestIndex}, requestId=${request.requestId}, model=${request.model}, credits=${formatBillingValue(request.usage.credits)}, originalCredits=${formatBillingValue(request.usage.original_credits)}, billable=${formatBillingValue(request.usage.billable)}, creditCalculation=${getCreditCalculation(request.usage.credits, requestCredits)}, creditsBefore=${creditsBefore}, creditsAdded=${requestCredits ?? 0}, creditsAfter=${credits}, classification=${billingClassification}`,
    );
  }

  const fallbackCredits = isValidCreditValue(completion.totalUsage.credits)
    ? completion.totalUsage.credits
    : undefined;
  let creditSource = hasCredits ? 'model_requests' : 'missing';
  const totalUsageCreditCalculation = hasCredits
    ? 'not_used_request_credits_available'
    : fallbackCredits !== undefined
      ? 'used_as_fallback'
      : getCreditCalculation(completion.totalUsage.credits, fallbackCredits);
  if (!hasCredits && fallbackCredits !== undefined) {
    credits = fallbackCredits;
    hasCredits = true;
    creditSource = 'total_usage';
  }

  let classificationSource =
    billableRequestCount > 0 || nonBillableRequestCount > 0
      ? 'model_requests'
      : 'missing';
  if (billableRequestCount === 0 && nonBillableRequestCount === 0) {
    const fallbackBillable =
      (fallbackCredits !== undefined && fallbackCredits > 0) ||
      completion.totalUsage.billable === true;
    const fallbackNonBillable =
      !fallbackBillable &&
      ((fallbackCredits !== undefined && fallbackCredits === 0) ||
        completion.totalUsage.billable === false);
    if (fallbackBillable) {
      billableRequestCount = 1;
      classificationSource = 'total_usage';
    } else if (fallbackNonBillable) {
      nonBillableRequestCount = 1;
      classificationSource = 'total_usage';
    }
  }

  runLogger.debug(
    `[ForkCompletionBilling] summary requestCount=${completion.modelRequests.length}, uniqueRequestIdCount=${seenRequestIds.size}, duplicateRequestIdCount=${duplicateRequestIdCount}, totalUsageCredits=${formatBillingValue(completion.totalUsage.credits)}, totalUsageOriginalCredits=${formatBillingValue(completion.totalUsage.original_credits)}, totalUsageBillable=${formatBillingValue(completion.totalUsage.billable)}, totalUsageCreditCalculation=${totalUsageCreditCalculation}, creditSource=${creditSource}, reportedCredits=${hasCredits ? credits : 'missing'}, classificationSource=${classificationSource}, billableRequestCount=${billableRequestCount}, nonBillableRequestCount=${nonBillableRequestCount}`,
  );

  return {
    credits: hasCredits ? credits : undefined,
    billableRequestCount,
    nonBillableRequestCount,
    requestDetails,
  };
}

export function buildForkModelRequestUsage(
  completion: ForkedAgentCompletion,
  billingDetails: readonly ForkCompletionBillingRequestDetail[],
): ForkModelRequestUsage[] {
  const completedById = new Map(
    completion.modelRequests.map((request) => [request.requestId, request]),
  );
  const resultById = new Map(
    completion.modelRequestResults.map((result) => [result.requestId, result]),
  );
  const billingById = new Map(
    billingDetails.map((detail) => [detail.request_id, detail]),
  );
  const requestIds = new Set(completion.modelRequestIds);
  for (const requestId of completedById.keys()) requestIds.add(requestId);
  for (const requestId of resultById.keys()) requestIds.add(requestId);

  return [...requestIds].map((requestId) => {
    const completed = completedById.get(requestId);
    const result = resultById.get(requestId);
    const billing = billingById.get(requestId);
    const {
      request_id: _billingRequestId,
      model: _billingModel,
      ...billingFields
    } = billing ?? { request_id: requestId, model: completion.model };
    const finishReason = result?.finishReason ?? completed?.finishReason;

    return {
      request_id: requestId,
      model:
        completed?.model ?? result?.model ?? billing?.model ?? completion.model,
      status: result
        ? result.success
          ? 'success'
          : 'failed'
        : completed
          ? 'success'
          : 'unknown',
      ...(result
        ? {
            attempt_count: result.attemptCount,
            retry_count: result.retryCount,
          }
        : {}),
      ...(completed
        ? {
            ttft_ms: completed.ttftMs,
            duration_ms: completed.durationMs,
          }
        : {}),
      ...(finishReason ? { finish_reason: finishReason } : {}),
      ...(result?.failureReason
        ? { failure_reason: result.failureReason }
        : {}),
      ...billingFields,
    };
  });
}
