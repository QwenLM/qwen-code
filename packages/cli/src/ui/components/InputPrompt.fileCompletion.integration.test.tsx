/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { act } from 'react';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import {
  FileDiscoveryService,
  FileSearchFactory,
  makeFakeConfig,
  runLogger,
} from '@qwen-code/core';
import { renderWithProviders } from '../../test-utils/render.js';
import { waitFor } from '../../test-utils/async.js';
import { useTextBuffer } from './shared/text-buffer.js';
import { InputPrompt } from './InputPrompt.js';
import { InputContext, useInputState } from '../contexts/InputContext.js';
import { StreamingState } from '../types.js';
import type { CommandContext } from '../commands/types.js';
import type { SuggestionsDisplayProps } from './SuggestionsDisplay.js';
import { ripGrepStream } from '../../../../core/src/utils/ripgrep.js';

describe('file completion with real recursive indexing', () => {
  let root: string;

  beforeAll(async () => {
    root = await fs.mkdtemp(path.join(os.tmpdir(), 'qwen-at-completion-'));
    for (let batch = 0; batch < 100; batch++) {
      await Promise.all(
        Array.from({ length: 10 }, async (_, offset) => {
          const index = batch * 10 + offset;
          const dir = path.join(
            root,
            index < 200 ? '.repo/project-objects' : 'cornerstone/platform/rtos',
            `project-${index}`,
          );
          await fs.mkdir(dir, { recursive: true });
          for (let file = 0; file < 100; file++) {
            await fs.writeFile(
              path.join(dir, `file-${file}.c`),
              'int value;\n',
            );
          }
        }),
      );
    }
    await fs.writeFile(path.join(root, 'MTP_draft_verify.md'), '# MTP\n');
  }, 120000);

  afterAll(async () => {
    if (root) await fs.rm(root, { recursive: true, force: true });
  }, 120000);

  it.each([false, true])(
    'completes with Tab in a 100,001-file .repo workspace (broken symlink: %s)',
    async (brokenSymlink) => {
      const brokenLink = path.join(root, '.repo', 'missing-project');
      if (brokenSymlink) await fs.symlink('missing-target', brokenLink);
      const config = makeFakeConfig({ targetDir: root, cwd: root });
      const searcher = FileSearchFactory.create({
        projectRoot: root,
        ignoreDirs: [],
        fileDiscoveryService: new FileDiscoveryService(root),
        cache: false,
        cacheTtl: 0,
        enableRecursiveFileSearch: true,
        enableFuzzySearch: true,
        respectGitIgnore: true,
      });

      await searcher.initialize();
      expect(await searcher.search('MTP')).toContain('MTP_draft_verify.md');
      if (brokenSymlink) {
        expect(runLogger.warn).toHaveBeenCalledWith(
          expect.stringContaining('keeping partial results'),
        );
        expect(runLogger.warn).toHaveBeenCalledWith(
          expect.stringContaining('missing-project'),
        );
      }

      let buffer: ReturnType<typeof useTextBuffer>;
      let footer: SuggestionsDisplayProps | null = null;
      const commands: [] = [];
      const context = {} as CommandContext;
      const onFooter = (value: SuggestionsDisplayProps | null) => {
        footer = value;
      };

      function Composer() {
        const state = useInputState();
        buffer = useTextBuffer({
          initialText: '@MTP',
          initialCursorOffset: 4,
          viewport: { width: 80, height: 20 },
          onChange: () => {},
        });
        return (
          <InputContext.Provider value={{ ...state, buffer }}>
              <InputPrompt
                config={config}
                slashCommands={commands}
                commandContext={context}
                onSubmit={() => {
                  throw new Error('Tab must not submit');
                }}
                onClearScreen={() => {}}
                setShellModeActive={() => {}}
                permissionMode="default"
                setQueueErrorMessage={() => {}}
                streamingState={StreamingState.Idle}
                suggestionsPosition="footer"
                onFooterSuggestionsChange={onFooter}
              />
          </InputContext.Provider>
        );
      }

      const view = await renderWithProviders(<Composer />, { config });
      try {
        await waitFor(
          () =>
            expect(
              footer?.suggestions.some(
                (suggestion) => suggestion.value === 'MTP_draft_verify.md',
              ),
            ).toBe(true),
          { timeout: 20000 },
        );
        await act(async () => {
          view.stdin.write('\t');
        });
        await waitFor(() => expect(buffer!.text).toBe('@MTP_draft_verify.md '));
      } finally {
        await act(async () => {
          view.unmount();
        });
        await fs.rm(brokenLink, { force: true });
      }
    },
    60000,
  );

  it('still rejects a failed scan with no usable paths', async () => {
    const missing = path.join(root, 'missing-directory');
    const results: string[] = [];
    await expect(
      ripGrepStream(
        ['--files', '--follow', '--hidden'],
        missing,
        new AbortController().signal,
        (lines) => results.push(...lines),
      ),
    ).rejects.toThrow('ripgrep exited with code 2');
    expect(results).toEqual([]);
  });
});
