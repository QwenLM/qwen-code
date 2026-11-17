/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * @fileoverview How the model reaches the bundled `workflow-authoring`
 * reference in this session.
 *
 * The authoring reference is a bundled skill rather than tool-description
 * prose because only the turn that actually writes a script needs it, while a
 * tool description is paid for on every turn. That trade needs the Workflow
 * tool to know which of four situations it is in — point at the skill, point
 * at it through the tool_search + tool_call bridge, inline it, or carry
 * nothing — and that decision is the same for every bundled reference, so it
 * lives in {@link file://./bundled-reference.ts} and this file only names the
 * skill.
 *
 * The decision is made once, when the Workflow tool is constructed, and
 * recorded on it. Every other surface that talks about the reference — the
 * failure hint, the keyword reminder — reads that record instead of asking
 * again, so a mid-session `/skills` toggle cannot make them disagree with the
 * description the model is holding.
 */

import type { Config } from '../config/config.js';
import {
  readBundledReference,
  resolveBundledReferenceRoute,
  resolveBundledReferenceSurface,
  type BundledReference,
  type BundledReferenceRoute,
  type BundledReferenceSurface,
} from './bundled-reference.js';

export {
  isToolHiddenBehindToolSearch,
  toolSearchBridgeSentence,
} from './bundled-reference.js';

/** Name of the bundled authoring reference, as the model would invoke it. */
export const WORKFLOW_AUTHORING_SKILL_NAME = 'workflow-authoring';

/** The reference as the Skill tool would load it. */
export type WorkflowAuthoringReference = BundledReference;

/**
 * How the reference reaches the model in this session. See
 * {@link BundledReferenceRoute} for what each value means.
 */
export type WorkflowAuthoringRoute = BundledReferenceRoute;

/**
 * What the Workflow tool's description holds about the reference. See
 * {@link BundledReferenceSurface}.
 *
 * The Workflow tool records this when it is built; the failure hint and the
 * keyword reminder read that record rather than calling this again.
 */
export type WorkflowAuthoringSurface = BundledReferenceSurface;

export function readWorkflowAuthoringReference(): WorkflowAuthoringReference | null {
  return readBundledReference(WORKFLOW_AUTHORING_SKILL_NAME);
}

export function resolveWorkflowAuthoringRoute(
  config: Config,
): WorkflowAuthoringRoute {
  return resolveBundledReferenceRoute(config, WORKFLOW_AUTHORING_SKILL_NAME);
}

export function resolveWorkflowAuthoringSurface(
  config: Config,
): WorkflowAuthoringSurface {
  return resolveBundledReferenceSurface(config, WORKFLOW_AUTHORING_SKILL_NAME);
}
