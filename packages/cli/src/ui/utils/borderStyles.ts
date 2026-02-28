/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { ToolCallStatus } from '../types.js';
import { isShellTool } from '../components/messages/ToolShared.js';
import { theme } from '../semantic-colors.js';
import type { IndividualToolCallDisplay } from '../types.js';

interface ToolGroupBorderAppearance {
  borderColor: string;
  borderDimColor: boolean;
}

export function getToolGroupBorderAppearance(
  tools: IndividualToolCallDisplay[],
  activeShellPtyId: number | null | undefined,
  embeddedShellFocused: boolean | undefined,
): ToolGroupBorderAppearance {
  if (tools.length === 0) {
    return { borderColor: theme.border.default, borderDimColor: false };
  }

  const hasPending = tools.some(
    (t) =>
      t.status !== ToolCallStatus.Success &&
      t.status !== ToolCallStatus.Error &&
      t.status !== ToolCallStatus.Canceled,
  );

  const isEmbeddedShellFocused = tools.some(
    (t) =>
      isShellTool(t.name) &&
      t.status === ToolCallStatus.Executing &&
      t.ptyId === activeShellPtyId &&
      !!embeddedShellFocused,
  );

  const isShellCommand = tools.some((t) => isShellTool(t.name));

  const isShell = isShellCommand;
  const isPending = hasPending;

  const isEffectivelyFocused = isEmbeddedShellFocused;

  const borderColor =
    (isShell && isPending) || isEffectivelyFocused
      ? theme.ui.symbol
      : isPending
        ? theme.status.warning
        : theme.border.default;

  const borderDimColor = isPending && (!isShell || !isEffectivelyFocused);

  return { borderColor, borderDimColor };
}
