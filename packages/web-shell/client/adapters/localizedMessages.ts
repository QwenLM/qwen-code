/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * Leaf module for projecting transcript blocks into localized messages.
 *
 * This lives outside `hooks/useMessages.ts` on purpose. That module is a daemon
 * consumer — it value-imports `useConnection` / `useTranscriptBlocks` /
 * `useWorkspace` from the `daemon-react-sdk` barrel — so importing this one
 * function from it dragged the daemon provider stack into the read-only
 * transcript entry, which advertises the opposite. Same treatment as
 * `utils/composerTag.ts`: the pure projection lives in a module with no daemon
 * or editor imports, and `useMessages.ts` re-exports it for existing callers.
 *
 * Keep this module free of React hooks and of anything reaching
 * `@qwen-code/web-shell/daemon-react-sdk`. `client/build-artifact.test.ts`
 * asserts that `dist/transcript.js` carries no daemon provider code.
 */

import type { DaemonTranscriptBlock } from '@qwen-code/sdk/daemon';
import { transcriptBlocksToDaemonMessages } from './transcriptToMessages';
import type { Message } from './types';

export type Translator = (
  key: string,
  vars?: Record<string, string | number>,
) => string;

export function transcriptBlocksToLocalizedMessages(
  blocks: readonly DaemonTranscriptBlock[],
  t: Translator,
  safeToolProjection = false,
): Message[] {
  return transcriptBlocksToDaemonMessages(blocks, {
    safeToolProjection,
    includeSourceIdentity: true,
    labels: {
      promptCancelled: t('request.cancelled'),
      branchSuccess: (name) => t('branch.success', { name }),
      modelStreamInterrupted: t('error.modelStreamInterrupted'),
      loopDetected: t('error.loopDetected'),
    },
  });
}
