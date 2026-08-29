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

/** Mirrors MAX_WORKSPACE_DISPLAY_NAME_LENGTH in the daemon's registration store. */
export const WORKSPACE_DISPLAY_NAME_MAX_LENGTH = 256;

/**
 * Mirrors the daemon's rejection of control characters (code points
 * 0x00–0x1f and 0x7f); a pasted terminal escape would otherwise round-trip
 * to a generic failure on every save.
 */
// eslint-disable-next-line no-control-regex
const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f]/;

export function isWorkspaceDisplayNameValid(name: string): boolean {
  return !CONTROL_CHARACTERS.test(name);
}

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
  const invalid = !isWorkspaceDisplayNameValid(trimmed);
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
          if (busy || unchanged || invalid) return;
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
        <p
          className={styles.confirmDescription}
          role={invalid ? 'alert' : undefined}
        >
          {invalid
            ? t('sidebar.workspaceNameInvalid')
            : t('sidebar.workspaceNameHint')}
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
          <Button type="submit" disabled={busy || unchanged || invalid}>
            {t('common.save')}
          </Button>
        </div>
      </form>
    </DialogShell>
  );
}
