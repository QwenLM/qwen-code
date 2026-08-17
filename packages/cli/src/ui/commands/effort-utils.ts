/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import type { Config, ReasoningEffort } from '@qwen-code/qwen-code-core';
import { t } from '../../i18n/index.js';

export function formatEffortChangeMessage(
  config: Config,
  tier: ReasoningEffort,
): string {
  if (config.getReasoningEffort() !== tier) {
    const override = config.getReasoningEffortOverride?.();
    if (override) {
      return t(
        'Reasoning effort set to {{tier}}, but thinking is currently disabled; after thinking is re-enabled, {{source}}.{{field}} will still have higher priority.',
        { tier, source: override.source, field: override.field },
      );
    }
    return t(
      'Reasoning effort set to {{tier}}, but thinking is currently disabled — it will take effect when thinking is re-enabled.',
      { tier },
    );
  }

  const override = config.getReasoningEffortOverride?.();
  if (override) {
    return t(
      'Reasoning effort: {{tier}} requested, but {{source}}.{{field}} has higher priority for the active DashScope Qwen model; that configured value will remain effective.',
      { tier, source: override.source, field: override.field },
    );
  }

  return t(
    'Reasoning effort: {{tier}} (requested; the effective tier depends on the active provider/model).',
    { tier },
  );
}
