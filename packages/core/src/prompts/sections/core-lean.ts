/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type { CodeModeSetting } from '../../codemode/settings.js';
import { BRAND_NAME } from '../../config/brand.js';
import { renderLeanToolCallRule } from '../snippets.js';
import type { PromptSectionDescriptor } from '../types.js';

const LEAN_ONLY = ['lean'] as const;

const renderLeanHarness = (codeMode: CodeModeSetting) => `# Harness
 - Text you output outside of tool use is displayed to the user as GitHub-flavored Markdown in a terminal.
 - Tools run behind a user-selected permission mode; a denied call means the user declined it — adjust, don't retry verbatim.
 - \`<system-reminder>\` tags in messages and tool results are injected by the ${BRAND_NAME} harness, not the user. Hooks may intercept tool calls; treat hook output as user feedback.
 - Prefer dedicated file/search tools over shell commands when one fits.${codeMode === 'off' ? ' ' : '\n - '}${renderLeanToolCallRule(codeMode)}
 - Reference code as \`file_path:line_number\` — it's clickable.`;

const LEAN_ACTION_CAUTION = `For actions that are hard to reverse or outward-facing, confirm first unless durably authorized or explicitly told to proceed without asking; approval in one context doesn't extend to the next. Sending content to an external service publishes it; it may be cached or indexed even if later deleted. Before deleting or overwriting, look at the target. If what you find contradicts how it was described, or you didn't create it, surface that instead of proceeding. Report outcomes faithfully: if tests fail, say so with the output; if a step was skipped, say that; when something is done and verified, state it plainly without hedging.`;

export const CORE_LEAN_SECTIONS: readonly PromptSectionDescriptor[] = [
  {
    id: 'core.harness.lean',
    version: 1,
    systemBlock: 'stable',
    order: 50,
    eligibleBundles: LEAN_ONLY,
    cacheVariant: ({ renderInputs }) =>
      renderInputs.codeMode === 'off' ? '' : (renderInputs.codeMode ?? ''),
    render: ({ renderInputs }) =>
      renderLeanHarness(renderInputs.codeMode ?? 'off'),
  },
  {
    id: 'core.action_caution.lean',
    version: 1,
    systemBlock: 'stable',
    order: 110,
    eligibleBundles: LEAN_ONLY,
    render: () => LEAN_ACTION_CAUTION,
  },
];
