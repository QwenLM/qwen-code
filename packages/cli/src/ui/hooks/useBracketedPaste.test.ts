/**
 * @license
 * Copyright 2025 Google LLC
 * SPDX-License-Identifier: Apache-2.0
 */

import { renderHook } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { useBracketedPaste } from './useBracketedPaste.js';

const ENABLE_BRACKETED_PASTE = '\x1b[?2004h';
const DISABLE_BRACKETED_PASTE = '\x1b[?2004l';

describe('useBracketedPaste', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('restores on unmount and leaves process teardown coordinated', () => {
    const writeSpy = vi.spyOn(process.stdout, 'write').mockReturnValue(true);
    const processOnSpy = vi.spyOn(process, 'on');

    const { unmount } = renderHook(() => useBracketedPaste());

    expect(writeSpy).toHaveBeenCalledWith(ENABLE_BRACKETED_PASTE);
    expect(processOnSpy).not.toHaveBeenCalledWith('exit', expect.any(Function));
    expect(processOnSpy).not.toHaveBeenCalledWith(
      'SIGINT',
      expect.any(Function),
    );
    expect(processOnSpy).not.toHaveBeenCalledWith(
      'SIGTERM',
      expect.any(Function),
    );

    unmount();

    expect(writeSpy).toHaveBeenCalledWith(DISABLE_BRACKETED_PASTE);
  });
});
