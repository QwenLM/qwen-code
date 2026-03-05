/**
 * @license
 * Copyright 2025 Qwen Code
 * SPDX-License-Identifier: Apache-2.0
 */

// Simple translation utility for the insight report
// Translations are passed via window.INSIGHT_DATA.translations

const defaultTranslations: Record<string, string> = {};

/**
 * Get the translation for a key
 */
export function t(key: string, params?: Record<string, string>): string {
  const translations = window.INSIGHT_DATA?.translations || defaultTranslations;
  let text = translations[key] || key;

  // Simple parameter interpolation
  if (params) {
    Object.entries(params).forEach(([paramKey, value]) => {
      text = text.replace(new RegExp(`{{${paramKey}}}`, 'g'), String(value));
    });
  }

  return text;
}

/**
 * Format a label for display (capitalize and replace underscores with spaces)
 */
export function formatLabel(label: string): string {
  if (label === 'unclear_from_transcript') {
    return t('Unclear');
  }
  return label
    .split('_')
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(' ');
}

/**
 * Get the display name for a satisfaction level
 */
export function getSatisfactionLabel(level: string): string {
  const labels: Record<string, string> = {
    happy: t('Happy'),
    satisfied: t('Satisfied'),
    likely_satisfied: t('Likely Satisfied'),
    dissatisfied: t('Dissatisfied'),
    frustrated: t('Frustrated'),
  };
  return labels[level] || formatLabel(level);
}

/**
 * Get the display name for a friction type
 */
export function getFrictionLabel(type: string): string {
  const labels: Record<string, string> = {
    misunderstood_request: t('Misunderstood Request'),
    wrong_approach: t('Wrong Approach'),
    buggy_code: t('Buggy Code'),
    user_rejected_action: t('User Rejected Action'),
    excessive_changes: t('Excessive Changes'),
  };
  return labels[type] || formatLabel(type);
}

/**
 * Get the display name for a success type
 */
export function getSuccessLabel(type: string): string {
  const labels: Record<string, string> = {
    fast_accurate_search: t('Fast Accurate Search'),
    correct_code_edits: t('Correct Code Edits'),
    good_explanations: t('Good Explanations'),
    proactive_help: t('Proactive Help'),
    multi_file_changes: t('Multi File Changes'),
    good_debugging: t('Good Debugging'),
  };
  return labels[type] || formatLabel(type);
}

/**
 * Get the display name for an outcome
 */
export function getOutcomeLabel(outcome: string): string {
  const labels: Record<string, string> = {
    fully_achieved: t('Fully Achieved'),
    mostly_achieved: t('Mostly Achieved'),
    partially_achieved: t('Partially Achieved'),
    not_achieved: t('Not Achieved'),
    unclear_from_transcript: t('Unclear'),
  };
  return labels[outcome] || formatLabel(outcome);
}
