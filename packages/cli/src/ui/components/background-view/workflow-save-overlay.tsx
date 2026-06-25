/**
 * @license
 * Copyright 2026 Qwen Team
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * @fileoverview P7b-A3: the "save this run as a reusable workflow" overlay
 * shown inside the `/workflows` detail view. The user names the workflow,
 * toggles project/user scope, and the run's verbatim script is written to
 * `.qwen/workflows/<name>.js`. A name collision prompts for overwrite.
 *
 * Self-contained: it owns a single `useKeypress` (a minimal inline name
 * editor — workflow names are short kebab-case strings, so the full readline
 * machinery of `TextInput` is unnecessary and would fight this overlay for
 * keys). The parent dialog yields all keys to this overlay while it is active.
 */

import type React from 'react';
import { useState } from 'react';
import { Box, Text } from 'ink';
import {
  type Config,
  type SavedWorkflowSource,
  saveWorkflowScript,
  validateWorkflowName,
} from '@qwen-code/qwen-code-core';
import { useKeypress, type Key } from '../../hooks/useKeypress.js';
import { theme } from '../../semantic-colors.js';
import { t } from '../../../i18n/index.js';

interface WorkflowSaveOverlayProps {
  /** The completed run's script source; written verbatim on save. */
  script: string;
  /** Pre-fill the name field (e.g. from the run's `meta.name`). */
  initialName?: string;
  config: Config;
  isActive: boolean;
  /** Closes the overlay; `savedName` is set only on a successful save. */
  onClose: (savedName?: string) => void;
}

type Phase = 'edit' | 'overwrite' | 'saving' | 'saved' | 'error';

export const WorkflowSaveOverlay: React.FC<WorkflowSaveOverlayProps> = ({
  script,
  initialName = '',
  config,
  isActive,
  onClose,
}) => {
  const [name, setName] = useState(initialName);
  const [scope, setScope] = useState<SavedWorkflowSource>('project');
  const [phase, setPhase] = useState<Phase>('edit');
  const [message, setMessage] = useState<string>('');

  // Live (non-blocking) name validation, shown under the field while editing.
  const liveNameError = name.length > 0 ? validateWorkflowName(name) : null;

  const doSave = async (overwrite: boolean) => {
    setPhase('saving');
    try {
      const result = await saveWorkflowScript(config, {
        name,
        scope,
        script,
        overwrite,
      });
      switch (result.status) {
        case 'saved':
          setMessage(result.path);
          setPhase('saved');
          break;
        case 'exists':
          setMessage(result.path);
          setPhase('overwrite');
          break;
        case 'invalid-name':
        case 'empty-script':
          setMessage(result.error);
          setPhase('error');
          break;
        default:
          break;
      }
    } catch (e) {
      setMessage(e instanceof Error ? e.message : String(e));
      setPhase('error');
    }
  };

  useKeypress(
    (key: Key) => {
      if (phase === 'saving') return; // ignore keystrokes mid-write

      if (phase === 'saved') {
        onClose(name); // any key dismisses; tell the parent what was saved
        return;
      }
      if (phase === 'error') {
        setPhase('edit'); // any key returns to editing to fix the name
        setMessage('');
        return;
      }
      if (phase === 'overwrite') {
        if (key.name === 'return' || key.sequence === 'y') {
          void doSave(true);
          return;
        }
        setPhase('edit'); // Esc / n / anything else backs out
        return;
      }

      // phase === 'edit'
      if (key.name === 'escape') {
        onClose();
        return;
      }
      if (key.name === 'return') {
        const err = !name ? 'Workflow name is required.' : validateWorkflowName(name);
        if (err) {
          setMessage(err);
          setPhase('error');
          return;
        }
        void doSave(false);
        return;
      }
      if (key.name === 'tab') {
        setScope((s) => (s === 'project' ? 'user' : 'project'));
        return;
      }
      if (key.name === 'backspace' || key.name === 'delete') {
        setName((n) => n.slice(0, -1));
        return;
      }
      if (key.ctrl && key.name === 'u') {
        setName('');
        return;
      }
      // Printable single char → append. Out-of-range chars are accepted but
      // surface the live validation hint; submission re-validates.
      if (
        !key.ctrl &&
        !key.meta &&
        key.sequence.length === 1 &&
        key.sequence >= ' '
      ) {
        setName((n) => n + key.sequence);
      }
    },
    { isActive },
  );

  return (
    <Box flexDirection="column" marginTop={1} paddingX={1}>
      <Text bold color={theme.text.accent}>
        {t('Save workflow')}
      </Text>

      {phase === 'overwrite' ? (
        <Box flexDirection="column" marginTop={1}>
          <Text color={theme.status.warning}>
            {t('{{name}}.js already exists in {{scope}} scope.', { name, scope })}
          </Text>
          <Text color={theme.text.secondary}>
            {t('Overwrite? Enter / y to confirm · any other key cancels')}
          </Text>
        </Box>
      ) : phase === 'saved' ? (
        <Box flexDirection="column" marginTop={1}>
          <Text color={theme.status.success}>
            {t('Saved to {{path}}', { path: message })}
          </Text>
          <Text color={theme.text.secondary}>
            {t('Available as /{{name}} on the next session · press any key', {
              name,
            })}
          </Text>
        </Box>
      ) : phase === 'error' ? (
        <Box flexDirection="column" marginTop={1}>
          <Text color={theme.status.error}>{message}</Text>
          <Text color={theme.text.secondary}>
            {t('Press any key to edit the name')}
          </Text>
        </Box>
      ) : (
        <Box flexDirection="column" marginTop={1}>
          <Text>
            {t('name')}
            {'  : '}
            {name}
            <Text color={theme.text.accent}>{'█'}</Text>
            {!name && (
              <Text color={theme.text.secondary}>{t('(type a name)')}</Text>
            )}
          </Text>
          <Text>
            {t('scope')}
            {' : '}
            <Text
              bold={scope === 'project'}
              color={
                scope === 'project'
                  ? theme.text.accent
                  : theme.text.secondary
              }
            >
              {t('project')}
            </Text>
            {'   '}
            <Text
              bold={scope === 'user'}
              color={
                scope === 'user' ? theme.text.accent : theme.text.secondary
              }
            >
              {t('user')}
            </Text>
          </Text>
          {liveNameError && (
            <Text color={theme.status.error}>{liveNameError}</Text>
          )}
          <Text color={theme.text.secondary}>
            {t('Enter save · Tab scope · Esc cancel')}
          </Text>
        </Box>
      )}
    </Box>
  );
};
