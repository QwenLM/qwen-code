/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

// @vitest-environment jsdom

import { act } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { DaemonChannelTypeDescriptor } from '@qwen-code/sdk/daemon';
import { ChannelEditorDialog } from './ChannelEditorDialog';

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

const catalog: DaemonChannelTypeDescriptor[] = [
  {
    type: 'custom',
    displayName: 'Custom',
    manageable: true,
    auth: ['credentials'],
    fields: [
      { key: 'token', label: 'Token', kind: 'secret', required: true },
      { key: 'enabled', label: 'Enabled', kind: 'boolean' },
    ],
  },
];

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  container = document.createElement('div');
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

describe('ChannelEditorDialog', () => {
  it('keeps save disabled until visible required credentials are valid', async () => {
    await act(async () => {
      root.render(
        <ChannelEditorDialog
          open
          catalog={catalog}
          expectedRevision="revision-1"
          onOpenChange={vi.fn()}
          onSubmit={vi.fn()}
        />,
      );
    });

    const save = Array.from(document.querySelectorAll('button')).find(
      (element) => element.textContent === 'Add channel',
    );
    expect(save).toBeInstanceOf(HTMLButtonElement);
    expect((save as HTMLButtonElement).disabled).toBe(true);
    expect(document.body.textContent).toContain('Enter credential');
    const credentialButton = Array.from(
      document.querySelectorAll('button'),
    ).find((element) => element.textContent?.includes('Enter credential'));
    expect(credentialButton).toBeInstanceOf(HTMLButtonElement);
    act(() => credentialButton!.click());
    expect(
      document.querySelector<HTMLInputElement>('input[type="password"]')?.value,
    ).toBe('');
  });
});
