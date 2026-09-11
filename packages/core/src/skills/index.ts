/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * @fileoverview Skills feature implementation
 *
 * This module provides the foundation for the skills feature, which allows
 * users to define reusable skill configurations that can be loaded by the
 * model via a dedicated Skills tool.
 *
 * Skills are stored as directories containing a SKILL.md file with YAML
 * frontmatter for metadata. They can be loaded from four levels
 * (precedence: project > user > extension > bundled):
 * - Project-level: `.qwen/skills/`
 * - User-level: `~/.qwen/skills/`
 * - Extension-level: provided by installed extensions
 * - Bundled: built-in skills shipped with qwen-code
 */

// Core types and interfaces
export type {
  SkillConfig,
  SkillLevel,
  SkillValidationResult,
  ListSkillsOptions,
  SkillErrorCode,
} from './types.js';

export { SkillError, validateSkillName } from './types.js';

// Main management class
export { SkillManager } from './skill-manager.js';

// Install-artifact name contract shared by the loaders (filtering), the
// installers (sweeping), and the management surfaces (legacy-name mapping)
export {
  isInstallArtifactName,
  isInstallArtifactOfSkill,
  installArtifactPid,
  isSelfNamedSkillDirectory,
  resolveLegacyArtifactNamedSkillFile,
} from './skill-install-artifacts.js';

// Priority normalization, shared with the `/skills` display sort
export { normalizeSkillPriority } from './skill-load.js';

// Path-based conditional skill activation
export {
  SkillActivationRegistry,
  splitConditionalSkills,
} from './skill-activation.js';

// Project auto-skill lifecycle maintenance
export * from './skill-curator.js';

// The bundled authoring reference for the Workflow tool, and the decision of
// how it reaches the model: pointed at, inlined in the tool description, or
// withheld because the user turned it off.
export {
  isToolHiddenBehindToolSearch,
  readWorkflowAuthoringReference,
  resolveWorkflowAuthoringRoute,
  resolveWorkflowAuthoringSurface,
  toolSearchRevealSentence,
  WORKFLOW_AUTHORING_SKILL_NAME,
} from './workflow-authoring-skill.js';
export type {
  WorkflowAuthoringReference,
  WorkflowAuthoringRoute,
  WorkflowAuthoringSurface,
} from './workflow-authoring-skill.js';
