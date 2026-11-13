/**
 * @license
 * Copyright 2026 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import { MarkdownRenderable } from '@opentui/core';
import { extend } from '@opentui/react';

/**
 * OpenTUI 0.5.10 repaints every updated streaming block with a marked-based
 * inline preview before the async tree-sitter pass replaces it, so each delta
 * flips the block between two renderers that disagree on concealment, links
 * and emphasis — the streaming jitter. Without the preview a block keeps its
 * last highlighted frame until the next highlight lands, which is the path
 * fenced code blocks already take. Re-check `createInitialStyledText` when
 * upgrading `@opentui/core`.
 */
export class StableMarkdownRenderable extends MarkdownRenderable {}

(
  StableMarkdownRenderable.prototype as unknown as {
    createInitialStyledText: () => undefined;
  }
).createInitialStyledText = () => undefined;

extend({ markdown: StableMarkdownRenderable });
