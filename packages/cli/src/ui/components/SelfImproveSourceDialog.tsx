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
  readSelfImproveConfig,
  writeSelfImproveConfig,
  type SelfImproveConfig,
} from '../commands/selfImproveState.js';

const execFileAsync = promisify(execFile);

interface SelfImproveSourceDialogProps {
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

export function SelfImproveSourceDialog({
  config,
  addItem,
  onClose,
}: SelfImproveSourceDialogProps): React.JSX.Element {
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [repoRoot, setRepoRoot] = useState<string | null>(null);
  const [activeIndex, setActiveIndex] = useState(0);
  const [sources, setSources] = useState<SelfImproveConfig['sources']>({
    githubIssues: false,
    githubPrs: false,
    localSignals: false,
  });
  const [userContext, setUserContext] = useState('');

  useEffect(() => {
    let cancelled = false;
    resolveRepoRoot(config)
      .then(async (root) => {
        const stored = await readSelfImproveConfig(root);
        return { root, stored };
      })
      .then((stored) => {
        if (cancelled) return;
        setRepoRoot(stored.root);
        setSources(stored.stored.sources);
        setUserContext(stored.stored.userContext);
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

  const save = useCallback(() => {
    const nextConfig: SelfImproveConfig = {
      version: 1,
      sources,
      userContext,
    };
    if (!repoRoot) {
      setError(t('Repository root is not ready yet.'));
      return;
    }
    writeSelfImproveConfig(repoRoot, nextConfig)
      .then(() => {
        addItem(
          {
            type: 'info',
            text: t('Self-improve source configuration saved.'),
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
  }, [addItem, onClose, repoRoot, sources, userContext]);

  const toggleSource = useCallback((key: SourceKey) => {
    setSources((current) => ({
      ...current,
      [key]: !current[key],
    }));
  }, []);

  useKeypress(
    (key) => {
      if (key.name === 'escape') {
        onClose();
        return;
      }

      if (activeIndex < SOURCE_ROWS.length) {
        if (key.name === 'up' || key.name === 'k') {
          setActiveIndex((current) => Math.max(0, current - 1));
          return;
        }
        if (key.name === 'down' || key.name === 'j' || key.name === 'tab') {
          setActiveIndex((current) =>
            Math.min(SOURCE_ROWS.length, current + 1),
          );
          return;
        }
        if (key.name === 'space' || key.sequence === ' ') {
          toggleSource(SOURCE_ROWS[activeIndex]!.key);
          return;
        }
        if (key.name === 'return') {
          save();
        }
      }
    },
    { isActive: loaded },
  );

  if (!loaded) {
    return (
      <Text color={theme.text.secondary}>
        {t('Loading self-improve sources...')}
      </Text>
    );
  }

  return (
    <Box flexDirection="column" gap={1}>
      <Text bold>{t('Self-improve sources')}</Text>
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
        <Text
          color={
            activeIndex === SOURCE_ROWS.length
              ? theme.status.success
              : theme.text.primary
          }
        >
          {activeIndex === SOURCE_ROWS.length ? '› ' : '  '}
          {t('User context')}
        </Text>
        <TextInput
          value={userContext}
          onChange={setUserContext}
          onSubmit={save}
          onUp={() => setActiveIndex(SOURCE_ROWS.length - 1)}
          onDown={() => setActiveIndex(SOURCE_ROWS.length)}
          placeholder={t('Optional natural-language direction')}
          isActive={activeIndex === SOURCE_ROWS.length}
          inputWidth={80}
        />
      </Box>

      <Text color={theme.text.secondary}>
        {t('Space toggles sources · ↑/↓ moves · Enter saves · Esc cancels')}
      </Text>
    </Box>
  );
}
