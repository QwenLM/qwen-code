/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type { GenerateInsightsOptions, InsightsReport } from './types.js';
import { scanProjectSessions } from './scanner.js';
import { extractFacets } from './facetExtractor.js';
import { aggregateData } from './aggregator.js';
import { generateInsightResults } from './insightGenerator.js';
import { generateHtmlReport } from './reportGenerator.js';
import { getCacheDir } from './cache.js';
import * as path from 'node:path';

const DEFAULT_LOOKBACK_DAYS = 30;
const CONCURRENCY = 50;
const MAX_FACET_EXTRACTIONS = 50;

/**
 * Main public API for the insights pipeline.
 * Orchestrates: scan → extract facets → aggregate → generate insights → render HTML.
 */
export async function generateInsights(
  options: GenerateInsightsOptions,
): Promise<InsightsReport> {
  const {
    config,
    cwd,
    abortSignal,
    onProgress,
    lookbackDays,
    productName,
    footerLink,
  } = options;
  const effectiveLookbackDays = lookbackDays ?? DEFAULT_LOOKBACK_DAYS;

  // Phase 1: Scan sessions
  onProgress('[Phase 1]', 'Scanning transcripts...');
  const sessions = await scanProjectSessions({
    config,
    cwd,
    lookbackDays: effectiveLookbackDays,
    abortSignal,
  });
  onProgress(
    '[Phase 1]',
    `Scanning transcripts... (${sessions.length} sessions found)`,
  );

  if (sessions.length === 0) {
    throw new Error(
      'No sessions found in the last ' +
        effectiveLookbackDays +
        ' days for this project.',
    );
  }

  if (abortSignal.aborted) {
    throw new Error('Insights generation was cancelled.');
  }

  // Phase 2: Extract facets with concurrency control (batch size = 50)
  onProgress('[Phase 2]', `Analyzing sessions... (0/${sessions.length})`);
  const facets = [];
  let extractedCount = 0;

  // Limit total extractions to MAX_FACET_EXTRACTIONS
  const sessionsToExtract = sessions.slice(0, MAX_FACET_EXTRACTIONS);

  for (let i = 0; i < sessionsToExtract.length; i += CONCURRENCY) {
    if (abortSignal.aborted) {
      throw new Error('Insights generation was cancelled.');
    }

    const batch = sessionsToExtract.slice(i, i + CONCURRENCY);
    const batchResults = await Promise.all(
      batch.map((session) => extractFacets(session, config, abortSignal)),
    );

    facets.push(...batchResults);
    extractedCount += batchResults.length;
    onProgress(
      '[Phase 2]',
      `Analyzing sessions... (${extractedCount}/${sessionsToExtract.length})`,
    );
  }

  if (abortSignal.aborted) {
    throw new Error('Insights generation was cancelled.');
  }

  // Phase 3: Aggregate data
  onProgress('[Phase 3]', 'Aggregating data...');
  const aggregated = aggregateData(sessions, facets);

  if (abortSignal.aborted) {
    throw new Error('Insights generation was cancelled.');
  }

  // Phase 4: Generate insights via LLM
  onProgress('[Phase 4]', 'Generating insights...');
  const insights = await generateInsightResults(
    aggregated,
    config,
    abortSignal,
    (completed, total) => {
      onProgress(
        '[Phase 4]',
        `Generating insights... (${completed}/${total} sections)`,
      );
    },
  );

  if (abortSignal.aborted) {
    throw new Error('Insights generation was cancelled.');
  }

  // Phase 5: Build HTML report
  onProgress('[Phase 5]', 'Building report...');
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
  const outputPath = path.join(
    getCacheDir(),
    `insights-report-${timestamp}.html`,
  );
  await generateHtmlReport(aggregated, insights, outputPath, {
    productName: productName ?? 'CLI',
    ...(footerLink === undefined ? {} : { footerLink }),
  });

  return {
    htmlPath: outputPath,
    aggregated,
    insights,
  };
}
