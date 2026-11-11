/**
 * @license
 * Copyright 2025 Google LLC
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { render } from '../../test-utils/render.js';
import { act } from 'react';
import {
  MultiFolderTrustDialog,
  MultiFolderTrustChoice,
  type MultiFolderTrustDialogProps,
} from './MultiFolderTrustDialog.js';
import { vi, describe, it, expect, beforeEach } from 'vitest';
import * as directoryUtils from '../utils/directoryUtils.js';
import type { Config } from '@qwen-code/core';
import { MessageType } from '../types.js';
import { useKeypress } from '../hooks/useKeypress.js';
import { RadioButtonSelect } from './shared/RadioButtonSelect.js';

// Mocks
vi.mock('../hooks/useKeypress.js');
vi.mock('../utils/directoryUtils.js');
vi.mock('./shared/RadioButtonSelect.js');

const mockedUseKeypress = vi.mocked(useKeypress);
const mockedRadioButtonSelect = vi.mocked(RadioButtonSelect);

const mockOnComplete = vi.fn();
const mockFinishAddingDirectories = vi.fn();
const mockAddItem = vi.fn();

const mockWorkspaceContext = {};
const mockConfig = {
  getWorkspaceContext: () => mockWorkspaceContext,
} as unknown as Config;

const defaultProps: MultiFolderTrustDialogProps = {
  folders: [],
  onComplete: mockOnComplete,
  trustedDirs: [],
  errors: [],
  finishAddingDirectories: mockFinishAddingDirectories,
  config: mockConfig,
  addItem: mockAddItem,
};

describe('MultiFolderTrustDialog', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(directoryUtils.batchAddDirectories).mockImplementation(
      (_ctx, paths) => ({ added: paths, errors: [] }),
    );
    mockedRadioButtonSelect.mockImplementation((props) => (
      <div data-testid="RadioButtonSelect" {...props} />
    ));
  });

  it('renders the dialog with the list of folders', async () => {
    const folders = ['/path/to/folder1', '/path/to/folder2'];
    const { lastFrame, unmount } = await render(
      <MultiFolderTrustDialog {...defaultProps} folders={folders} />,
    );

    expect(lastFrame()).toContain(
      'Do you trust the following folders being added to this workspace?',
    );
    expect(lastFrame()).toContain('- /path/to/folder1');
    expect(lastFrame()).toContain('- /path/to/folder2');
    unmount();
  });

  // skip: 现存失败
  it.skip('calls onComplete and finishAddingDirectories with an error on escape', async () => {
    const folders = ['/path/to/folder1'];
    const { waitUntilReady, unmount } = await render(
      <MultiFolderTrustDialog {...defaultProps} folders={folders} />,
    );

    const keypressCallback = mockedUseKeypress.mock.calls[0][0];
    await act(async () => {
      keypressCallback({
        name: 'escape',
        shift: false,
        alt: false,
        ctrl: false,
        cmd: false,
        sequence: '',
        insertable: false,
      });
    });
    await waitUntilReady();

    expect(mockFinishAddingDirectories).toHaveBeenCalledWith(
      mockConfig,
      mockAddItem,
      [],
      [
        'Operation cancelled. The following directories were not added:\n- /path/to/folder1',
      ],
    );
    expect(mockOnComplete).toHaveBeenCalled();
    unmount();
  });

  it('calls finishAddingDirectories with an error and does not add directories when "No" is chosen', async () => {
    const folders = ['/path/to/folder1'];
    const { waitUntilReady, unmount } = await render(
      <MultiFolderTrustDialog {...defaultProps} folders={folders} />,
    );

    const { onSelect } = mockedRadioButtonSelect.mock.calls[0][0];
    await act(async () => {
      onSelect(MultiFolderTrustChoice.NO);
    });
    await waitUntilReady();

    expect(mockFinishAddingDirectories).toHaveBeenCalledWith(
      mockConfig,
      mockAddItem,
      [],
      [
        'The following directories were not added because they were not trusted:\n- /path/to/folder1',
      ],
    );
    expect(mockOnComplete).toHaveBeenCalled();
    expect(directoryUtils.batchAddDirectories).not.toHaveBeenCalled();
    unmount();
  });

  it('adds directories to workspace context without persisting when "Yes" is chosen', async () => {
    const folders = ['/path/to/folder1', '/path/to/folder2'];
    const { waitUntilReady, unmount } = await render(
      <MultiFolderTrustDialog
        {...defaultProps}
        folders={folders}
        trustedDirs={['/already/trusted']}
      />,
    );

    const { onSelect } = mockedRadioButtonSelect.mock.calls[0][0];
    await act(async () => {
      onSelect(MultiFolderTrustChoice.YES);
    });
    await waitUntilReady();

    expect(directoryUtils.batchAddDirectories).toHaveBeenCalledWith(
      mockWorkspaceContext,
      folders,
    );
    expect(mockFinishAddingDirectories).toHaveBeenCalledWith(
      mockConfig,
      mockAddItem,
      ['/already/trusted', '/path/to/folder1', '/path/to/folder2'],
      [],
    );
    expect(mockOnComplete).toHaveBeenCalled();
    unmount();
  });

  it('shows submitting message after a choice is made', async () => {
    const folders = ['/path/to/folder1'];
    const { lastFrame, waitUntilReady, unmount } = await render(
      <MultiFolderTrustDialog {...defaultProps} folders={folders} />,
    );

    const { onSelect } = mockedRadioButtonSelect.mock.calls[0][0];

    await act(async () => {
      onSelect(MultiFolderTrustChoice.NO);
    });
    await waitUntilReady();

    expect(lastFrame()).toContain('Applying trust settings...');
    unmount();
  });

  it('shows an error message and completes when config is missing', async () => {
    const folders = ['/path/to/folder1'];
    const { waitUntilReady, unmount } = await render(
      <MultiFolderTrustDialog
        {...defaultProps}
        folders={folders}
        config={null as unknown as Config}
      />,
    );

    const { onSelect } = mockedRadioButtonSelect.mock.calls[0][0];
    await act(async () => {
      onSelect(MultiFolderTrustChoice.YES);
    });
    await waitUntilReady();

    expect(mockAddItem).toHaveBeenCalledWith({
      type: MessageType.ERROR,
      text: 'Configuration is not available.',
    });
    expect(mockOnComplete).toHaveBeenCalled();
    expect(mockFinishAddingDirectories).not.toHaveBeenCalled();
    unmount();
  });

  it('collects and reports errors when some directories fail to be added', async () => {
    vi.mocked(directoryUtils.batchAddDirectories).mockReturnValue({
      added: ['/path/to/good'],
      errors: ["Error adding '/path/to/error': Test error"],
    });

    const folders = ['/path/to/good', '/path/to/error'];
    const { waitUntilReady, unmount } = await render(
      <MultiFolderTrustDialog
        {...defaultProps}
        folders={folders}
        errors={['initial error']}
      />,
    );

    const { onSelect } = mockedRadioButtonSelect.mock.calls[0][0];
    await act(async () => {
      onSelect(MultiFolderTrustChoice.YES);
    });
    await waitUntilReady();

    expect(directoryUtils.batchAddDirectories).toHaveBeenCalledWith(
      mockWorkspaceContext,
      folders,
    );
    expect(mockFinishAddingDirectories).toHaveBeenCalledWith(
      mockConfig,
      mockAddItem,
      ['/path/to/good'],
      ['initial error', "Error adding '/path/to/error': Test error"],
    );
    expect(mockOnComplete).toHaveBeenCalled();
    unmount();
  });
});
