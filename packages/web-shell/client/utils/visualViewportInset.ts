/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

interface VisualViewportGeometry {
  height: number;
  offsetTop: number;
  scale: number;
}

/** The part of a shell's bottom edge hidden below the visible viewport. */
export function visualViewportBottomInset(
  root: Pick<DOMRect, 'bottom' | 'height'>,
  viewport: VisualViewportGeometry,
): number {
  // Pinch zoom also shrinks the visual viewport. Treating that as keyboard
  // occlusion would make the composer jump while the user zooms a message.
  if (viewport.scale !== 1) return 0;
  return Math.min(
    root.height,
    Math.max(0, root.bottom - viewport.offsetTop - viewport.height),
  );
}
