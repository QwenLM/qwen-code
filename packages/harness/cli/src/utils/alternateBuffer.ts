/**
 * @license
 * Copyright 2025 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { shouldEnterAlternateScreen, type Config } from '@qwen-code/core';

// The UI layout must follow the same decision that makes Ink enter the
// alternate screen (interactiveCli). In the alternate screen Ink clips every
// frame to the terminal rows and there is no native scrollback, so rendering
// the main-screen layout there pushes the composer below the last row once
// the conversation outgrows the viewport. The alternate-buffer layout keeps
// the composer pinned and scrolls the conversation in a ScrollableList.
export const isAlternateBufferEnabled = (config: Config): boolean =>
  shouldEnterAlternateScreen(
    config.getUseAlternateBuffer(),
    config.getScreenReader(),
  );
