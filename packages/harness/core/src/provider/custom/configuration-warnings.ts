/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type {
  CustomProvidersState,
  CustomProviderValidationIssue,
} from './types.js';

/**
 * Renders the issues carried by a published state as user-facing warnings.
 *
 * Derived from the issues alone, so this does not depend on the registry having
 * already been brought in line with `state`.
 */
export function formatCustomProviderConfigurationWarnings(
  state: CustomProvidersState,
): string[] {
  const issues = ('issues' in state ? state.issues : undefined) ?? [];
  if (issues.length === 0) return [];

  const issuesByProvider = new Map<string, CustomProviderValidationIssue[]>();
  for (const issue of issues) {
    const providerIssues = issuesByProvider.get(issue.providerId) ?? [];
    providerIssues.push(issue);
    issuesByProvider.set(issue.providerId, providerIssues);
  }

  const warnings: string[] = [];
  for (const [providerId, providerIssues] of issuesByProvider) {
    const details = providerIssues
      .map(
        (issue) => `${issue.field ? `${issue.field}: ` : ''}${issue.message}`,
      )
      .join('; ');
    if (providerId === '*') {
      warnings.push(`Custom provider settings were ignored: ${details}.`);
    } else {
      warnings.push(
        `Custom provider "${providerId}" was ignored: ${details}.`,
      );
    }
  }
  return warnings;
}
