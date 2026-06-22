/**
 * @license
 * Copyright 2025 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it, vi } from 'vitest';
import { ChatProviderRegistry } from './ChatProviderRegistry.js';

describe('ChatProviderRegistry', () => {
  it('tracks editor and view providers separately while exposing a combined list', () => {
    const factory = vi
      .fn()
      .mockReturnValueOnce({ dispose: vi.fn(), kind: 'editor-1' })
      .mockReturnValueOnce({ dispose: vi.fn(), kind: 'view-1' })
      .mockReturnValueOnce({ dispose: vi.fn(), kind: 'editor-2' });

    const registry = new ChatProviderRegistry(factory);

    const editor1 = registry.createEditorProvider();
    const view1 = registry.createViewProvider();
    const editor2 = registry.createEditorProvider();

    expect(factory).toHaveBeenCalledTimes(3);
    expect(registry.getEditorProviders()).toEqual([editor1, editor2]);
    expect(registry.getPermissionAwareProviders()).toEqual([
      editor1,
      editor2,
      view1,
    ]);
  });

  it('disposes all tracked providers and resets internal collections', () => {
    const editorDispose = vi.fn();
    const viewDispose = vi.fn();
    const registry = new ChatProviderRegistry(() => ({ dispose: vi.fn() }));

    registry.createEditorProvider({ dispose: editorDispose });
    registry.createViewProvider({ dispose: viewDispose });

    registry.disposeAll();

    expect(editorDispose).toHaveBeenCalledTimes(1);
    expect(viewDispose).toHaveBeenCalledTimes(1);
    expect(registry.getEditorProviders()).toEqual([]);
    expect(registry.getPermissionAwareProviders()).toEqual([]);
  });
});
