/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import * as tar from 'tar';

export async function assertTarArchiveHasNoLinks(file: string): Promise<void> {
  let unsupportedLinkPath: string | undefined;
  await tar.t({
    file,
    onReadEntry: (entry) => {
      if (
        !unsupportedLinkPath &&
        (entry.type === 'SymbolicLink' || entry.type === 'Link')
      ) {
        unsupportedLinkPath = entry.path;
      }
    },
  });
  if (unsupportedLinkPath) {
    throw new Error(
      `Tar archive contains unsupported link entry: ${unsupportedLinkPath}`,
    );
  }
}
