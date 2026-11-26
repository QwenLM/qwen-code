/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type { BundledSkillRegistrar } from './index.js';
import {
  getWorkflowAuthoringReference,
  WORKFLOW_AUTHORING_SKILL_NAME,
} from '../../workflows/workflow-prompts.js';

export async function getWorkflowAuthoringSkillBody(): Promise<string> {
  return getWorkflowAuthoringReference();
}

export function registerWorkflowAuthoringSkill(
  registrar: BundledSkillRegistrar,
): void {
  registrar.registerBundledSkill({
    name: WORKFLOW_AUTHORING_SKILL_NAME,
    description:
      'Reference for writing a Workflow tool script (script API and gotchas, resume, quality patterns, worked examples). Load before authoring a script for a workflow the user already opted into; it does not itself authorize running one.',
    location: 'bundled',
    body: '',
    userInvocable: true,
    getBody: getWorkflowAuthoringSkillBody,
  });
}
