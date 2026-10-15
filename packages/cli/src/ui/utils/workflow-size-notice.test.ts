/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import {
  DEFAULT_WORKFLOW_SIZE_GUIDELINE,
  resolveWorkflowSizeGuidelineSetting,
  WORKFLOW_SIZE_GUIDELINE_SETTING_LABEL,
  WORKFLOW_SIZE_GUIDELINES,
} from '@qwen-code/qwen-code-core/agents/runtime/workflow-size.js';
import { getSettingsSchema } from '../../config/settingsSchema.js';
import { buildWorkflowSizeGuidelineChangePrefix } from './workflow-size-notice.js';

describe('buildWorkflowSizeGuidelineChangePrefix', () => {
  const startup = resolveWorkflowSizeGuidelineSetting(undefined);

  it('says nothing while the size is unchanged', () => {
    expect(buildWorkflowSizeGuidelineChangePrefix(startup, startup)).toBeNull();
    // Picking the default explicitly changes nothing the model acts on.
    expect(
      buildWorkflowSizeGuidelineChangePrefix(
        startup,
        resolveWorkflowSizeGuidelineSetting('medium'),
      ),
    ).toBeNull();
  });

  it('wraps the change notice in a one-shot system reminder', () => {
    const prefix = buildWorkflowSizeGuidelineChangePrefix(
      startup,
      resolveWorkflowSizeGuidelineSetting('small'),
    );
    expect(prefix).toMatch(/^<system-reminder>\n/);
    expect(prefix).toMatch(/\n<\/system-reminder>\n\n$/);
    expect(prefix).toContain(
      'The workflow size guideline for this session changed: small',
    );
  });

  it('announces a move to unrestricted', () => {
    expect(
      buildWorkflowSizeGuidelineChangePrefix(
        startup,
        resolveWorkflowSizeGuidelineSetting('unrestricted'),
      ),
    ).toContain('Workflow size is now unrestricted');
  });
});

// The guideline text tells the model where the user changes it, by label. The
// setting and that text live in different packages; this keeps them agreeing.
describe('tools.workflowSizeGuideline setting', () => {
  const definition = getSettingsSchema().tools.properties.workflowSizeGuideline;

  it('carries the label the guideline text names', () => {
    expect(definition.label).toBe(WORKFLOW_SIZE_GUIDELINE_SETTING_LABEL);
  });

  it('offers exactly the guideline sizes core understands, defaulting to core', () => {
    expect(definition.options.map((option) => option.value).sort()).toEqual(
      [...WORKFLOW_SIZE_GUIDELINES].sort(),
    );
    expect(definition.default).toBe(DEFAULT_WORKFLOW_SIZE_GUIDELINE);
  });
});
