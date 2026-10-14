/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import * as fs from 'node:fs/promises';
import { mkdtempSync } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { render, useApp } from 'ink';
import { findGitRoot } from '@qwen-code/qwen-code-core/utils/gitUtils.js';
import type { ImportPreview } from '../../commands/memory/codex-import.js';
import type { LoadedSettings } from '../../config/settings.js';
import { writeStderrLine } from '../../utils/stdioHelpers.js';
import { KeypressProvider } from '../contexts/KeypressContext.js';
import { SettingsContext } from '../contexts/SettingsContext.js';
import { useLaunchEditor } from '../hooks/useLaunchEditor.js';
import {
  MemoryImportPreview,
  type MemoryImportResult,
} from './MemoryImportPreview.js';

// Standalone review must not load settings migrations or initialize a session.
const PREVIEW_SETTINGS = {
  merged: { ui: {} },
} as unknown as LoadedSettings;

interface PreviewScreenProps {
  preview: ImportPreview;
  initialSelectedIds?: string[];
  canImport: boolean;
  onFinish: (result: MemoryImportResult | undefined) => void;
  createReviewFile: (text: string) => Promise<string>;
}

function PreviewScreen({
  preview,
  initialSelectedIds,
  canImport,
  onFinish,
  createReviewFile,
}: PreviewScreenProps) {
  const { exit } = useApp();
  const launchEditor = useLaunchEditor();
  return (
    <MemoryImportPreview
      preview={preview}
      initialSelectedIds={initialSelectedIds}
      canImport={canImport}
      onFinish={(ids) => {
        onFinish(ids);
        exit();
      }}
      onOpen={async (text) => {
        await launchEditor(await createReviewFile(text));
      }}
    />
  );
}

export async function showMemoryImportPreview(
  preview: ImportPreview,
  initialSelectedIds?: string[],
  source?: string,
  canImport = false,
): Promise<MemoryImportResult | undefined> {
  const reviewDirectories: string[] = [];
  let result: MemoryImportResult | undefined;
  const wasRaw = process.stdin.isRaw ?? false;
  let instance: ReturnType<typeof render> | undefined;
  try {
    instance = render(
      <KeypressProvider kittyProtocolEnabled={false}>
        <SettingsContext.Provider value={PREVIEW_SETTINGS}>
          <PreviewScreen
            preview={preview}
            initialSelectedIds={initialSelectedIds}
            canImport={canImport}
            onFinish={(selection) => {
              result = selection;
            }}
            createReviewFile={async (text) => {
              const temporaryRoot = await fs.realpath(os.tmpdir());
              const sourceRoot = await fs.realpath(
                source ??
                  path.join(
                    process.env['CODEX_HOME'] ??
                      path.join(os.homedir(), '.codex'),
                    'memories',
                  ),
              );
              const protectedRoots = [
                sourceRoot,
                ...preview.entries.flatMap((entry) =>
                  entry.targetRoot ? [entry.targetRoot] : [],
                ),
              ];
              if (
                findGitRoot(temporaryRoot) ||
                protectedRoots.some((root) => {
                  const relative = path.relative(root, temporaryRoot);
                  return (
                    relative === '' ||
                    (!path.isAbsolute(relative) &&
                      relative !== '..' &&
                      !relative.startsWith(`..${path.sep}`))
                  );
                })
              ) {
                throw new Error(
                  'Choose a system temporary directory outside Git, source, and native memory directories.',
                );
              }
              // Node 22's promise variant can leave an unhandled permission rejection.
              const directory = mkdtempSync(
                path.join(temporaryRoot, 'qwen-memory-review-'),
              );
              reviewDirectories.push(directory);
              await fs.chmod(directory, 0o700);
              const file = path.join(directory, 'review.md');
              await fs.writeFile(file, text, { mode: 0o600, flag: 'wx' });
              return file;
            }}
          />
        </SettingsContext.Provider>
      </KeypressProvider>,
      { exitOnCtrlC: false },
    );
    await instance.waitUntilExit();
    return result;
  } finally {
    instance?.clear();
    instance?.cleanup();
    if (process.stdin.isTTY && process.stdin.isRaw !== wasRaw) {
      process.stdin.setRawMode(wasRaw);
    }
    // GUI editors may return before reading the file. Keep copies until exit.
    for (const directory of reviewDirectories) {
      try {
        await fs.rm(directory, { recursive: true, force: true });
      } catch {
        writeStderrLine(
          'Could not remove a temporary memory review copy; check your system temporary directory.',
        );
      }
    }
  }
}
