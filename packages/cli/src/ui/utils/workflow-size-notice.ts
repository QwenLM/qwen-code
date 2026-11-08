/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import {
  buildWorkflowSizeGuidelineChangeNotice,
  type WorkflowSizeGuidelineSetting,
} from '@qwen-code/qwen-code-core/agents/runtime/workflow-size.js';

/**
 * The one-shot reminder for a size guideline the user changed since the model
 * was last told, or `null` when the size is the same.
 *
 * The Workflow tool description is built once, at startup, and keeps stating
 * the guideline it was built with. A change made in /settings mid-session would
 * otherwise reach the runtime thresholds but never the model, which would go on
 * sizing workflows to the old value. Only the size matters: choosing "medium"
 * explicitly when "medium" was the default changes nothing the model acts on.
 */
export function buildWorkflowSizeGuidelineChangePrefix(
  announced: WorkflowSizeGuidelineSetting,
  current: WorkflowSizeGuidelineSetting,
): string | null {
  if (announced.size === current.size) return null;
  return `<system-reminder>\n${buildWorkflowSizeGuidelineChangeNotice(current)}\n</system-reminder>\n\n`;
}
