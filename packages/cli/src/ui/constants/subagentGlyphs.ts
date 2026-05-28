/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Glyph family for sub-agent displays in scrollback summaries and live panel.
 *
 * Aligned to gemini-cli's hard-coded usage in
 * `packages/cli/src/ui/components/messages/SubagentGroupDisplay.tsx:229-243`.
 * (gemini-cli's `constants.ts` `TOOL_STATUS` table is for tool calls, not
 * sub-agents — these are intentionally separate.)
 *
 * Windows console fallback uses ASCII for terminals that cannot render the
 * primary glyphs (Codepage 437 / non-UTF environments).
 */

const useUnicode = process.platform !== 'win32';

export const SUBAGENT_GROUP_GLYPH = useUnicode ? '≡' : '>';

/** Live / in-flight sub-agent. */
export const SUBAGENT_GLYPH_RUNNING = useUnicode ? '▶' : '!';

/** Sub-agent that finished cleanly. */
export const SUBAGENT_GLYPH_COMPLETED = useUnicode ? '✓' : '+';

/** Sub-agent that failed. */
export const SUBAGENT_GLYPH_FAILED = useUnicode ? '✗' : 'x';

/** Sub-agent cancelled by the user or the parent turn. */
export const SUBAGENT_GLYPH_CANCELLED = useUnicode ? 'ℹ' : 'i';

/** Live-only: sub-agent currently paused for confirmation. */
export const SUBAGENT_GLYPH_PAUSED = useUnicode ? '⏸' : '||';
