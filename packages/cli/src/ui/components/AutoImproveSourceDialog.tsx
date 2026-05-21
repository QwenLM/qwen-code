/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

import type React from 'react';
import { useCallback, useEffect, useState } from 'react';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { Box, Text } from 'ink';
import { theme } from '../semantic-colors.js';
import { useKeypress } from '../hooks/useKeypress.js';
import { TextInput } from './shared/TextInput.js';
import { t } from '../../i18n/index.js';
import type { UseHistoryManagerReturn } from '../hooks/useHistoryManager.js';
import type { Config } from '@qwen-code/qwen-code-core';
import {
  readAutoImproveConfig,
  writeAutoImproveConfig,
  type AutoImproveConfig,
} from '../commands/autoImproveState.js';

const execFileAsync = promisify(execFile);

interface AutoImproveSourceDialogProps {
  config: Config;
  addItem: UseHistoryManagerReturn['addItem'];
  onClose: () => void;
}

type SourceKey = 'githubIssues' | 'githubPrs' | 'localSignals';

const SOURCE_ROWS: Array<{ key: SourceKey; label: string }> = [
  { key: 'githubIssues', label: 'GitHub issues' },
  { key: 'githubPrs', label: 'GitHub PRs / CI / review comments' },
  { key: 'localSignals', label: 'Local repo signals' },
];

function getConfiguredRoot(config: Config): string {
  return config.getWorkingDir() || config.getProjectRoot();
}

async function resolveRepoRoot(config: Config): Promise<string> {
  const cwd = getConfiguredRoot(config);
  try {
    const { stdout } = await execFileAsync('git', [
      '-C',
      cwd,
      'rev-parse',
      '--show-toplevel',
    ]);
    return stdout.trim();
  } catch {
    return cwd;
  }
}

function normalizeCustomSources(sources: string[]): string[] {
  const seen = new Set<string>();
  return sources
    .map((source) => source.trim())
    .filter((source) => {
      if (!source || seen.has(source)) return false;
      seen.add(source);
      return true;
    });
}

function applyDraftSource(
  customSources: string[],
  draftSource: string,
  editingIndex: number | null,
): string[] {
  const trimmed = draftSource.trim();
  if (!trimmed) return normalizeCustomSources(customSources);

  const next = [...customSources];
  if (
    editingIndex !== null &&
    editingIndex >= 0 &&
    editingIndex < next.length
  ) {
    next[editingIndex] = trimmed;
  } else {
    next.push(trimmed);
  }
  return normalizeCustomSources(next);
}

export function AutoImproveSourceDialog({
  config,
  addItem,
  onClose,
}: AutoImproveSourceDialogProps): React.JSX.Element {
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [repoRoot, setRepoRoot] = useState<string | null>(null);
  const [activeIndex, setActiveIndex] = useState(0);
  const [sources, setSources] = useState<AutoImproveConfig['sources']>({
    githubIssues: false,
    githubPrs: false,
    localSignals: false,
  });
  const [customSources, setCustomSources] = useState<string[]>([]);
  const [draftSource, setDraftSource] = useState('');
  const [editingIndex, setEditingIndex] = useState<number | null>(null);
  const inputIndex = SOURCE_ROWS.length + customSources.length;
  const saveIndex = inputIndex + 1;

  useEffect(() => {
    let cancelled = false;
    resolveRepoRoot(config)
      .then(async (root) => {
        const stored = await readAutoImproveConfig(root);
        return { root, stored };
      })
      .then((stored) => {
        if (cancelled) return;
        setRepoRoot(stored.root);
        setSources(stored.stored.sources);
        setCustomSources(stored.stored.customSources);
        setLoaded(true);
      })
      .catch((loadError: unknown) => {
        if (cancelled) return;
        setError(
          loadError instanceof Error ? loadError.message : String(loadError),
        );
        setLoaded(true);
      });
    return () => {
      cancelled = true;
    };
  }, [config]);

  useEffect(() => {
    setActiveIndex((current) => Math.min(current, saveIndex));
  }, [saveIndex]);

  const save = useCallback(() => {
    const nextConfig: AutoImproveConfig = {
      version: 1,
      sources,
      customSources: applyDraftSource(customSources, draftSource, editingIndex),
    };
    if (!repoRoot) {
      setError(t('Repository root is not ready yet.'));
      return;
    }
    writeAutoImproveConfig(repoRoot, nextConfig)
      .then(() => {
        addItem(
          {
            type: 'info',
            text: t('Auto-improve source configuration saved.'),
          },
          Date.now(),
        );
        onClose();
      })
      .catch((saveError: unknown) => {
        setError(
          saveError instanceof Error ? saveError.message : String(saveError),
        );
      });
  }, [
    addItem,
    customSources,
    draftSource,
    editingIndex,
    onClose,
    repoRoot,
    sources,
  ]);

  const toggleSource = useCallback((key: SourceKey) => {
    setSources((current) => ({
      ...current,
      [key]: !current[key],
    }));
  }, []);

  const commitDraftSource = useCallback(() => {
    const trimmed = draftSource.trim();
    if (!trimmed) {
      setDraftSource('');
      setEditingIndex(null);
      return;
    }

    setCustomSources((current) =>
      applyDraftSource(current, draftSource, editingIndex),
    );
    setDraftSource('');
    setEditingIndex(null);
  }, [draftSource, editingIndex]);

  const editCustomSource = useCallback(
    (index: number) => {
      setDraftSource(customSources[index] ?? '');
      setEditingIndex(index);
      setActiveIndex(inputIndex);
    },
    [customSources, inputIndex],
  );

  const removeCustomSource = useCallback((index: number) => {
    setCustomSources((current) =>
      current.filter((_, currentIndex) => currentIndex !== index),
    );
    setEditingIndex((current) => {
      if (current === null) return null;
      if (current === index) {
        setDraftSource('');
        return null;
      }
      return current > index ? current - 1 : current;
    });
  }, []);

  useKeypress(
    (key) => {
      if (key.name === 'escape') {
        onClose();
        return;
      }

      if (activeIndex === inputIndex) {
        return;
      }

      if (key.name === 'up' || key.name === 'k') {
        setActiveIndex((current) => Math.max(0, current - 1));
        return;
      }
      if (key.name === 'down' || key.name === 'j' || key.name === 'tab') {
        setActiveIndex((current) => Math.min(saveIndex, current + 1));
        return;
      }

      if (activeIndex < SOURCE_ROWS.length) {
        if (
          key.name === 'space' ||
          key.sequence === ' ' ||
          key.name === 'return'
        ) {
          toggleSource(SOURCE_ROWS[activeIndex]!.key);
        }
        return;
      }

      if (activeIndex < inputIndex) {
        const customSourceIndex = activeIndex - SOURCE_ROWS.length;
        if (key.name === 'return') {
          editCustomSource(customSourceIndex);
          return;
        }
        if (key.name === 'delete' || key.name === 'backspace') {
          removeCustomSource(customSourceIndex);
        }
        return;
      }

      if (activeIndex === saveIndex && key.name === 'return') {
        save();
      }
    },
    { isActive: loaded },
  );

  if (!loaded) {
    return (
      <Text color={theme.text.secondary}>
        {t('Loading auto-improve sources...')}
      </Text>
    );
  }

  return (
    <Box flexDirection="column" gap={1}>
      <Text bold>{t('Auto-improve sources')}</Text>
      {error && <Text color={theme.status.error}>{error}</Text>}

      <Box flexDirection="column">
        {SOURCE_ROWS.map((row, index) => {
          const isActive = activeIndex === index;
          const isChecked = sources[row.key];
          return (
            <Box key={row.key}>
              <Box minWidth={2}>
                <Text
                  color={isActive ? theme.status.success : theme.text.primary}
                >
                  {isActive ? '›' : ' '}
                </Text>
              </Box>
              <Text
                color={
                  isActive
                    ? theme.status.success
                    : isChecked
                      ? theme.text.accent
                      : theme.text.primary
                }
              >
                {isChecked ? '[✓]' : '[ ]'} {row.label}
              </Text>
            </Box>
          );
        })}
      </Box>

      <Box flexDirection="column">
        <Text bold>{t('Custom sources')}</Text>
        {customSources.length === 0 ? (
          <Text color={theme.text.secondary}>{t('  No custom sources')}</Text>
        ) : (
          customSources.map((source, index) => {
            const rowIndex = SOURCE_ROWS.length + index;
            const isActive = activeIndex === rowIndex;
            return (
              <Box key={`${index}-${source}`}>
                <Box minWidth={2}>
                  <Text
                    color={isActive ? theme.status.success : theme.text.primary}
                  >
                    {isActive ? '›' : ' '}
                  </Text>
                </Box>
                <Text
                  color={isActive ? theme.status.success : theme.text.primary}
                >
                  - {source}
                </Text>
              </Box>
            );
          })
        )}
      </Box>

      <Box flexDirection="column">
        <Text color={theme.text.primary}>
          {'  '}
          {editingIndex === null
            ? t('Add custom source')
            : t('Edit custom source')}
        </Text>
        <TextInput
          value={draftSource}
          onChange={setDraftSource}
          onSubmit={commitDraftSource}
          onUp={() =>
            setActiveIndex(
              customSources.length > 0
                ? inputIndex - 1
                : SOURCE_ROWS.length - 1,
            )
          }
          onDown={() => setActiveIndex(saveIndex)}
          placeholder={t('Type a source and press Enter')}
          isActive={activeIndex === inputIndex}
          inputWidth={80}
        />
      </Box>

      <Box>
        <Box minWidth={2}>
          <Text
            color={
              activeIndex === saveIndex
                ? theme.status.success
                : theme.text.primary
            }
          >
            {activeIndex === saveIndex ? '›' : ' '}
          </Text>
        </Box>
        <Text
          color={
            activeIndex === saveIndex
              ? theme.status.success
              : theme.text.primary
          }
        >
          {t('Save changes')}
        </Text>
      </Box>

      <Text color={theme.text.secondary}>
        {t(
          'Space toggles built-ins · Enter adds/edits/saves · Delete removes · Esc cancels',
        )}
      </Text>
    </Box>
  );
}
