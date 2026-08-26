/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';
import { DAEMON_SESSION_DEFAULT_MAX_BLOCKS } from '@qwen-code/webui/daemon-react-sdk';
import { WEB_SHELL_MAX_TRANSCRIPT_BLOCKS } from './sessions';

describe('web-shell session constants', () => {
  it('keeps the transcript window aligned with the provider default', () => {
    // Web Shell passes its own maxBlocks to every DaemonSessionProvider it
    // mounts; if the provider default moves, this copy must move with it
    // (see WEB_SHELL_MAX_TRANSCRIPT_BLOCKS).
    expect(WEB_SHELL_MAX_TRANSCRIPT_BLOCKS).toBe(
      DAEMON_SESSION_DEFAULT_MAX_BLOCKS,
    );
  });
});
