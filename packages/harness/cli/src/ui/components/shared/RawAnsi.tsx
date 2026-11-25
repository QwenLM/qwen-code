/**
 * @license
 * Copyright 2026 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type React from 'react';
import { useMemo } from 'react';

type Props = {
  /**
   * Pre-rendered ANSI lines. Each element must be exactly one terminal row
   * (already wrapped to `width` by the producer) with ANSI escape codes inline.
   */
  lines: string[];
  /** Column width the producer wrapped to. Sent to Yoga as the fixed leaf width. */
  width: number;
};

/**
 * Bypass the <Ansi> → React tree → Yoga → squash → re-serialize roundtrip for
 * content that is already terminal-ready.
 *
 * Use this when an external renderer (e.g. ColorDiff) has already produced
 * ANSI-escaped, width-wrapped output. This component emits a single Yoga leaf
 * with a constant-time measure func (width × lines.length) and hands the joined
 * string straight to output.write().
 */
export function RawAnsi({ lines, width }: Props): React.ReactNode {
  const text = useMemo(() => lines.join('\n'), [lines]);

  if (lines.length === 0) {
    return null;
  }

  return (
    <ink-raw-ansi rawText={text} rawWidth={width} rawHeight={lines.length} />
  );
}
