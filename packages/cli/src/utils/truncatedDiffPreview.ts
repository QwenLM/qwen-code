/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

export function buildTruncatedDiffPreviewText(
  display: Record<string, unknown>,
): string {
  const fileName =
    typeof display['fileName'] === 'string'
      ? display['fileName']
      : 'the edited file';
  const fileDiffLength =
    typeof display['fileDiffLength'] === 'number'
      ? ` Original fileDiff length: ${display['fileDiffLength']} chars.`
      : '';

  if (display['fileDiffTruncated'] === true) {
    return `Full diff omitted from saved session history for ${fileName}.${fileDiffLength}`;
  }

  return `Saved session preview only for ${fileName}; full original and new file contents are unavailable.`;
}
