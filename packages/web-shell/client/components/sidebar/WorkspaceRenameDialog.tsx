/**
 * @license
 * Copyright 2025 Qwen
 * SPDX-License-Identifier: Apache-2.0
 */

import { useState } from 'react';
import type { DaemonWorkspaceCapability } from '@qwen-code/sdk/daemon';
import { useI18n } from '../../i18n';
import { DialogShell } from '../dialogs/DialogShell';
import { Field, FieldGroup, FieldLabel } from '../ui/field';
import { Button } from '../ui/button';
import { Input } from '../ui/input';
import { workspaceBasename } from '../../utils/workspace';
import styles from './WebShellSidebar.module.css';

export const WORKSPACE_DISPLAY_NAME_MAX_LENGTH = 64;

interface WorkspaceRenameDialogProps {
  workspace: DaemonWorkspaceCapability;
  busy: boolean;
  /** `null` clears the display name so the folder name shows again. */
  onSubmit: (displayName: string | null) => void;
  onClose: () => void;
}

export function WorkspaceRenameDialog({
  workspace,
  busy,
  onSubmit,
  onClose,
}: WorkspaceRenameDialogProps) {
  const { t } = useI18n();
  const [name, setName] = useState(workspace.displayName ?? '');
  const trimmed = name.trim();
  const unchanged = trimmed === (workspace.displayName?.trim() ?? '');
  return (
    <DialogShell
      title={t('sidebar.renameWorkspaceTitle')}
      subtitle={workspace.cwd}
      size="sm"
      onClose={() => {
        if (!busy) onClose();
      }}
    >
      <form
        className={styles.confirmContent}
        onSubmit={(event) => {
          event.preventDefault();
          if (busy || unchanged) return;
          onSubmit(trimmed === '' ? null : trimmed);
        }}
      >
        <FieldGroup>
          <Field>
            <FieldLabel htmlFor="workspace-display-name">
              {t('sidebar.workspaceNamePrompt')}
            </FieldLabel>
            <Input
              id="workspace-display-name"
              value={name}
              autoFocus
              maxLength={WORKSPACE_DISPLAY_NAME_MAX_LENGTH}
              placeholder={workspaceBasename(workspace.cwd)}
              disabled={busy}
              onChange={(event) => setName(event.target.value)}
            />
          </Field>
        </FieldGroup>
        <p className={styles.confirmDescription}>
          {t('sidebar.workspaceNameHint')}
        </p>
        <div className="flex justify-end gap-2">
          <Button
            type="button"
            variant="outline"
            disabled={busy}
            onClick={onClose}
          >
            {t('common.cancel')}
          </Button>
          <Button type="submit" disabled={busy || unchanged}>
            {t('common.save')}
          </Button>
        </div>
      </form>
    </DialogShell>
  );
}
